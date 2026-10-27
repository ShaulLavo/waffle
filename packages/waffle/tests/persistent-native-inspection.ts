import {
  chunkChecksum,
  chunkLength,
  parseChunk,
  parseManifest,
  type ChunkManifest,
} from "../fs/indexeddb-chunks";
import { recoverIndex } from "../fs/indexeddb";
import {
  decodeRecord,
  decodeSnapshot,
  validInteger,
  validatePersistedNode,
  type PersistedNode,
} from "../fs/storage";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format";

type Journal =
  Parameters<typeof recoverIndex>[1] extends ReadonlyMap<number, infer Entry> ? Entry : never;
type PhysicalRecord =
  | { kind: "manifest"; key: string; manifest: ChunkManifest }
  | { kind: "chunk"; key: [string, number]; length: number; checksum: string };
export interface NativeWorkspaceRecords {
  format: unknown;
  epoch: unknown;
  active: unknown;
  snapshots: readonly unknown[];
  journalKeys: readonly IDBValidKey[];
  journals: readonly unknown[];
  keys: readonly IDBValidKey[];
  values: readonly unknown[];
}
function invalid(message: string): never {
  throw new Error(`Invalid native IndexedDB inspection: ${message}`);
}
function nativeKey(key: IDBValidKey): string | [string, number] {
  if (typeof key === "string" && key) return key;
  if (
    !Array.isArray(key) ||
    key.length !== 2 ||
    typeof key[0] !== "string" ||
    !key[0] ||
    !validInteger(key[1])
  )
    invalid("payload key");
  return [key[0], key[1]];
}
export async function inspectNativePayloads(
  keys: readonly IDBValidKey[],
  values: readonly unknown[],
) {
  if (keys.length !== values.length) invalid("payload key/value count");
  const records = new Map<string, unknown>();
  const manifests = new Map<string, ChunkManifest>();
  for (const [index, key] of keys.entries()) {
    const parsed = nativeKey(key),
      identity = JSON.stringify(parsed);
    if (records.has(identity)) invalid("duplicate payload key");
    records.set(identity, values[index]);
    if (typeof parsed === "string") manifests.set(parsed, parseManifest(values[index], parsed));
  }
  let physicalRecords: PhysicalRecord[] = [];
  const payloads: { key: string; bytes: number[] }[] = [];
  let consumed = 0;
  for (const [key, manifest] of manifests) {
    const decoded = await readPayload(key, manifest, records);
    consumed += 1 + manifest.count;
    physicalRecords = physicalRecords.concat(decoded.physicalRecords);
    payloads.push({ key, bytes: decoded.bytes });
  }
  if (consumed !== records.size) invalid("orphan or extra chunk");
  return { payloads, physicalRecords };
}
async function readPayload(
  key: string,
  manifest: ChunkManifest,
  records: ReadonlyMap<string, unknown>,
) {
  if (manifest.count > records.size) invalid(`missing chunks for ${key}`);
  const physicalRecords: PhysicalRecord[] = [{ kind: "manifest", key, manifest }];
  const bytes = new Uint8Array(manifest.size);
  for (let index = 0; index < manifest.count; index++) {
    const chunk = parseChunk(
      records.get(JSON.stringify([key, index])),
      chunkLength(manifest, index),
      key,
    );
    if ((await chunkChecksum(chunk.bytes)) !== chunk.checksum)
      invalid(`chunk checksum ${key}:${index}`);
    bytes.set(chunk.bytes, index * manifest.chunkSize);
    physicalRecords.push({
      kind: "chunk",
      key: [key, index],
      length: chunk.bytes.length,
      checksum: chunk.checksum,
    });
  }
  return { bytes: Array.from(bytes), physicalRecords };
}
function journal(value: unknown): Journal {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("previous" in value) ||
    !validInteger(value.previous) ||
    !("generation" in value) ||
    !validInteger(value.generation) ||
    value.generation <= value.previous ||
    !("root" in value) ||
    !validInteger(value.root) ||
    !("upserts" in value) ||
    !Array.isArray(value.upserts) ||
    !("removes" in value) ||
    !Array.isArray(value.removes)
  )
    invalid("journal shape or checksum");
  const upserts = value.upserts.map((node: unknown) => {
    validatePersistedNode(node);
    return node;
  });
  const removes = value.removes.map((ino: unknown) => {
    if (!validInteger(ino)) invalid("journal removed inode");
    return ino;
  });
  const inodes = upserts.map((node) => node.ino).concat(removes);
  if (new Set(inodes).size !== inodes.length) invalid("duplicate journal inode");
  return {
    version: 1,
    previous: value.previous,
    generation: value.generation,
    root: value.root,
    upserts,
    removes,
  };
}
function references(nodes: readonly PersistedNode[], sizes: ReadonlyMap<string, number>): void {
  for (const node of nodes) {
    if (node.data === undefined) continue;
    if (sizes.get(node.data) !== node.size)
      invalid(`missing payload or size mismatch ${node.data}`);
  }
}
export async function inspectNativeWorkspace(input: NativeWorkspaceRecords) {
  if (input.format !== INDEXEDDB_FORMAT) invalid("current format marker");
  if (!validInteger(input.epoch) || !input.epoch) invalid("writer epoch");
  if (!validInteger(input.active)) invalid("active generation");
  if (input.snapshots.length !== 2) invalid("snapshot slots");
  if (input.journalKeys.length !== input.journals.length) invalid("journal key/value count");
  const data = await inspectNativePayloads(input.keys, input.values);
  const sizes = new Map(data.payloads.map((payload) => [payload.key, payload.bytes.length]));
  const bases = await Promise.all(
    input.snapshots.map(async (raw) => {
      const base = await decodeSnapshot(raw);
      if (raw !== undefined && !base) invalid("snapshot checksum or shape");
      if (base) references(base.nodes, sizes);
      return base;
    }),
  );
  const journals = new Map<number, Journal>();
  for (const [index, raw] of input.journals.entries()) {
    const entry = journal(await decodeRecord(raw));
    if (input.journalKeys[index] !== entry.generation || journals.has(entry.generation))
      invalid("journal key or duplicate generation");
    references(entry.upserts, sizes);
    journals.set(entry.generation, entry);
  }
  const index = recoverIndex(bases, journals, new Set(sizes.keys()));
  if (!index || index.generation !== input.active) invalid("active generation not recoverable");
  return {
    format: input.format,
    epoch: input.epoch,
    active: input.active,
    generation: index.generation,
    index,
    ...data,
  };
}
