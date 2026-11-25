import { afterEach, expect, spyOn, test } from "bun:test";
import type { FileSystem } from "../core/filesystem.js";
import { MemFS } from "../fs/memory.js";
import { PersistentBackend } from "../fs/persistent.js";
import type { PublicationLimits } from "../fs/publication-internal.js";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  type FilesystemBackend,
} from "../fs/index.js";
import { MetadataStore } from "./fixtures/metadata-enumeration-r173-store.js";
import { fileTimesStorageCase } from "../testing/fixtures/file-times-storage.js";
import {
  ATIM,
  ATIME,
  MTIM,
  MTIME,
  fileTimeScenarios,
  fileTimesGuest,
  type FileTimeScenario,
  type Times,
  type Window,
} from "./fixtures/file-times-guest.js";
import { openVfsBackend, type VfsBackendKind } from "./fixtures/vfs-backends.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

const limits: PublicationLimits = {
  sessions: 8,
  operations: 16,
  inputBytes: 256,
  argumentBytes: 1024,
  effectBytes: 8192,
  effects: 64,
  resultBytes: 256,
  logRecords: 32,
  logBytes: 262144,
  pins: 4,
  pinBytes: 256,
};

/** Runs a scenario in a guest Worker against `backend`, served from this thread. */
async function inWorker(
  backend: FilesystemBackend,
  scenario: FileTimeScenario,
  publication = false,
): Promise<any> {
  const service = new FilesystemService(backend);
  cleanup.push(() => service.dispose());
  const connection = publication
    ? createFilesystemConnection(undefined, { limits, observe: true })
    : createFilesystemConnection();
  service.connect(connection.server);
  const worker = new Worker(new URL("./fixtures/file-times-worker.ts", import.meta.url).href);
  cleanup.push(() => worker.terminate());
  const reply = new Promise<{ value?: unknown; error?: string }>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = reject;
  });
  worker.postMessage({ connection: connection.client, scenario }, [connection.client.port]);
  const { value, error } = await reply;
  if (error) throw new Error(error);
  return value;
}

function seeded(fs: MemFS): MemFS {
  fs.writeFile("/file", "abc");
  fs.mkdirp("/dir");
  return fs;
}

async function inVfsBackendWorker(kind: VfsBackendKind, scenario: FileTimeScenario): Promise<any> {
  const env = await openVfsBackend(kind);
  try {
    await env.client.asyncCall(
      "writeFile",
      ["/file", false, false],
      new TextEncoder().encode("abc"),
    );
    await env.client.asyncCall("mkdirp", ["/dir"]);
    const connection = env.forkConnection();
    const worker = new Worker(new URL("./fixtures/file-times-worker.ts", import.meta.url).href);
    try {
      const reply = new Promise<{ value?: unknown; error?: string }>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = reject;
      });
      worker.postMessage({ connection, scenario }, [connection.port]);
      const { value, error } = await reply;
      if (error) throw new Error(error);
      return value;
    } finally {
      worker.terminate();
      const { reapFilesystem } = await import("../fs/protocol.js");
      reapFilesystem(connection);
    }
  } finally {
    await env.close();
  }
}

const runners: [string, (scenario: FileTimeScenario) => Promise<any>][] = [
  ["memory", async (scenario) => fileTimeScenarios[scenario](seeded(new MemFS()))],
  [
    "shared worker",
    (scenario) => {
      const backend = new MemoryBackend();
      seeded(backend.fs);
      return inWorker(backend, scenario);
    },
  ],
  [
    "publication worker",
    (scenario) => {
      const backend = new MemoryBackend();
      seeded(backend.fs);
      return inWorker(backend, scenario, true);
    },
  ],
  ["persistent worker", (scenario) => inVfsBackendWorker("persistent", scenario)],
  ["multitab-host worker", (scenario) => inVfsBackendWorker("multitab-host", scenario)],
  ["multitab-peer worker", (scenario) => inVfsBackendWorker("multitab-peer", scenario)],
];

