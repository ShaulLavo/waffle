import { expect, test } from "bun:test";
import { CHUNK_SIZE, preparePayload } from "../fs/indexeddb-chunks";
import { encodeRecord, encodeSnapshot, type PersistedIndex } from "../fs/storage";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format";
import {
  inspectNativePayloads,
  inspectNativeWorkspace,
  type NativeWorkspaceRecords,
} from "./persistent-native-inspection";

async function payload(bytes = new Uint8Array([10, 20, 30, 41, 42, 43, 44, 45])) {
  const prepared = await preparePayload(bytes);
  const keys: IDBValidKey[] = ["saved"];
  for (const index of prepared.chunks.keys()) keys.push(["saved", index]);
  const values: unknown[] = [prepared.manifest];
  return { bytes, prepared, keys, values: values.concat(prepared.chunks) };
}

async function workspace(): Promise<NativeWorkspaceRecords> {
  const data = await payload();
  const index: PersistedIndex = {
    version: 1,
    generation: 1,
    root: 1,
    nodes: [
      { ino: 1, kind: "dir", size: 0, mtime: 10, children: [["final", 2]] },
      { ino: 2, kind: "file", size: 8, mtime: 11, data: "saved" },
    ],
  };
  return {
    format: INDEXEDDB_FORMAT,
    epoch: 1,
    active: 2,
    snapshots: [await encodeSnapshot(index), undefined],
    journalKeys: [2],
    journals: [
      await encodeRecord({
        version: 1,
        previous: 1,
        generation: 2,
        root: 1,
        upserts: [{ ...index.nodes[1], mtime: 12 }],
        removes: [],
      }),
    ],
    keys: data.keys,
    values: data.values,
  };
}

test("native inspection reconstructs current v2 manifest and chunk records", async () => {
  const { bytes, prepared, keys, values } = await payload();
  const result = await inspectNativePayloads(keys, values);
  expect(result.payloads).toEqual([{ key: "saved", bytes: Array.from(bytes) }]);
  expect(result.physicalRecords).toEqual([
    { kind: "manifest", key: "saved", manifest: prepared.manifest },
    { kind: "chunk", key: ["saved", 0], length: 8, checksum: prepared.chunks[0]!.checksum },
  ]);
});

test("native inspection distinguishes logical payloads from empty and multichunk physical records", async () => {
  const empty = await payload(new Uint8Array());
  expect(await inspectNativePayloads(empty.keys, empty.values)).toEqual({
    payloads: [{ key: "saved", bytes: [] }],
    physicalRecords: [{ kind: "manifest", key: "saved", manifest: empty.prepared.manifest }],
  });
  const data = await payload(Uint8Array.from({ length: CHUNK_SIZE + 3 }, (_, i) => i % 251));
  const result = await inspectNativePayloads(data.keys, data.values);
  expect(result.payloads).toEqual([{ key: "saved", bytes: Array.from(data.bytes) }]);
  expect(result.physicalRecords).toEqual([
    { kind: "manifest", key: "saved", manifest: data.prepared.manifest },
    {
      kind: "chunk",
      key: ["saved", 0],
      length: CHUNK_SIZE,
      checksum: data.prepared.chunks[0]!.checksum,
    },
    { kind: "chunk", key: ["saved", 1], length: 3, checksum: data.prepared.chunks[1]!.checksum },
  ]);
});

test("native inspection rejects same-length byte corruption and wrong digest", async () => {
  const data = await payload();
  const chunk = data.prepared.chunks[0]!;
  const corrupt = { ...chunk, bytes: new Uint8Array(chunk.bytes) };
  corrupt.bytes[0] = corrupt.bytes[0]! ^ 1;
  await expect(inspectNativePayloads(data.keys, [data.prepared.manifest, corrupt])).rejects.toThrow(
    "checksum",
  );
  await expect(
    inspectNativePayloads(data.keys, [
      data.prepared.manifest,
      { ...chunk, checksum: "0".repeat(64) },
    ]),
  ).rejects.toThrow("checksum");
});

test("native inspection rejects missing, truncated and malformed chunks", async () => {
  const data = await payload();
  const chunk = data.prepared.chunks[0]!;
  await expect(inspectNativePayloads(["saved"], [data.prepared.manifest])).rejects.toThrow();
  await expect(
    inspectNativePayloads(data.keys, [
      data.prepared.manifest,
      { ...chunk, bytes: chunk.bytes.slice(1) },
    ]),
  ).rejects.toThrow();
  await expect(
    inspectNativePayloads(data.keys, [data.prepared.manifest, chunk.bytes]),
  ).rejects.toThrow();
  await expect(
    inspectNativePayloads(data.keys, [data.prepared.manifest, { ...chunk, checksum: "bad" }]),
  ).rejects.toThrow();
});

test("native inspection rejects missing manifests, orphan or extra chunks and duplicate keys", async () => {
  const data = await payload();
  await expect(inspectNativePayloads([["saved", 0]], [data.prepared.chunks[0]])).rejects.toThrow(
    "orphan",
  );
  await expect(
    inspectNativePayloads(
      data.keys.concat([["saved", 1]]),
      data.values.concat([data.prepared.chunks[0]]),
    ),
  ).rejects.toThrow("extra");
  await expect(
    inspectNativePayloads(
      data.keys.concat(["saved"]),
      data.values.concat([data.prepared.manifest]),
    ),
  ).rejects.toThrow("duplicate");
  await expect(inspectNativePayloads(data.keys, [data.prepared.manifest])).rejects.toThrow("count");
});

