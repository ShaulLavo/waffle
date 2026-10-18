import { expect, test } from "bun:test";
import { getVfsDescriptor, VfsError, type VfsSelection } from "../index.js";
import { resolveVfs } from "../fs/vfs.js";
import { SharedFilesystem } from "../browser/shared-fs.js";

const selections: VfsSelection[] = [
  {},
  { vfs: "indexeddb", whenBusy: "wait" },
  { vfs: "opfs-memory", whenBusy: "wait" },
  { vfs: "memory" },
];
// @ts-expect-error A future, uncertified implementation is not selectable.
const future: VfsSelection = { vfs: "opfs-wal" };
// @ts-expect-error Memory has no ownership contention setting.
const irrelevant: VfsSelection = { vfs: "memory", whenBusy: "wait" };
// @ts-expect-error The old storage selector is not an accepted request shape.
const old: VfsSelection = { storage: "opfs" };
void [future, irrelevant, old];

test("VFS selection preserves default ownership and separates settings from identity", () => {
  expect(resolveVfs({})).toEqual({ descriptor: getVfsDescriptor(), whenBusy: "takeover" });
  for (const selection of selections) {
    const resolved = resolveVfs(selection);
    expect(resolved.descriptor).toBe(getVfsDescriptor(selection.vfs));
  }
  expect(resolveVfs({ vfs: "opfs-memory" }).whenBusy).toBe("wait");
  expect(resolveVfs({ vfs: "memory" }).whenBusy).toBeUndefined();
  expect(resolveVfs({ whenBusy: "wait" }).descriptor).toBe(getVfsDescriptor());
});

test("descriptors distinguish relaxed ACKs, barriers, ownership, format and lifecycle", () => {
  const idb = getVfsDescriptor();
  expect(idb).toMatchObject({
    id: "indexeddb",
    persistent: true,
    mutationAcknowledgement: "memory",
    multiTab: "exclusive-owner",
    defaultWhenBusy: "takeover",
    worker: "dedicated",
    serviceMayAwait: true,
    directSharedMemory: { reads: true, mutations: true },
    format: { id: "waffle-indexeddb-v1" },
  });
  expect(idb.durability).toEqual({
    flush: "checkpoint-data-and-metadata",
    fsync: "targeted-file-checkpoint",
    targetedFlush: "selected-payloads-and-namespace",
  });
  expect(idb.requirements).toContain("IndexedDB");
  expect(idb.lifecycle).toEqual(["opening", "waiting", "ready", "failed", "disposed"]);
  const opfs = getVfsDescriptor("opfs-memory");
  expect(opfs.format?.id).toBe("waffle-opfs-snapshots-v1");
  expect(opfs.supportedWhenBusy).toEqual(["wait"]);
  expect(opfs.unsupportedSettings).toEqual(["whenBusy:takeover"]);
  expect(opfs.requirements).toContain("sync-access-handles");
  const memory = getVfsDescriptor("memory");
  expect(memory.persistent).toBe(false);
  expect(memory.format).toBeNull();
  expect(memory.multiTab).toBe("isolated");
  expect(memory.durability.flush).toBe("volatile-ordering-only");
  for (const name of ["indexeddb", "opfs-memory", "memory"]) {
    const descriptor = getVfsDescriptor(name);
    expect(Object.isFrozen(descriptor)).toBe(true);
    const objects = Object.values(descriptor).filter((value) => value && typeof value === "object");
    expect(objects.every(Object.isFrozen)).toBe(true);
  }
});

for (const name of ["opfs", "opfs-safe", "opfs-wal", "indexeddb-wait", "", "unknown"])
  test(`unsupported selection ${JSON.stringify(name)} has no fallback`, () => {
    expect(() => getVfsDescriptor(name)).toThrow(VfsError);
    expect(caught(() => resolveVfs({ vfs: name }))).toMatchObject({
      name: "VfsError",
      code: "UNSUPPORTED_VFS",
      vfs: name,
    });
    expect(caught(() => new SharedFilesystem({ vfs: name } as VfsSelection))).toMatchObject({
      code: "UNSUPPORTED_VFS",
      vfs: name,
    });
  });

for (const options of [
  { whenBusy: "invalid" },
  { vfs: "opfs-memory", whenBusy: "takeover" },
  { vfs: "memory", whenBusy: "wait" },
  { vfs: "memory", whenBusy: "takeover" },
])
  test(`invalid settings reject without allocating a worker: ${JSON.stringify(options)}`, () => {
    expect(caught(() => new SharedFilesystem(options as VfsSelection))).toMatchObject({
      name: "VfsError",
      code: "INVALID_VFS_SETTINGS",
      vfs: options.vfs ?? "indexeddb",
    });
  });

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error");
}

for (const [options, code] of [
  [{ vfs: "opfs-wal" }, "UNSUPPORTED_VFS"],
  [{ vfs: "opfs-memory", whenBusy: "takeover" }, "INVALID_VFS_SETTINGS"],
  [{ vfs: "indexeddb" }, "UNSUPPORTED_VFS_CAPABILITY"],
] as const)
  test(`production worker preserves typed ${code} diagnostics`, async () => {
    const worker = new Worker(new URL("../browser/fs-worker.ts", import.meta.url).href);
    try {
      const received = new Promise<any>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message));
        };
      });
      worker.postMessage(options);
      expect(await received).toMatchObject({
        type: "filesystem-error",
        name: "VfsError",
        code,
        vfs: options.vfs,
      });
    } finally {
      worker.terminate();
    }
  });
