import { Reporter } from "./reporter.js";
import { storageTests, opfsStorageTests } from "../storage-browser.js";
import { validateWorkerLabel } from "./protocol.js";
import { storageCase, type WorkerRequest } from "./storage-worker.js";
import type { Configuration } from "./page-main.js";
declare const PAGE_RUNNER_CONTROL: string;
const mode = PAGE_RUNNER_CONTROL;
const config = window.__suiteConfiguration as Configuration<WorkerRequest>;
const post = async (input: string, init: RequestInit) => {
  const response = await fetch(input, init);
  if (mode === "final-ack-loss" && String(init.body).includes('"kind":"run-complete"'))
    throw new Error("Injected final acknowledgement loss");
  return response;
};
const reporter = new Reporter(config.run, post, 200);
function unsettled(): Promise<never> {
  return new Promise(() => {});
}
async function run(): Promise<void> {
  await reporter.send({ kind: "hello", token: config.token, group: config.group });
  if (mode !== "heartbeat-lost") reporter.startHeartbeat(100);
  if (config.role === "list") await list();
  else if (config.role === "case" && config.request.kind === "run") await oneCase(config.request);
  else {
    if (mode === "finish-error")
      await reporter.send({ kind: "error", message: "Finish page failure" });
    await reporter.send({ kind: "run-complete", remaining: [] });
  }
  await reporter.send({ kind: "doc-complete" });
  await reporter.readyForRetirement();
}
async function list(): Promise<void> {
  if (mode === "list-error") {
    await reporter.send({ kind: "error", message: "List page failure" });
    return;
  }
  await reporter.send({
    kind: "list",
    cases: {
      indexeddb: storageTests("/fs-worker.js", "/open-fs-worker.js").map((item) => item.label),
      opfs: opfsStorageTests("/fs-worker.js").map((item) => item.label),
    },
  });
}
async function oneCase(request: Extract<WorkerRequest, { kind: "run" }>): Promise<void> {
  const caseId = `${request.backend}: ${request.label}`;
  if (mode === "empty-complete") return;
  if (mode === "end-before-start") {
    await reporter.send({ kind: "case-end", caseId, status: "pass" });
    return;
  }
  await reporter.send({
    kind: "case-start",
    caseId: mode === "cross-group" ? "opfs: wrong group" : caseId,
  });
  if (mode === "case-hang") return unsettled();
  if (mode === "page-unresponsive") {
    const until = performance.now() + 8000;
    while (performance.now() < until) {
      /* Outlast the actual probe, then release the fixture so teardown can join WebKit. */
    }
    return unsettled();
  }
  if (mode === "wrong-label" || mode === "worker-timeout" || mode === "aggregate-error") {
    await failedWorker(request, caseId);
    return;
  }
  await reporter.send({ kind: "case-end", caseId, status: "pass" });
  if (mode === "pass-error")
    await reporter.send({ kind: "error", message: "Late error after pass" });
  if (mode === "duplicate-terminal")
    await reporter.send({ kind: "case-end", caseId, status: "pass" });
  if (mode === "reload") {
    location.reload();
    return unsettled();
  }
  if (mode === "heartbeat-lost" || mode === "missing-completion") return unsettled();
}
async function failedWorker(
  request: Extract<WorkerRequest, { kind: "run" }>,
  caseId: string,
): Promise<void> {
  try {
    const returned =
      mode === "aggregate-error"
        ? await storageCase({ ...request, label: "aggregate-error" })
        : mode === "worker-timeout"
          ? await storageCase(request)
          : "wrong label";
    validateWorkerLabel(returned, request.label);
  } catch (error) {
    await reporter.send({ kind: "case-end", caseId, status: "fail", error: String(error) });
  }
}
window.addEventListener("error", (event) => {
  void reporter.send({ kind: "error", message: event.message }).catch(() => {});
});
window.addEventListener("unhandledrejection", (event) => {
  void reporter.send({ kind: "error", message: String(event.reason) }).catch(() => {});
});
void run().catch(() => {});
