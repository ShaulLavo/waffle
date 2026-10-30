import { ProcessError, ProcessErrno } from "./errors.js";
import { atomicsWait, Int32ArrayConstructor, SharedArrayBufferConstructor } from "./intrinsics.ts";

let controlDepth = 0;
let policyDepth = 0;

/** Realm-local guards; these counts are never inferred from a shared process PID. */
export function terminalTurnActive(): boolean {
  return controlDepth !== 0 || policyDepth !== 0;
}
export function terminalPolicyActive(): boolean {
  return policyDepth !== 0;
}
export function withTerminalControl<T>(operation: () => T): T {
  controlDepth++;
  try {
    return operation();
  } finally {
    controlDepth--;
  }
}
export function withTerminalPolicy<T>(operation: () => T): T {
  policyDepth++;
  try {
    return operation();
  } finally {
    policyDepth--;
  }
}
export function assertTerminalWaitAllowed(): void {
  if (terminalTurnActive())
    throw new ProcessError(
      ProcessErrno.NOTSUP,
      "blocking wait inside a terminal control or policy turn",
    );
}

/** Realm placement, captured at load and never inferred from a process handle. A page
 * (browser window, Node or Bun main thread) must never block on terminal contention. */
const waitPlacement = captureWaitPlacement();
function captureWaitPlacement(): "page" | "worker" {
  const host = globalThis as {
    process?: { getBuiltinModule?: (name: string) => { isMainThread?: boolean } | undefined };
    WorkerGlobalScope?: abstract new () => unknown;
  };
  const builtin = host.process?.getBuiltinModule;
  if (typeof builtin === "function")
    return builtin("node:worker_threads")?.isMainThread === false ? "worker" : "page";
  const scope = host.WorkerGlobalScope;
  if (typeof scope !== "function" || !(globalThis instanceof scope)) return "page";
  try {
    atomicsWait(new Int32ArrayConstructor(new SharedArrayBufferConstructor(4)), 0, 1, 0);
    return "worker";
  } catch {
    return "page";
  }
}
/** Worker realm outside every control and policy turn. */
export function terminalWaitAllowed(): boolean {
  return waitPlacement === "worker" && !terminalTurnActive();
}
