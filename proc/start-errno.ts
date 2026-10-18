/** Host outcomes retain Linux errno numbers; only the guest ABI uses WASI numbers. */
export const failures = {
  ENOENT: { code: 2, wasi: 44 },
  EACCES: { code: 13, wasi: 2 },
  ENOTDIR: { code: 20, wasi: 54 },
  ENOEXEC: { code: 8, wasi: 45 },
  ENOMEM: { code: 12, wasi: 48 },
  EAGAIN: { code: 11, wasi: 6 },
  EIO: { code: 5, wasi: 29 },
} as const;
export type StartFailure = keyof typeof failures;

export class ExecutableFormatError extends Error {
  readonly code = "ENOEXEC";
}
export function startFailureName(code: number): StartFailure {
  for (const name of Object.keys(failures) as StartFailure[]) if (failures[name].code === code) return name;
  throw new RangeError("unknown process startup errno");
}
export function startFailureErrno(error: StartFailure): number { return failures[error].wasi; }
