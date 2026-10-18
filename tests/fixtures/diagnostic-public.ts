// NodeNext must resolve the same narrow public helper entry that Node imports at runtime.
import { DIAGNOSTIC_STALL_TIMEOUT_MS, drainDiagnostic } from "waffle/browser/diagnostic";
export const diagnosticStallTimeout: number = DIAGNOSTIC_STALL_TIMEOUT_MS;
export function writeHostDiagnostic(bytes: Uint8Array, write: (bytes: Uint8Array) => number): void | Promise<void> {
  return drainDiagnostic(bytes, write);
}
