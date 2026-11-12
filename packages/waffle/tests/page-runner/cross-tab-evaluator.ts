import { encodeCrossTabValue, decodeCrossTabValue } from "./cross-tab-value.js";
export type Evaluation = { id: string; source: string; value: unknown };
type Answer = { status: "pass"; value: unknown } | { status: "fail"; error: string };

export function crossTabEvaluator() {
  const queued: Evaluation[] = [];
  const pending = new Set<Promise<void>>();
  const answers = new Map<string, Answer>();
  let accepting = true;
  let running = false;
  let wake: (() => void) | undefined;
  function submit(job: Evaluation): void {
    if (!accepting) throw new Error("Cross-tab evaluator stopped");
    queued.push(job);
    wake?.();
  }
  async function evaluate(job: Evaluation): Promise<void> {
    try {
      const value: unknown = await new Function("value", job.source)(
        decodeCrossTabValue(job.value),
      );
      answers.set(job.id, { status: "pass", value: encodeCrossTabValue(value) });
    } catch (error) {
      answers.set(job.id, { status: "fail", error: String(error) });
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
  };
}

declare global {
  interface Window {
    __crossTabEvaluator: ReturnType<typeof crossTabEvaluator>;
  }
}