function within(time: bigint, window: Window): void {
  expect(time).toBeGreaterThanOrEqual(window.from);
  expect(time).toBeLessThanOrEqual(window.to);
}

for (const [name, run] of runners) {
  test(`${name}: setting both times keeps every nanosecond and moves ctime`, async () => {
    const seen: { before: Times; set: Window & { result: number }; after: Times }[] =
      await run("both");
    for (const { before, set, after } of seen) {
      expect(set.result).toBe(0);
      expect(after.atime).toBe(ATIME);
      expect(after.mtime).toBe(MTIME);
      within(after.ctime, set);
      expect(after.ctime).toBeGreaterThanOrEqual(before.ctime);
    }
  });

  test(`${name}: each time can be set alone and the other stays`, async () => {
    const seen = await run("alone");
    expect(seen.errnos).toEqual([0, 0, 0, 0, 0]);
    expect(seen.pathAtime).toMatchObject({ atime: ATIME + 1n, mtime: MTIME });
    expect(seen.pathMtime).toMatchObject({ atime: ATIME + 1n, mtime: MTIME + 1n });
    expect(seen.fdAtime).toMatchObject({ atime: ATIME + 2n, mtime: MTIME + 1n });
    expect(seen.fdMtime).toMatchObject({ atime: ATIME + 2n, mtime: MTIME + 2n });
  });

  test(`${name}: NOW flags take the clock and leave the other time`, async () => {
    const seen = await run("now");
    expect(seen.errnos).toEqual([0]);
    expect(seen.mtimeNow.result).toBe(0);
    expect(seen.afterMtime.atime).toBe(ATIME);
    within(seen.afterMtime.mtime, seen.mtimeNow);
    expect(seen.atimeNow.result).toBe(0);
    within(seen.afterAtime.atime, seen.atimeNow);
    expect(seen.afterAtime.mtime).toBe(seen.afterMtime.mtime);
  });

  test(`${name}: a time with its NOW flag is EINVAL; no time selected changes nothing`, async () => {
    const seen = await run("invalid");
    expect(seen.set).toBe(0);
    expect(seen.errnos).toEqual([28, 28, 28, 0]);
    expect(seen.after).toEqual(seen.before);
  });

  test(`${name}: the largest WASI time round trips`, async () => {
    const seen = await run("largest");
    expect(seen.errno).toBe(0);
    expect(seen.after).toMatchObject({
      atime: 0xffff_ffff_ffff_ffffn,
      mtime: 0xffff_ffff_ffff_fffen,
    });
  });
}

test("writes and truncation set mtime and ctime together and leave atime", () => {
  const fs = seeded(new MemFS());
  const h = fileTimesGuest(fs);
  expect(h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM)).toBe(0);
  const handle = (fs.resolve(fs.preopen("/"), "file") as { node: number }).node;
  const from = BigInt(Date.now()) * 1_000_000n;
  expect(fs.write(handle, [new Uint8Array([1])], 0)).toBe(1);
  let times = h.pathTimes("file");
  expect(times.atime).toBe(ATIME);
  expect(times.ctime).toBe(times.mtime);
  expect(times.mtime).toBeGreaterThanOrEqual(from);
  expect(h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM)).toBe(0);
  expect(fs.resize(handle, 0, true)).toBe(0);
  times = h.pathTimes("file");
  expect(times.atime).toBe(ATIME);
  expect(times.ctime).toBe(times.mtime);
  expect(times.mtime).toBeGreaterThanOrEqual(from);
});

test("mode and name changes move ctime and leave atime and mtime", () => {
  const fs = seeded(new MemFS());
  const h = fileTimesGuest(fs);
  expect(h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM)).toBe(0);
  const root = fs.preopen("/");
  const handle = (fs.resolve(root, "file") as { node: number }).node;
  const node = fs.nodeForHandle(handle);
  node.ctime = 1n;
  expect(fs.setMode(handle, 0o600)).toBe(0);
  expect(node.ctime).toBeGreaterThan(1n);
  node.ctime = 1n;
  const from = fs.resolve(root, "file");
  const to = fs.resolve(root, "dir/file");
  if (typeof from === "number" || typeof to === "number") throw new Error("resolve failed");
  expect(fs.rename(from, to)).toBe(0);
  expect(node.ctime).toBeGreaterThan(1n);
  expect(h.pathTimes("dir/file")).toMatchObject({ atime: ATIME, mtime: MTIME });
});

