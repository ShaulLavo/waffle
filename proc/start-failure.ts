import { ExecutionUnwind } from "../core/unwind.js";
import { FilesystemError } from "../fs/protocol.ts";
import { ProcessError, type ProcessExit } from "./types.ts";

import { failures, type StartFailure } from "./start-errno.ts";
export { ExecutableFormatError, startFailureErrno, type StartFailure } from "./start-errno.ts";

/** Only explicit executable defects mean ENOEXEC, never arbitrary loader/host errors. */
export function startFailure(error: unknown): Extract<ProcessExit, { kind: "start-failed" }> {
  const name = (error as { code?: unknown } | null)?.code;
  const wasi =
    error instanceof ProcessError || error instanceof FilesystemError ? error.errno : undefined;
  const known = (Object.keys(failures) as StartFailure[]).find(
    (name) => failures[name].wasi === wasi,
  );
  const failure: StartFailure =
    error instanceof RangeError || wasi === 48
      ? "ENOMEM"
      : wasi === 6 || wasi === 33 || wasi === 41 || wasi === 51
        ? "EAGAIN"
        : (known ??
          (typeof name === "string" && Object.hasOwn(failures, name)
            ? (name as StartFailure)
            : "EIO"));
  return { kind: "start-failed", code: failures[failure].code, error: failure, status: null };
}

/** Reservation failures remain spawn syscall errors, not collectable child outcomes. */
export function spawnError(error: unknown): ProcessError {
  if (error instanceof ExecutionUnwind) throw error;
  if (error instanceof ProcessError && error.errno !== 41) return error;
  const errno =
    error instanceof RangeError
      ? 48
      : error instanceof ProcessError || error instanceof FilesystemError
        ? error.errno === 33 || error.errno === 41 || error.errno === 51
          ? 6
          : error.errno
        : 29;
  return new ProcessError(errno, error instanceof Error ? error.message : String(error));
}
