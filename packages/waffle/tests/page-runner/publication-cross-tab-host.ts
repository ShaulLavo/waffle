import type {
  CrossTabBrowser,
  CrossTabContext,
  CrossTabLifecycle,
  CrossTabPage,
} from "../publication-cross-tab-host.js";
import { record, type HostCase, type HostPeer, type HostWorker } from "./protocol.js";
import { installWorkspaceChannelObserver } from "../fixtures/publication-channel-observer.js";
import { encodeCrossTabValue, decodeCrossTabValue } from "./cross-tab-value.js";

export type CrossTabWorkerEvent = { peer: number; worker: number; kind: string; url: string };

function nativePage(
  peer: HostPeer,
  host: HostCase,
  events: CrossTabWorkerEvent[],
  index: number,
): CrossTabPage {
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
    await peer.script(
      `window.__crossTabEvaluator.submit(${JSON.stringify({
        id,
        source: `return (${body.toString()})(value);`,
        value: encodeCrossTabValue(arg),
      })});`,
    );
    for (;;) {
      if (performance.now() >= until)
        throw new Error("Cross-tab waitForFunction timed out after 30000ms");
      if (failure) throw failure.error;
      const answer = await peer.script(
        `return window.__crossTabEvaluator.take(${JSON.stringify(id)});`,
      );
      if (record(answer) && answer.status === "fail") throw new Error(String(answer.error));
      if (record(answer) && answer.status === "pass") return decodeCrossTabValue(answer.value) as R;
      if (answer !== null) throw new Error("Malformed cross-tab evaluation result");
      await host.sleep(10);
    }
  }
  async function close(): Promise<void> {
    await peer.script("window.__crossTabEvaluator.stop();");
    await task;
    const state = await peer.script("return window.__crossTabEvaluator.state();");
    if (!record(state) || state.queued !== 0 || state.pending !== 0 || state.unread !== 0)
      throw new Error("Cross-tab evaluations did not join before peer close");
    try {
      await peer.close();
    } finally {
      await remove();
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
      const results = await Promise.allSettled(contexts.map((context) => context.close()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Cross-tab browser cleanup failed");
    },
  };
}
