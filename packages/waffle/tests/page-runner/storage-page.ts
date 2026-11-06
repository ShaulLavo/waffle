import { Reporter } from "./reporter.js";
import { storageCase, type WorkerRequest } from "./storage-worker.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { validateWorkerLabel, type Body } from "./protocol.js";
import type { StorageEntry } from "../storage-allocation.js";
type Configuration = {
  run: string;
  token: string;
  group: string;
  request: WorkerRequest | null;
  ledger: StorageEntry[];
};
declare global {
  interface Window {
    __storageConfiguration: Configuration;
  }
}
async function runPage(config: Configuration, reporter: Reporter): Promise<void> {
  await reporter.send({ kind: "hello", token: config.token, group: config.group });
  reporter.startHeartbeat();
  if (config.request?.kind === "list") {
    const cases = await storageCase<Record<"indexeddb" | "opfs", string[]>>(config.request);
    await reporter.send({ kind: "list", cases });
  } else if (config.request?.kind === "run") await runCase(config.request, reporter);
  else
    await reporter.send({ kind: "run-complete", remaining: await cleanupStorage(config.ledger) });
  await reporter.send({ kind: "doc-complete" });
  await reporter.readyForRetirement();
}
async function runCase(
  request: Extract<WorkerRequest, { kind: "run" }>,
  reporter: Reporter,
): Promise<void> {
  const caseId = `${request.backend}: ${request.label}`;
  await reporter.send({ kind: "case-start", caseId });
  let outcome: Body = { kind: "case-end", caseId, status: "pass" };
  try {
    const returned = await storageCase<unknown>(request, (entry) =>
      reporter.send({ kind: "allocation", entry }),
    );
    validateWorkerLabel(returned, request.label);
  } catch (error) {
    outcome = { kind: "case-end", caseId, status: "fail", error: String(error) };
  }
  await reporter.send(outcome);
}
const reporter = new Reporter(window.__storageConfiguration.run);
function pageError(message: string): void {
  if (reporter.observation.retired) return;
  void reporter.send({ kind: "error", message }).catch(() => {});
}
window.addEventListener("error", (event) => pageError(event.message));
window.addEventListener("unhandledrejection", (event) => pageError(String(event.reason)));
void runPage(window.__storageConfiguration, reporter).catch((error: unknown) =>
  pageError(String(error)),
);
