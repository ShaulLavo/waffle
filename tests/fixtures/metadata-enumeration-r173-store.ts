import {
  nextReservation,
  storeReservation,
  type StoredReservation,
} from "../../fs/file-identity.js";
import {
  decodeSnapshot,
  encodeSnapshot,
  snapshotBatch,
  type StorageBackend,
  type PersistenceBatch,
} from "../../fs/storage.js";
import { fixturePayloadHooks } from "./publication-storage.js";

export class MetadataStore implements StorageBackend {
  private reservation?: StoredReservation;
  private snapshot?: Awaited<ReturnType<typeof encodeSnapshot>>;
  readonly payloads = new Map<string, Uint8Array>();
  readonly readRange = fixturePayloadHooks(this.payloads).readRange;
  readonly retainPayload = fixturePayloadHooks(this.payloads).retainPayload;
  async reserveIdentity(workspace?: string) {
    const reservation = nextReservation(this.reservation, workspace);
    this.reservation = storeReservation(reservation);
    return reservation;
  }
  async load() {
    return this.snapshot && decodeSnapshot(this.snapshot);
  }
  async read(key: string) {
    const bytes = this.payloads.get(key);
    if (!bytes) throw new Error("missing metadata fixture payload");
    return bytes.slice();
  }
  async persist(input: PersistenceBatch) {
    const batch = snapshotBatch(input);
    const previous = await this.load();
    const nodes = new Map(previous?.nodes.map((node) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, node);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, bytes] of batch.data) this.payloads.set(key, bytes);
    this.snapshot = await encodeSnapshot({
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
      ...(batch.publication ? { publication: batch.publication } : {}),
    });
  }
  async flush() {}
  async close() {}
}
