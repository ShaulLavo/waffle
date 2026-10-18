import { errno } from "../fs/protocol.js";
import { ProcessError } from "./types.js";

/** Live pending or completed-but-untaken executable queries per process. */
export const MAX_ACCESS_REQUESTS = 64;

/** Both process adapters expose the same signed WASI result for admission errors. */
export function executableAccessResult(error: unknown): number {
  const code = (error as { code?: string } | null)?.code;
  return -(code === "ENOENT"
    ? 44
    : code === "EACCES"
      ? 2
      : code === "ENOTDIR"
        ? 54
        : error instanceof ProcessError
          ? error.errno
          : errno(error));
}
