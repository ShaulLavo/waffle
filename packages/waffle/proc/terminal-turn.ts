import { ProcessError, ProcessErrno } from "./errors.js";

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
