// WASI errno values carried in unix-* reply cells. No namespace, FS or loader dependencies.
export const EACCES = 2;
export const EADDRINUSE = 3;
export const EBADF = 8;
export const ECANCELED = 11;
export const ECONNREFUSED = 14;
export const EEXIST = 20;
export const EINVAL = 28;
export const ELOOP = 32;
export const ENAMETOOLONG = 37;
export const ENOBUFS = 42;
export const ENOENT = 44;
export const ENOTDIR = 54;
export const ENOTSUP = 58;
export const ENOTCAPABLE = 76;

const NAMES: Record<number, string> = {
  [EACCES]: "EACCES",
  [EADDRINUSE]: "EADDRINUSE",
  [EBADF]: "EBADF",
  [ECANCELED]: "ECANCELED",
  [ECONNREFUSED]: "ECONNREFUSED",
  [EINVAL]: "EINVAL",
  [ELOOP]: "ELOOP",
  [ENAMETOOLONG]: "ENAMETOOLONG",
  [ENOBUFS]: "ENOBUFS",
  [ENOENT]: "ENOENT",
  [ENOTDIR]: "ENOTDIR",
  [ENOTSUP]: "ENOTSUP",
  [ENOTCAPABLE]: "ENOTCAPABLE",
};

/** Node-style code for a unix-* reply errno; unknown values keep their number visible. */
export function unixCode(errno: number): string {
  return NAMES[errno] ?? `EUNKNOWN${errno}`;
}

/** Longest accepted path, in UTF-8 bytes, before the FS walk. */
export const PATH_LIMIT = 4096;
