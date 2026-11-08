import { createContext, runInContext } from "node:vm";
import { installFrameworkBootstrap } from "./framework-bootstrap.js";
import { getFrameworkObservation, type FrameworkObservation } from "./framework-page.js";
import { record } from "./protocol.js";

// Execute the actual bootstrap/accessor in an isolated CPU realm. This is not a browser or Vitest runner.
export async function reportingPage(
  run: string,
  token: string,
  post: (url: string, init: RequestInit) => Promise<Response>,
  use: (page: {
    observation: FrameworkObservation;
    snapshot: () => {
      pending: number;
      ackedThrough: number;
      contentClosed: boolean;
      failure: string | null;
    };
    pagehide: () => void;
    cutoff: (watermark: number) => boolean;
  }) => Promise<void>,
  release: () => void = () => {},
): Promise<void> {
  const build = await Bun.build({
    entrypoints: [new URL("./reporting-realm.ts", import.meta.url).pathname],
    format: "iife",
    target: "browser",
  });
  if (!build.success || !build.outputs[0]) throw new Error("CPU bootstrap build failed");
  const timers = new Set<ReturnType<typeof setInterval>>();
  const hide = new Set<() => void>();
  const retirement = Promise.withResolvers<Response>();
  const document = {};
  const requests = new Set<Promise<Response>>();
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const request = url.startsWith("/retire") ? retirement.promise : post(url, init);
    requests.add(request);
    void request.finally(() => requests.delete(request)).catch(() => {});
    return request;
  };
  const bridgeHolder: Pick<Window, "__waffleFramework"> = {};
  const page = Object.assign(bridgeHolder, {
    performance,
    crypto,
    AbortController,
    AbortSignal,
    TextEncoder,
    Promise,
    document,
    location: { href: "http://fixture/tester" },
    fetch,
    setTimeout,
    clearTimeout,
    setInterval(callback: () => void, ms: number) {
      const timer = setInterval(callback, ms);
      timers.add(timer);
      return timer;
    },
    clearInterval(timer: ReturnType<typeof setInterval>) {
      timers.delete(timer);
      clearInterval(timer);
    },
    addEventListener(name: string, listener: () => void) {
      if (name === "pagehide") hide.add(listener);
    },
    removeEventListener(name: string, listener: () => void) {
      if (name === "pagehide") hide.delete(listener);
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    install: installFrameworkBootstrap,
    accessor: getFrameworkObservation,
  });
  const context = createContext(page);
  context.window = page;
  try {
    runInContext(await build.outputs[0].text(), context);
    page.install({ run, token, kind: "tester", url: page.location.href });
    const observation = page.accessor();
    const bridge = page.__waffleFramework;
    if (!observation || !bridge) throw new Error("Actual bootstrap/accessor not installed");
    await use({
      observation,
      snapshot: bridge.snapshot,
      cutoff: bridge.cutoff,
      pagehide: () => {
        for (const listener of hide) listener();
      },
    });
  } finally {
    release();
    for (const listener of hide) listener();
    retirement.resolve(Response.json({ kind: "cancelled" }));
    for (const timer of timers) clearInterval(timer);
    await Promise.allSettled(Array.from(requests));
    await waitUntil(() => (page.__waffleFramework?.snapshot().pending ?? 0) === 0);
  }
}
export async function waitUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error("CPU fixture did not reach its asserted boundary");
}
export function reportBody(init: RequestInit): Record<string, unknown> {
  const body: unknown = JSON.parse(String(init.body));
  if (!record(body)) throw new Error("Missing report body");
  return body;
}