for (const key of ["", 1, ["saved", -1], ["saved", 0, 1], new Date(0)] satisfies IDBValidKey[]) {
  test(`native inspection rejects invalid physical key ${JSON.stringify(key)}`, async () => {
    await expect(inspectNativePayloads([key], [{}])).rejects.toThrow("payload key");
  });
}

test("native inspection rejects whole-value data and malformed current manifests", async () => {
  const data = await payload();
  await expect(inspectNativePayloads(["saved"], [data.bytes])).rejects.toThrow();
  for (const manifest of [
    { ...data.prepared.manifest, version: 1 },
    { ...data.prepared.manifest, size: -1 },
    { ...data.prepared.manifest, chunkSize: 1 },
    { ...data.prepared.manifest, count: 2 },
  ])
    await expect(
      inspectNativePayloads(data.keys, [manifest, data.prepared.chunks[0]]),
    ).rejects.toThrow();
});

test("native inspection recovers checksummed saved metadata at the active generation", async () => {
  const result = await inspectNativeWorkspace(await workspace());
  expect(result.format).toBe(INDEXEDDB_FORMAT);
  expect([result.epoch, result.active, result.generation]).toEqual([1, 2, 2]);
  expect(result.index.nodes.find((node) => node.ino === 2)?.mtime).toBe(12);
  expect(result.payloads[0]?.bytes).toEqual([10, 20, 30, 41, 42, 43, 44, 45]);
});

test("native inspection requires the current format, valid epoch and complete snapshot slots", async () => {
  const data = await workspace();
  for (const format of [undefined, "waffle-indexeddb-v1"])
    await expect(inspectNativeWorkspace({ ...data, format })).rejects.toThrow("format");
  for (const epoch of [0, -1, undefined])
    await expect(inspectNativeWorkspace({ ...data, epoch })).rejects.toThrow("epoch");
  await expect(inspectNativeWorkspace({ ...data, snapshots: [] })).rejects.toThrow("slots");
});

test("native inspection rejects corrupted snapshot and journal checksums", async () => {
  const data = await workspace();
  const broken = { json: "{}", checksum: "0".repeat(64) };
  await expect(inspectNativeWorkspace({ ...data, snapshots: [broken, undefined] })).rejects.toThrow(
    "snapshot",
  );
  await expect(inspectNativeWorkspace({ ...data, journals: [broken] })).rejects.toThrow("journal");
});

test("native inspection never masks a missing journal, gap or stale active marker by recovering older metadata", async () => {
  const data = await workspace();
  await expect(inspectNativeWorkspace({ ...data, journalKeys: [], journals: [] })).rejects.toThrow(
    "not recoverable",
  );
  await expect(inspectNativeWorkspace({ ...data, active: 1 })).rejects.toThrow("not recoverable");
  await expect(inspectNativeWorkspace({ ...data, active: -1 })).rejects.toThrow("active");
  const gap = await encodeRecord({
    version: 1,
    previous: 2,
    generation: 3,
    root: 1,
    upserts: [],
    removes: [],
  });
  await expect(
    inspectNativeWorkspace({ ...data, active: 3, journalKeys: [3], journals: [gap] }),
  ).rejects.toThrow("not recoverable");
});

test("native inspection rejects invalid journal keys, duplicate generations and malformed entries", async () => {
  const data = await workspace();
  await expect(inspectNativeWorkspace({ ...data, journalKeys: [] })).rejects.toThrow("count");
  await expect(inspectNativeWorkspace({ ...data, journalKeys: [3] })).rejects.toThrow("key");
  await expect(
    inspectNativeWorkspace({
      ...data,
      journalKeys: [2, 2],
      journals: data.journals.concat(data.journals),
    }),
  ).rejects.toThrow("duplicate");
  const malformed = await encodeRecord({
    version: 1,
    previous: 2,
    generation: 2,
    root: 1,
    upserts: [],
    removes: [],
  });
  await expect(inspectNativeWorkspace({ ...data, journals: [malformed] })).rejects.toThrow(
    "journal",
  );
  const duplicates = await encodeRecord({
    version: 1,
    previous: 1,
    generation: 2,
    root: 1,
    upserts: [],
    removes: [2, 2],
  });
  await expect(inspectNativeWorkspace({ ...data, journals: [duplicates] })).rejects.toThrow(
    "duplicate journal inode",
  );
});

test("native inspection rejects absent payloads and checksummed metadata with wrong payload size", async () => {
  const data = await workspace();
  await expect(inspectNativeWorkspace({ ...data, keys: [], values: [] })).rejects.toThrow(
    "missing payload",
  );
  const wrongSize = await encodeRecord({
    version: 1,
    previous: 1,
    generation: 2,
    root: 1,
    upserts: [{ ino: 2, kind: "file", mtime: 12, size: 7, data: "saved" }],
    removes: [],
  });
  await expect(inspectNativeWorkspace({ ...data, journals: [wrongSize] })).rejects.toThrow(
    "size mismatch",
  );
});