test("the shared backend's write path sets mtime and ctime from one clock reading", async () => {
  const backend = new MemoryBackend();
  seeded(backend.fs);
  const handle = (backend.fs.resolve(backend.fs.preopen("/"), "file") as { node: number }).node;
  backend.retain(handle);
  cleanup.push(() => backend.release(handle));
  backend.execute("setTimes", [handle, ATIME, MTIME], new Uint8Array());
  backend.execute("write", [handle, 0], new Uint8Array([7]));
  const stat = backend.shared.stat(handle)!;
  expect(stat.atime).toBe(ATIME);
  expect(stat.ctime).toBe(stat.mtime);
  expect(stat.mtime).toBeGreaterThan(MTIME);
});

/** A controlled clock, so a name change in the same millisecond cannot hide a missing ctime. */
function clockAt(ms: number) {
  const now = spyOn(Date, "now").mockReturnValue(ms);
  cleanup.push(() => now.mockRestore());
  return (next: number) => now.mockReturnValue(next);
}
const atMs = (ms: number) => BigInt(ms) * 1_000_000n;

/** Renames, links and unlinks change only the inode's names: the shared table sets ctime
 * without a revision bump and leaves atime and mtime alone. */
test("name changes set ctime in the shared file table", () => {
  const setClock = clockAt(1_000);
  const backend = new MemoryBackend();
  backend.execute("writeFile", ["/file"], new TextEncoder().encode("abc"));
  const handle = (backend.fs.resolve(backend.fs.preopen("/"), "file") as { node: number }).node;
  backend.retain(handle);
  cleanup.push(() => backend.release(handle));
  backend.execute("setTimes", [handle, ATIME, MTIME], new Uint8Array());
  const revision = backend.shared.revision(handle);
  const steps: [number, string, string[]][] = [
    [2_000, "move", ["/file", "/moved"]],
    [3_000, "move", ["/moved", "/again"]],
  ];
  for (const [ms, operation, args] of steps) {
    setClock(ms);
    backend.execute(operation, args, new Uint8Array());
    expect(backend.shared.stat(handle)).toMatchObject({
      atime: ATIME,
      mtime: MTIME,
      ctime: atMs(ms),
    });
  }
  const root = backend.fs.preopen("/");
  setClock(4_000);
  backend.execute(
    "link",
    [backend.fs.resolve(root, "again"), backend.fs.resolve(root, "hard")],
    new Uint8Array(),
  );
  expect(backend.shared.stat(handle)).toMatchObject({ nlink: 2, mtime: MTIME, ctime: atMs(4_000) });
  setClock(5_000);
  backend.execute("remove", ["/hard"], new Uint8Array());
  expect(backend.shared.stat(handle)).toMatchObject({ nlink: 1, mtime: MTIME, ctime: atMs(5_000) });
  expect(backend.shared.revision(handle)).toBe(revision);
});

test("a rename's ctime survives a reopen", async () => {
  const setClock = clockAt(1_000);
  const store = new Store();
  const first = await persistent(store, true);
  const handle = (first.fs.resolve(first.fs.preopen("/"), "file") as { node: number }).node;
  first.retain(handle);
  first.execute("setTimes", [handle, ATIME, MTIME], new Uint8Array());
  await first.flush();
  setClock(2_000);
  first.execute("move", ["/file", "/moved"], new Uint8Array());
  first.release(handle);
  await first.flush();
  const second = await persistent(store);
  const moved = (second.fs.resolve(second.fs.preopen("/"), "moved") as { node: number }).node;
  expect(second.fs.stat(moved)).toMatchObject({ atime: ATIME, mtime: MTIME, ctime: atMs(2_000) });
});

