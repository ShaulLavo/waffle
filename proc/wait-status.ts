import type { ProcessExit } from "./types.js";

export function waitStatus(result: ProcessExit): number {
  return result.kind === "start-failed" ? result.error === "ENOENT" ? 127 : 126 : result.status;
}
