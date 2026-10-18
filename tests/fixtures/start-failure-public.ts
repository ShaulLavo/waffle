// Compile this caller-owned host against the same public entry Node loads at runtime.
import { startFailure, type ProcessExit } from "waffle/proc";
export function normalizeHostStartupError(error: unknown): Extract<ProcessExit, { kind: "start-failed" }> {
  return startFailure(error);
}
