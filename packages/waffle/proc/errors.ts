import { objectFreeze } from "./intrinsics/core.ts";

export class ProcessError extends Error {
  readonly errno: number;
  constructor(errno: number, message: string) {
    super(message);
    this.errno = errno;
    this.name = "ProcessError";
  }
}
export const ProcessErrno = objectFreeze({
  AGAIN: 6,
  BADF: 8,
  CANCELED: 11,
  CHILD: 12,
  INVAL: 28,
  NOMEM: 48,
  NOTSUP: 58,
  SRCH: 71,
});
