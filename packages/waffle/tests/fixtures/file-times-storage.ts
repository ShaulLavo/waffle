import type { FileStat } from "../../core/filesystem.js";
import type { StorageBackend } from "../../fs/storage.js";
import { storageSession } from "./permissions-storage.js";

// Linux keeps nanoseconds; these need all of them.
const ATIME = 1_700_000_000_123_456_789n;
const MTIME = 1_600_000_000_987_654_321n;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function sameTimes(actual: FileStat, expected: FileStat, label: string): void {
  for (const field of ["atime", "mtime", "ctime"] as const)
    assert(
      actual[field] === expected[field],
      `${label} ${field}: expected ${expected[field]}, got ${actual[field]}`,
    );
}
async function times(storage: StorageBackend) {
  const session = await storageSession(storage);
  const fs = session.client;
  const root = await fs.asyncCall("preopen", ["/"]);
  const file: number = (await fs.asyncCall("resolve", [root, "file"])).node;
  const dir: number = (await fs.asyncCall("resolve", [root, "dir"])).node;
  return {
    session,
    file,
    dir,
    stat: (handle: number): Promise<FileStat> => fs.asyncCall("stat", [handle]),
    set: (handle: number, atime: bigint | null, mtime: bigint | null): Promise<number> =>
      fs.asyncCall("setTimes", [handle, atime, mtime]),
  };
}

/** The same real backend, service and client run in units and every browser storage engine:
 * nanosecond atime, mtime and ctime of a file and a directory survive reopening, and so does a
 * later change of atime alone. */
export async function fileTimesStorageCase(open: () => Promise<StorageBackend>): Promise<void> {
  const created = await storageSession(await open());
  try {
    await created.client.asyncCall("writeFile", ["/file"], new TextEncoder().encode("payload"));
    await created.client.asyncCall("mkdirp", ["/dir"]);
    await created.client.asyncCall("flush");
  } finally {
    await created.close();
  }
  let saved: { file: FileStat; dir: FileStat };
  const first = await times(await open());
  try {
    assert((await first.set(first.file, ATIME, MTIME)) === 0, "set file times");
    assert((await first.set(first.dir, ATIME + 1n, MTIME + 1n)) === 0, "set directory times");
    saved = { file: await first.stat(first.file), dir: await first.stat(first.dir) };
    assert(saved.file.atime === ATIME && saved.file.mtime === MTIME, "file times set exactly");
    assert(saved.dir.atime === ATIME + 1n && saved.dir.mtime === MTIME + 1n, "directory times");
    await first.session.client.asyncCall("flush");
  } finally {
    await first.session.close();
  }
  const second = await times(await open());
  try {
    sameTimes(await second.stat(second.file), saved.file, "reopened file");
    sameTimes(await second.stat(second.dir), saved.dir, "reopened directory");
    assert((await second.set(second.file, ATIME + 2n, null)) === 0, "set atime alone");
    await second.session.client.asyncCall("flush");
  } finally {
    await second.session.close();
  }
  const third = await times(await open());
  try {
    const file = await third.stat(third.file);
    assert(file.atime === ATIME + 2n, `atime-only change survives reopen, got ${file.atime}`);
    assert(file.mtime === MTIME, "mtime unchanged by an atime-only change");
  } finally {
    await third.session.close();
  }
}
