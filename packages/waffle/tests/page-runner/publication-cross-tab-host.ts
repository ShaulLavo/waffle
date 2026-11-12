import type {
  CrossTabBrowser,
  CrossTabContext,
  CrossTabLifecycle,
  CrossTabPage,
} from "../publication-cross-tab-host.js";
import { record, type HostCase, type HostPeer, type HostWorker } from "./protocol.js";
import { installWorkspaceChannelObserver } from "../fixtures/publication-channel-observer.js";
import { encodeCrossTabValue, decodeCrossTabValue } from "./cross-tab-value.js";

import {
  diagnosticsFor,
  evaluationOperation,
  evaluationMode,
  collectDiagnostic,
  type Purpose,
} from "./stall-diagnostics.js";

export type CrossTabWorkerEvent = { peer: number; worker: number; kind: string; url: string };

function nativePage(
  peer: HostPeer,
  host: HostCase,
  events: CrossTabWorkerEvent[],
  index: number,
): CrossTabPage {
  const binding = diagnosticsFor(peer);
  const diagnostics = binding?.diagnostics;
  const facts = { peer: binding?.peer ?? index, generation: binding?.generation ?? 0 };
  let sequence = 0;
  async function reply(source: string, purpose: Purpose): Promise<unknown> {
    const value = await peer.script(source, purpose);
    if (!record(value) || !("answer" in value))
      throw new Error("Missing evaluator diagnostic envelope");
    collectDiagnostic(
      () => diagnostics?.page(facts.peer, value.diagnostics),
      () => diagnostics?.missing(),
    );
    return value.answer;
  }
  const workers: HostWorker[] = [];
  const remove = peer.onWorker((event) => {
    if (event.kind === "created") workers.push(event.worker);
    const worker = workers.indexOf(event.worker);
    if (worker < 0) throw new Error("Cross-tab Worker closed before creation");
    events.push({ peer: index, worker, kind: event.kind, url: event.worker.url });
  });
  const task = peer.task("await window.__crossTabEvaluator.run();");
  let failure: { error: unknown } | undefined;
  void task.catch((error: unknown) => {
    failure = { error };
  });
  let closing: Promise<void> | undefined;
  async function evaluate<R, A = undefined>(
    body: (arg: A) => R | Promise<R>,
    arg?: A,
    until = Infinity,
  ): Promise<R> {
    const id = crypto.randomUUID();
    const job = ++sequence;
    const ordinal = diagnostics?.evaluations.begin("queued", {
      ...facts,
      job,
      operation: evaluationOperation(arg),
      mode: evaluationMode(arg),
    });
    try {
      await reply(
        `window.__crossTabEvaluator.submit(${JSON.stringify({
          id,
          job,
          operation: evaluationOperation(arg),
          mode: evaluationMode(arg),
          source: `return (${body.toString()})(value);`,
          value: encodeCrossTabValue(arg),
        })}); return window.__crossTabEvaluator.reply(null);`,
        "evaluator-submit",
      );
      if (ordinal !== undefined) diagnostics?.evaluations.mark(ordinal, "submitted");
      return await poll<R>(id, ordinal, until);
    } catch (error) {
      diagnostics?.freeze("evaluation-failure");
      if (ordinal !== undefined) diagnostics?.evaluations.end(ordinal, "failed");
      throw error;
    }
  }
  async function poll<R>(id: string, ordinal: number | undefined, until: number): Promise<R> {
    let polls = 0;
    for (;;) {
      if (performance.now() >= until)
        throw new Error("Cross-tab waitForFunction timed out after 30000ms");
      if (failure) throw failure.error;
      const answer = await reply(
        `return window.__crossTabEvaluator.reply(window.__crossTabEvaluator.take(${JSON.stringify(id)}));`,
        "evaluator-take",
      );
      polls++;
      if (ordinal !== undefined)
        diagnostics?.evaluations.mark(
          ordinal,
          answer === null
            ? "poll-pending"
            : record(answer) && answer.status === "pass"
              ? "poll-pass"
              : "poll-fail",
          { polls },
        );
      if (record(answer) && answer.status === "fail") throw new Error(String(answer.error));
      if (record(answer) && answer.status === "pass") {
        if (ordinal !== undefined) diagnostics?.evaluations.end(ordinal, "completed");
        return decodeCrossTabValue(answer.value) as R;
      }
      if (answer !== null) throw new Error("Malformed cross-tab evaluation result");
      await host.sleep(10);
    }
  }
  async function close(): Promise<void> {
    const ordinal = diagnostics?.lifecycle.begin("stop-requested", {
      ...facts,
      context: diagnostics.context,
    });
    await reply(
      "window.__crossTabEvaluator.stop(); return window.__crossTabEvaluator.reply(null);",
      "evaluator-stop",
    );
    await task;
    if (ordinal !== undefined) diagnostics?.lifecycle.mark(ordinal, "task-joined");
    const state = await reply(
      "return window.__crossTabEvaluator.reply(window.__crossTabEvaluator.state());",
      "evaluator-state",
    );
    if (ordinal !== undefined) diagnostics?.lifecycle.mark(ordinal, "state-checked");
    if (!record(state) || state.queued !== 0 || state.pending !== 0 || state.unread !== 0)
      throw new Error("Cross-tab evaluations did not join before peer close");
    try {
      await peer.close();
      if (ordinal !== undefined) diagnostics?.lifecycle.mark(ordinal, "worker-receipts-joined");
    } finally {
      await remove();
      if (ordinal !== undefined) diagnostics?.lifecycle.end(ordinal, "listener-removal-joined");
    }
  }
  return {
    evaluate,
    async waitForFunction(body, arg) {
      const until = performance.now() + 30_000;
      while (!(await evaluate(body, arg, until))) await host.sleep(16);
    },
    async addInitScript(body) {
      if (body !== installWorkspaceChannelObserver)
        throw new Error("Unsupported cross-tab bootstrap");
      if (!(await peer.script("return !!globalThis.__workspaceChannelCounts;")))
        throw new Error("Workspace channel observer missing before fixture import");
    },
    async observeDeaths() {
      if (
        !(await peer.script("return typeof globalThis.__publicationWaitForClose === 'function';"))
      )
        throw new Error("Native Worker close bridge missing before fixture import");
    },
    async navigate(origin) {
      if ((await peer.script("return location.origin;")) !== origin)
        throw new Error("Wrong cross-tab peer origin");
    },
    close: () => (closing ??= close()),
  };
}

export function nativeCrossTabLifecycle(
  host: HostCase,
  events: CrossTabWorkerEvent[],
): CrossTabLifecycle {
  const contexts: CrossTabContext[] = [];
  let index = 0;
  const browser: CrossTabBrowser = {
    version: () => "page-runner driver",
    async newContext() {
      const pages: CrossTabPage[] = [];
      const context: CrossTabContext = {
        async newPage() {
          const page = nativePage(await host.openPeer(), host, events, index++);
          pages.push(page);
          return page;
        },
        async close() {
          const results = await Promise.allSettled(pages.map((page) => page.close()));
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length) throw new AggregateError(errors, "Cross-tab context cleanup failed");
        },
      };
      contexts.push(context);
      return context;
    },
  };
  return {
    async launch(name) {
      if (name !== "ios-safari") throw new Error(`Unknown native cross-tab engine ${name}`);
      return browser;
    },
    async closeBrowser() {
      diagnosticsFor(host)?.diagnostics.cleanup();
      const results = await Promise.allSettled(contexts.map((context) => context.close()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Cross-tab browser cleanup failed");
    },
  };
}
