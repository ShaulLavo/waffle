// Compile this caller-owned host against the same public entry Node loads at runtime.
import { startFailure, type ProcessExit } from "waffle/proc";
/** @compileFixture Called outside the import graph by generated pages or compiler probes. */
export function normalizeHostStartupError(
  error: unknown,
): Extract<ProcessExit, { kind: "start-failed" }> {
  return startFailure(error);
}
