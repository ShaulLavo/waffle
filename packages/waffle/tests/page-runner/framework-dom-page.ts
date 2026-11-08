import { getFrameworkObservation } from "waffle/testing/page-runner/framework-page";
declare const FRAMEWORK_DOM_MODE: string;
declare const FRAMEWORK_DOM_FILE: string;
declare const FRAMEWORK_DOM_TIMEOUT: number;
const observation = getFrameworkObservation();
if (!observation) throw new Error("Synthetic document was not instrumented");
const observer = observation;
observer.catcherInstalled();
const mode = FRAMEWORK_DOM_MODE;
const clock = globalThis.setTimeout.bind(globalThis);
const sleep = (ms: number) => new Promise((resolve) => clock(resolve, ms));
function failed(error: unknown): void {
  observer.error(String(error), "synthetic-fixture");
}
async function tester(): Promise<void> {
  const task = {
    id: "actual-synthetic-task",
    parentId: null,
    type: "test",
    file: FRAMEWORK_DOM_FILE,
    fullName: "synthetic case",
    mode: "run",
    timeoutMs: FRAMEWORK_DOM_TIMEOUT,
    retries: 0,
  } as const;
  await observer.collected([task]);
  observer.taskStarted(task.id);
  const host = document.createElement("div");
  host.style.cssText = "width:480px;height:160px;box-sizing:border-box;padding:8px";
  document.body.append(host);
  if (host.getBoundingClientRect().width !== 480)
    throw new Error("Synthetic host was shrunk to the tester width");
  await sleep(100);
  const update = { id: task.id, state: "pass", errors: [], hooks: null, retryCount: 0 } as const;
  observer.taskUpdate([update]);
  observer.taskUpdate([update]);
  observer.caseSettled([update]);
  observer.executionFlushed();
  observer.testerCleanupSettled();
  parent.postMessage("matched-cleanup-response", location.origin);
}
async function top(): Promise<void> {
  const request = await observer.waitForInitialViewport();
  const response = await fetch("/initial", { method: "POST", body: JSON.stringify(request) });
  if (!response.ok) throw new Error(await response.text());
  const iframe = document.querySelector("iframe[data-vitest]");
  if (!(iframe instanceof HTMLIFrameElement)) throw new Error("Missing synthetic tester");
  if (mode === "replace") iframe.replaceWith(iframe.cloneNode());
  if (mode === "extra") document.body.append(iframe.cloneNode());
  if (mode === "reload") iframe.contentWindow?.location.reload();
  iframe.contentWindow?.postMessage("execute-synthetic", location.origin);
}
addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  if (event.data === "execute-synthetic" && window !== parent) void tester().catch(failed);
  if (event.data !== "matched-cleanup-response" || window !== parent) return;
  if (mode === "missing-cleanup") return;
  observer.cleanupResponseReceived();
  void observer.waitForRetirement().then(() => {
    Reflect.set(window, "__frameworkControlEnd", true);
  });
});
if (window === parent) void top().catch(failed);
