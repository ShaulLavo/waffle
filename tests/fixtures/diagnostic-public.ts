// NodeNext must resolve the same narrow public helper entry that Node imports at runtime.
import { DIAGNOSTIC_STALL_TIMEOUT_MS, drainDiagnostic } from "waffle/browser/diagnostic";
/** @compileFixture Called outside the import graph by generated pages or compiler probes. */
export const diagnosticStallTimeout: number = DIAGNOSTIC_STALL_TIMEOUT_MS;
/** @compileFixture Called outside the import graph by generated pages or compiler probes. */
export function writeHostDiagnostic(
  bytes: Uint8Array,
  write: (bytes: Uint8Array) => number,
): void | Promise<void> {
  return drainDiagnostic(bytes, write);
}
