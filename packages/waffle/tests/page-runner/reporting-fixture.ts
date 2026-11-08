import { createContext, runInContext } from "node:vm";
import { installFrameworkBootstrap } from "./framework-bootstrap.js";
import { getFrameworkObservation } from "./framework-page.js";
import type { FrameworkObservation } from "./framework-page.js";
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
  }) => Promise<void>,
): Promise<void> {
  const build = await Bun.build({
    entrypoints: [import.meta.dir + "/reporting-realm.ts"],
    format: "iife",
    target: "browser",
  });
  if (!build.success || !build.outputs[0]) throw new Error("CPU bootstrap build failed");
  const timers = new Set<ReturnType<typeof setInterval>>();
  const hide = new Set<() => void>();
  const retirement = Promise.withResolvers<Response>();
  const document = {};
  const page = {
    performance,
    crypto,
    AbortController,
    AbortSignal,
    TextEncoder,
    Promise,
    document,
    location: { href: "http://fixture/tester" },
    fetch: (url: string, init: RequestInit) =>
      url.startsWith("/retire") ? retirement.promise : post(url, init),
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
    __waffleFramework: undefined as Window["__waffleFramework"],
  };
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
      pagehide: () => {
        for (const listener of hide) listener();
      },
    });
  } finally {
    for (const listener of hide) listener();
    retirement.resolve(Response.json({ kind: "cancelled" }));
    for (const timer of timers) clearInterval(timer);
    await Promise.resolve();
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
