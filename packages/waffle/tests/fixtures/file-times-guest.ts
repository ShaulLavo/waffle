import { Wasi } from "../../core/wasi.js";
import type { FileSystem } from "../../core/filesystem.js";

// WASI fst_flags.
export const ATIM = 1,
  MTIM = 4;
const ATIM_NOW = 2,
  MTIM_NOW = 8;
// Linux keeps nanoseconds; these need all of them.
export const ATIME = 1_700_000_000_123_456_789n;
export const MTIME = 1_600_000_000_987_654_321n;
const ALL = (1n << 29n) - 1n;
const PATH = 256,
  STAT = 1024,
  FD = 2048;

export interface Times {
  atime: bigint;
  mtime: bigint;
  ctime: bigint;
}
/** Clock readings in nanoseconds, the granularity the filesystem clock has. */
export interface Window {
  from: bigint;
  to: bigint;
}

/** A Preview 1 guest's view of `fs`: utimensat, futimens, stat and fstat. */
export function fileTimesGuest(fs: FileSystem) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  const view = new DataView(memory.buffer);
  const calls = wasi["functions"]();
  const path = (name: string) => {
    const data = new TextEncoder().encode(name);
    new Uint8Array(memory.buffer).set(data, PATH);
    return data.length;
  };
  const times = (errno: number): Times => {
    if (errno) throw new Error(`stat failed with errno ${errno}`);
    return {
      atime: view.getBigUint64(STAT + 40, true),
      mtime: view.getBigUint64(STAT + 48, true),
      ctime: view.getBigUint64(STAT + 56, true),
    };
  };
  return {
    setPathTimes: (name: string, atime: bigint, mtime: bigint, flags: number): number =>
      calls.path_filestat_set_times(3, 1, PATH, path(name), atime, mtime, flags),
    pathTimes: (name: string) => times(calls.path_filestat_get(3, 1, PATH, path(name), STAT)),
    open(name: string): number {
      const errno = calls.path_open(3, 0, PATH, path(name), 0, ALL, ALL, 0, FD);
      if (errno) throw new Error(`open failed with errno ${errno}`);
      return view.getUint32(FD, true);
    },
    setFdTimes: (fd: number, atime: bigint, mtime: bigint, flags: number): number =>
      calls.fd_filestat_set_times(fd, atime, mtime, flags),
    fdTimes: (fd: number) => times(calls.fd_filestat_get(fd, STAT)),
    dispose: () => wasi.descriptors.dispose(),
  };
}

function window(action: () => unknown): Window & { result: unknown } {
  const from = BigInt(Date.now()) * 1_000_000n;
  const result = action();
  return { from, to: BigInt(Date.now()) * 1_000_000n, result };
}

/** Each scenario expects /file and /dir to exist and returns what the guest saw. */
export const fileTimeScenarios = {
  both(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    return ["file", "dir"].map((entry) => {
      const before = h.pathTimes(entry);
      const set = window(() => h.setPathTimes(entry, ATIME, MTIME, ATIM | MTIM));
      return { before, set, after: h.pathTimes(entry) };
    });
  },
  alone(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    const errnos = [h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM)];
    errnos.push(h.setPathTimes("file", ATIME + 1n, 0n, ATIM));
    const pathAtime = h.pathTimes("file");
    errnos.push(h.setPathTimes("file", 0n, MTIME + 1n, MTIM));
    const pathMtime = h.pathTimes("file");
    const fd = h.open("file");
    errnos.push(h.setFdTimes(fd, ATIME + 2n, 0n, ATIM));
    const fdAtime = h.fdTimes(fd);
    errnos.push(h.setFdTimes(fd, 0n, MTIME + 2n, MTIM));
    const fdMtime = h.fdTimes(fd);
    h.dispose();
    return { errnos, pathAtime, pathMtime, fdAtime, fdMtime };
  },
  now(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    const errnos = [h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM)];
    const mtimeNow = window(() => h.setPathTimes("file", 1n, 1n, MTIM_NOW));
    const afterMtime = h.pathTimes("file");
    const fd = h.open("file");
    const atimeNow = window(() => h.setFdTimes(fd, 1n, 1n, ATIM_NOW));
    const afterAtime = h.fdTimes(fd);
    h.dispose();
    return { errnos, mtimeNow, afterMtime, atimeNow, afterAtime };
  },
  invalid(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    const set = h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM);
    const before = h.pathTimes("file");
    const errnos = [ATIM | ATIM_NOW, MTIM | MTIM_NOW, 16, 0].map((flags) =>
      h.setPathTimes("file", 1n, 1n, flags),
    );
    return { set, before, errnos, after: h.pathTimes("file") };
  },
  largest(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    // An i64 argument carries the unsigned time; -1n is 2^64 - 1.
    const errno = h.setPathTimes("file", -1n, -2n, ATIM | MTIM);
    return { errno, after: h.pathTimes("file") };
  },
  /** Persistence: set nanosecond times on /file and /dir. */
  persist(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    const fd = h.open("file");
    const errnos = [
      h.setFdTimes(fd, ATIME, MTIME, ATIM | MTIM),
      h.setPathTimes("dir", ATIME + 1n, MTIME + 1n, ATIM | MTIM),
    ];
    const seen = { errnos, file: h.pathTimes("file"), dir: h.pathTimes("dir") };
    h.dispose();
    return seen;
  },
  /** Persistence: change only the atime of /file. */
  atimeOnly(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    return { errno: h.setPathTimes("file", ATIME + 5n, 0n, ATIM), file: h.pathTimes("file") };
  },
  read(fs: FileSystem) {
    const h = fileTimesGuest(fs);
    return { file: h.pathTimes("file"), dir: h.pathTimes("dir") };
  },
} satisfies Record<string, (fs: FileSystem) => unknown>;
export type FileTimeScenario = keyof typeof fileTimeScenarios;
