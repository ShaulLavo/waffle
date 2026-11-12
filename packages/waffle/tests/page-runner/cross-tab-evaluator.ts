import { encodeCrossTabValue, decodeCrossTabValue } from "./cross-tab-value.js";
import { BoundedTrace, evaluationOperation, evaluationMode } from "./stall-diagnostics.js";
export type Evaluation = {
  id: string;
  source: string;
  value: unknown;
  job?: number;
  operation?: string;
  mode?: "wasi" | "proc" | null;
};
type Answer = { status: "pass"; value: unknown } | { status: "fail"; error: string };

export function crossTabEvaluator() {
  const queued: Evaluation[] = [];
  const pending = new Set<Promise<void>>();
  const answers = new Map<string, Answer>();
  let accepting = true;
  let running = false;
  let wake: (() => void) | undefined;
  const trace = new BoundedTrace("page-monotonic-ms");
  const descriptors = new Map<string, number>();
  const active = new Set<number>();
  let activeCount = 0;
  function submit(job: Evaluation): void {
    if (!accepting) throw new Error("Cross-tab evaluator stopped");
    queued.push(job);
    const ordinal = trace.begin("queued", {
      job: job.job,
      operation: evaluationOperation(job),
      mode: evaluationMode({ value: job }),
    });
    if (descriptors.size < 64) descriptors.set(job.id, ordinal);
    wake?.();
  }
  async function evaluate(job: Evaluation): Promise<void> {
    const ordinal = descriptors.get(job.id);
    if (ordinal !== undefined) trace.mark(ordinal, "started");
    activeCount++;
    if (job.job !== undefined && active.size < 64) active.add(job.job);
    try {
      const value: unknown = await new Function("value", job.source)(
        decodeCrossTabValue(job.value),
      );
      answers.set(job.id, { status: "pass", value: encodeCrossTabValue(value) });
      if (ordinal !== undefined) trace.mark(ordinal, "resolved");
    } catch (error) {
      answers.set(job.id, { status: "fail", error: String(error) });
      if (ordinal !== undefined) trace.mark(ordinal, "rejected");
    } finally {
      activeCount--;
      if (job.job !== undefined) active.delete(job.job);
      if (ordinal !== undefined) trace.mark(ordinal, "answer-stored");
    }
  }
  function dispatch(job: Evaluation): void {
    const work = evaluate(job);
    pending.add(work);
    void work.finally(() => {
      pending.delete(work);
      wake?.();
    });
  }
  async function run(): Promise<void> {
    if (running) throw new Error("Cross-tab evaluator already running");
    running = true;
    while (accepting || queued.length || pending.size) {
      while (queued.length) dispatch(queued.shift()!);
      if (!accepting && !pending.size) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    submit,
    run,
    take(id: string): Answer | null {
      const answer = answers.get(id);
      if (!answer) return null;
      answers.delete(id);
      const ordinal = descriptors.get(id);
      if (ordinal !== undefined) trace.end(ordinal, "answer-consumed");
      descriptors.delete(id);
      return answer;
    },
    stop() {
      accepting = false;
      wake?.();
    },
    state: () => ({
      accepting,
      queued: queued.length,
      pending: pending.size,
      unread: answers.size,
    }),
    activeJobs: () => Array.from(active),
    activeCount: () => activeCount,
    diagnostics: () => trace.snapshot(),
    reply(answer: unknown) {
      const evaluation = trace.snapshot();
      const bridge = window.__crossTabBridgeTrace?.snapshot();
      const allEntries = evaluation.active.concat(
        bridge?.active ?? [],
        evaluation.completed,
        bridge?.completed ?? [],
      );
      const entries = allEntries.slice(0, 96);
      let truncated =
        evaluation.truncated +
        (bridge?.truncated ?? 0) +
        Math.max(0, allEntries.length - entries.length);
      while (JSON.stringify(entries).length > 48 * 1024) {
        entries.pop();
        truncated++;
      }
      return {
        answer,
        diagnostics: {
          clock: "page-monotonic-ms",
          entries,
          truncated,
          total: evaluation.total,
          totals: evaluation.totals,
          bridgeTotal: bridge?.total ?? 0,
          state: {
            accepting,
            queued: queued.length,
            pending: pending.size,
            unread: answers.size,
            active: activeCount,
          },
        },
      };
    },
  };
}

declare global {
  interface Window {
    __crossTabEvaluator: ReturnType<typeof crossTabEvaluator>;
    __crossTabBridgeTrace?: BoundedTrace;
  }
}
