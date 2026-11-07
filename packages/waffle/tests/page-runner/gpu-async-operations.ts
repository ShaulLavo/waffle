import type { AsyncCommand } from "../gpu-async-command.js";

type AsyncPage = typeof import("../fixtures/gpu/async-page.js");
let asyncStarted = false;
let closeAttempted = false;
let closed: unknown;
let qualificationClosed = false;

/** @browserEntry */
export async function gpuAsyncCapabilities() {
  const path = "/qualification-page.js";
  const module: typeof import("../fixtures/gpu/qualification-page.js") = await import(path);
  try {
    const opened = await module.openQualification();
    const capabilities = await module.qualificationCommand({ kind: "capabilities" });
    return { opened, capabilities };
  } finally {
    module.closeQualification();
    qualificationClosed = true;
  }
}
/** @browserEntry */
export async function gpuAsyncInvoke<K extends keyof AsyncPage>(
  name: K,
  args: Parameters<AsyncPage[K]>,
) {
  const path = "/async-page.js";
  const module = await import(path);
  if (name === "openAsync") asyncStarted = true;
  if (name === "closeAsync") closeAttempted = true;
  const result: unknown = await module[name](...args);
  if (name === "closeAsync") closed = result;
  return result;
}
export async function gpuAsyncTeardown() {
  if (asyncStarted && !closeAttempted) await gpuAsyncInvoke("closeAsync", []);
  if (asyncStarted && closed === undefined) throw new Error("Async fixture close did not finish");
  return { qualificationClosed, asyncStarted, closeAttempted, closed: closed ?? null };
}

declare global {
  interface Window {
    __gpuAsync: {
      capabilities: typeof gpuAsyncCapabilities;
      invoke: AsyncCommand["invoke"];
      value: unknown;
    };
  }
}