/** tar -x and cp -p set times after making a file read-only; Linux allows the owner that. */
test("the owner sets times on a read-only file", () => {
  const fs = seeded(new MemFS());
  const h = fileTimesGuest(fs);
  const handle = (fs.resolve(fs.preopen("/"), "file") as { node: number }).node;
  expect(fs.setMode(handle, 0o400)).toBe(0);
  expect(h.setPathTimes("file", ATIME, MTIME, ATIM | MTIM)).toBe(0);
  expect(h.pathTimes("file")).toMatchObject({ atime: ATIME, mtime: MTIME });

  const backend = new MemoryBackend();
  seeded(backend.fs);
  const shared = (backend.fs.resolve(backend.fs.preopen("/"), "file") as { node: number }).node;
  backend.retain(shared);
  cleanup.push(() => backend.release(shared));
  backend.execute("setMode", [shared, 0o400], new Uint8Array());
  expect(backend.execute("setTimes", [shared, ATIME, MTIME], new Uint8Array())).toBe(0);
  expect(backend.shared.stat(shared)).toMatchObject({ mode: 0o400, atime: ATIME, mtime: MTIME });
  expect(backend.shared.setTimes(shared, null, MTIME + 1n, atMs(1))).toBe(0);
  expect(backend.shared.stat(shared)?.mtime).toBe(MTIME + 1n);
  // Writing stays denied.
  expect(() => backend.shared.write(shared, [new Uint8Array([1])], 0)).toThrow("errno 2");
});

// Keeps a checksummed snapshot, the record OPFS writes, so stored times go through validation.
type Store = MetadataStore;
const Store = MetadataStore;

async function persistent(store: Store, seed = false) {
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  cleanup.push(() => backend.dispose());
  // Through the backend, so its payloads are captured for checkpoints.
  if (seed) {
    backend.execute("writeFile", ["/file"], new TextEncoder().encode("abc"));
    backend.execute("mkdirp", ["/dir"], new Uint8Array());
  }
  return backend;
}

test("nanosecond atime, mtime and ctime survive a reopen", async () => {
  const store = new Store();
  const first = await persistent(store, true);
  const set = await inWorker(first, "persist");
  expect(set.errnos).toEqual([0, 0]);
  expect(set.file).toMatchObject({ atime: ATIME, mtime: MTIME });
  expect(set.dir).toMatchObject({ atime: ATIME + 1n, mtime: MTIME + 1n });
  await first.flush();
  const second = await persistent(store);
  const read = await inWorker(second, "read");
  expect(read).toEqual({ file: set.file, dir: set.dir });
  // Stored records keep the exact decimal nanoseconds.
  const stored = (await store.load())!.nodes;
  expect(stored.some((node) => node.atime === `${ATIME}` && node.mtime === `${MTIME}`)).toBe(true);
});

test("an atime-only change reaches storage", async () => {
  const store = new Store();
  const first = await persistent(store, true);
  await first.flush();
  const set = await inWorker(first, "atimeOnly");
  expect(set.errno).toBe(0);
  await first.flush();
  const second = await persistent(store);
  const read = await inWorker(second, "read");
  expect(read.file).toEqual(set.file);
  expect(read.file.atime).toBe(ATIME + 5n);
});

test("the browser storage case passes over a checksummed snapshot store", async () => {
  const store = new Store();
  await fileTimesStorageCase(async () => store);
});

test("FileSystem implementations reject times outside WASI's unsigned range", async () => {
  const client = await (async () => {
    const service = new FilesystemService(new MemoryBackend());
    const connection = createFilesystemConnection();
    service.connect(connection.server);
    const value = new FilesystemClient(connection.client);
    cleanup.push(() => {
      value.dispose();
      service.dispose();
    });
    return value;
  })();
  const fs: FileSystem = client;
  expect(fs.setTimes(0, -1n, null)).toBe(28);
  expect(fs.setTimes(0, null, 1n << 64n)).toBe(28);
});
