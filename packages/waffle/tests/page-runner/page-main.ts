import { runPeerPage, runHostPage, type HostPageRun } from "./host-page.js";
import { Reporter } from "./reporter.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { ownedServiceWorker, bindFinishAttempts, type PageContext, type WorkerAttempt } from "./service-worker-page.js";
import { type Body } from "./protocol.js";
import type { ServiceWorkerEntry, StorageEntry } from "../storage-allocation.js";

export type Configuration<R> = {
  run: string;
  token: string;
  group: string;
  ledger: StorageEntry[];
  serviceWorker?: ServiceWorkerEntry;
  registrationAttempts?: WorkerAttempt[];
  fixturePaths?: string[];
} & (
  | { role: "list" | "finish" }
  | {
      role: "peer";
      caseId: string;
      request: R;
      peer: string;
      generation: number;
      execution: "host";
    }
  | { role: "case"; caseId: string; request: R; execution?: "host"; teardownMs?: number }
);
export type PageSuite<R> = {
  list(): Promise<unknown>;
  run:
    | ((request: R, allocate: (entry: StorageEntry) => Promise<void>, context: PageContext) => Promise<unknown>)
    | HostPageRun<R>;
  finish(ledger: readonly StorageEntry[]): Promise<StorageEntry[]>;
};
function resultSnapshot(value: unknown): unknown {
  const encoded = jsonSnapshot(value);
  return JSON.parse(encoded);
}
async function runCase<R>(
  config: Extract<Configuration<R>, { role: "case" }>,
  suite: PageSuite<R>,
  reporter: Reporter,
): Promise<void> {
  if (config.execution === "host") {
    if (typeof suite.run === "function") throw new Error("Host case requires host page handler");
    return runHostPage(config, suite.run, reporter, resultSnapshot);
  }
  if (typeof suite.run !== "function") throw new Error("Page case requires page run handler");
  const caseId = config.caseId;
  await reporter.send({ kind: "case-start", caseId });
  let outcome: Body;
  try {
    const context: PageContext = {
      serviceWorker: config.serviceWorker ? ownedServiceWorker(config.serviceWorker, reporter) : null,
      async fetchFixture(path) {
        if (!config.fixturePaths?.includes(path) || reporter.observation.retired)
          throw new Error("Undeclared fixture path or retired document");
        return reporter.post(path, { headers: { "X-Waffle-Fixture": config.token, "X-Waffle-Document": reporter.observation.doc } });
      },
    };
    const returned = await suite.run(config.request, (entry) => reporter.send({ kind: "allocation", entry }), context);
    outcome = { kind: "case-end", caseId, status: "pass", result: resultSnapshot(returned) };
  } catch (error) {
    outcome = { kind: "case-end", caseId, status: "fail", error: String(error).slice(0, 16_384) };
  }
  await reporter.send(outcome);
}
async function runPage<R>(
  config: Configuration<R>,
  suite: PageSuite<R>,
  reporter: Reporter,
): Promise<void> {
  await reporter.send({ kind: "hello", token: config.token, group: config.group });
  reporter.startHeartbeat();
  switch (config.role) {
    case "list":
      await reporter.send({ kind: "list", cases: await suite.list() });
      break;
    case "case":
      await runCase(config, suite, reporter);
      break;
    case "peer":
      if (typeof suite.run === "function") throw new Error("Peer requires host page handler");
      return runPeerPage(config, suite.run, reporter);
    case "finish":
      bindFinishAttempts(config.registrationAttempts ?? []);
      await reporter.send({ kind: "run-complete", remaining: await suite.finish(config.ledger) });
      break;
  }
  await reporter.send({ kind: "doc-complete" });
  await reporter.readyForRetirement();
}
declare global {
  interface Window {
    __suiteConfiguration: Configuration<unknown>;
  }
}
export function isHostedPage(): boolean {
  return typeof window !== "undefined" && window.__suiteConfiguration !== undefined;
}
export function startPage<R>(suite: PageSuite<R>): void {
  // The host serializes its typed request into this document, never a driver script argument.
  const config = window.__suiteConfiguration as Configuration<R>;
  const reporter = new Reporter(config.run);
  function pageError(message: string): void {
    if (reporter.observation.retired) return;
    void reporter.send({ kind: "error", message }).catch(() => {});
  }
  window.addEventListener("pagehide", () => { reporter.observation.retired = true; reporter.stop(); });
  window.addEventListener("error", (event) => pageError(event.message));
  window.addEventListener("unhandledrejection", (event) => pageError(String(event.reason)));
  void runPage(config, suite, reporter).catch((error: unknown) => pageError(String(error)));
}
