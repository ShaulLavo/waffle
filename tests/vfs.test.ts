import { INDEXEDDB_FORMAT } from "../fs/vfs-format.js";
import { expect, test } from "bun:test";
import { getVfsDescriptor, VfsError, type VfsSelection } from "../index.js";
import { resolveVfs } from "../fs/vfs.js";
import { withVfsImplementation } from "../fs/vfs-internal.js";
import { SharedFilesystem } from "../browser/shared-fs.js";

const selections: VfsSelection[] = [{}, { mode: "fast", whenBusy: "wait" }, { mode: "memory" }];
const safe: VfsSelection = { mode: "safe" };
// @ts-expect-error Backend names are not product modes.
const backend: VfsSelection = { mode: "indexeddb" };
// @ts-expect-error Memory has no ownership contention setting.
const irrelevant: VfsSelection = { mode: "memory", whenBusy: "wait" };
// @ts-expect-error The old selector is not an accepted request shape.
const old: VfsSelection = { vfs: "opfs-memory" };
// @ts-expect-error Implementation overrides are not public settings.
const override: VfsSelection = { mode: "fast", implementation: "opfs-memory" };
void [safe, backend, irrelevant, old, override];

test("mode selection preserves the existing workspace and separates implementation from mode", () => {
  expect(resolveVfs({})).toEqual({ descriptor: getVfsDescriptor(), whenBusy: "takeover" });
  for (const selection of selections)
    expect(resolveVfs(selection).descriptor).toBe(getVfsDescriptor(selection.mode));
  expect(resolveVfs({ mode: "memory" }).whenBusy).toBeUndefined();
  expect(resolveVfs({ whenBusy: "wait" }).descriptor).toBe(getVfsDescriptor());
  const opfs = resolveVfs({ mode: "fast" }, "opfs-memory");
  expect(opfs.descriptor.mode).toBe("fast");
  expect(opfs.descriptor.implementation).toBe("opfs-memory");
  expect(opfs.whenBusy).toBe("wait");
});

test("descriptors report actual ACKs, loss boundary, ownership, format and lifecycle", () => {
  const idb = getVfsDescriptor();
  expect(idb).toMatchObject({
    mode: "fast",
    implementation: "indexeddb",
    persistent: true,
    mutationAcknowledgement: "memory",
    durabilityPoint: "completed-durable-checkpoint",
    lossBound: "changes-after-last-completed-durable-checkpoint",
    pendingDataBound: "not-yet-enforced",
    multiTab: "exclusive-owner",
    defaultWhenBusy: "takeover",
    worker: "dedicated",
    serviceMayAwait: true,
    directSharedMemory: { reads: true, mutations: true },
    format: { id: INDEXEDDB_FORMAT },
  });
  expect(idb.durability).toEqual({
    flush: "checkpoint-data-and-metadata",
    fsync: "targeted-file-checkpoint",
    targetedFlush: "selected-payloads-and-namespace",
  });
  expect(idb.requirements).toContain("IndexedDB");
  expect(idb.lifecycle).toEqual(["opening", "waiting", "ready", "failed", "disposed"]);
  const opfs = resolveVfs({ mode: "fast" }, "opfs-memory").descriptor;
  expect(opfs.format?.id).toBe("waffle-opfs-snapshots-v1");
  expect(opfs.supportedWhenBusy).toEqual(["wait"]);
  expect(opfs.unsupportedSettings).toEqual(["whenBusy:takeover"]);
  expect(opfs.requirements).toContain("sync-access-handles");
  const memory = getVfsDescriptor("memory");
  expect(memory.persistent).toBe(false);
  expect(memory.format).toBeNull();
  expect(memory.multiTab).toBe("isolated");
  expect(memory.durabilityPoint).toBe("none");
  expect(memory.lossBound).toBe("all-changes");
  expect(memory.durability.flush).toBe("volatile-ordering-only");
  for (const descriptor of [idb, opfs, memory]) {
    expect(Object.isFrozen(descriptor)).toBe(true);
    const objects = Object.values(descriptor).filter((value) => value && typeof value === "object");
    expect(objects.every(Object.isFrozen)).toBe(true);
  }
});

for (const mode of ["safe", "indexeddb", "opfs-memory", "opfs-safe", "opfs-wal", "", "unknown"])
  test(`unsupported mode ${JSON.stringify(mode)} never falls back`, () => {
    expect(() => getVfsDescriptor(mode)).toThrow(VfsError);
    expect(caught(() => resolveVfs({ mode }))).toMatchObject({
      name: "VfsError",
      code: "UNSUPPORTED_VFS",
      vfs: mode,
    });
    expect(caught(() => new SharedFilesystem({ mode } as VfsSelection))).toMatchObject({
      code: "UNSUPPORTED_VFS",
      vfs: mode,
    });
  });

test("SAFE cannot be forced onto a FAST implementation by an internal override", () => {
  expect(caught(() => resolveVfs({ mode: "safe" }, "indexeddb"))).toMatchObject({
    code: "UNSUPPORTED_VFS",
    vfs: "safe",
  });
  expect(caught(() => resolveVfs({ mode: "fast" }, "memory"))).toMatchObject({
    code: "INVALID_VFS_SETTINGS",
  });
});

for (const options of [
  { whenBusy: "invalid" },
  { mode: "memory", whenBusy: "wait" },
  { mode: "memory", whenBusy: "takeover" },
])
  test(`invalid settings reject before worker allocation: ${JSON.stringify(options)}`, () => {
    expect(caught(() => new SharedFilesystem(options as VfsSelection))).toMatchObject({
      name: "VfsError",
      code: "INVALID_VFS_SETTINGS",
    });
  });

test("obsolete selectors reject rather than silently selecting FAST", () => {
  for (const options of [{ vfs: "opfs-memory" }, { storage: "opfs" }, { persistence: false }])
    expect(caught(() => new SharedFilesystem(options as VfsSelection))).toMatchObject({
      code: "INVALID_VFS_SETTINGS",
    });
});

test("internal implementation settings are validated before transport allocation", () => {
  const options = withVfsImplementation("opfs-memory", {
    mode: "fast",
    whenBusy: "takeover",
  } as const);
  expect(caught(() => new SharedFilesystem(options))).toMatchObject({
    code: "INVALID_VFS_SETTINGS",
    vfs: "opfs-memory",
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

for (const [options, code, identity] of [
  [{ mode: "safe" }, "UNSUPPORTED_VFS", "safe"],
  [
    { mode: "fast", implementation: "opfs-memory", whenBusy: "takeover" },
    "INVALID_VFS_SETTINGS",
    "opfs-memory",
  ],
  [{ mode: "fast" }, "UNSUPPORTED_VFS_CAPABILITY", "indexeddb"],
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
        vfs: identity,
      });
    } finally {
      worker.terminate();
    }
  });
