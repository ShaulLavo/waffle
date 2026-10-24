import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent.js";
import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity.js";
import {
  decodeSnapshot,
  encodeSnapshot,
  snapshotBatch,
  type PersistenceBatch,
  type PersistedIndex,
  type StorageBackend,
} from "../fs/storage.js";
import { fixturePayloadHooks } from "./fixtures/publication-storage.js";
import type { ResolvedPath } from "../core/filesystem.js";

class SnapshotStore implements StorageBackend {
  private reservation?: StoredReservation;
  private index?: PersistedIndex;
  readonly payloads = new Map<string, Uint8Array>();
  readonly readRange = fixturePayloadHooks(this.payloads).readRange;
  readonly retainPayload = fixturePayloadHooks(this.payloads).retainPayload;
  async reserveIdentity(workspace?: string) {
    const next = nextReservation(this.reservation, workspace);
    this.reservation = storeReservation(next);
    return next;
  }
  async load() {
    return this.index && decodeSnapshot(await encodeSnapshot(this.index));
  }
  async read(key: string) {
    const payload = this.payloads.get(key);
    if (!payload) throw new Error("missing fixture payload");
    return payload.slice();
  }
  async persist(input: PersistenceBatch) {
    const batch = snapshotBatch(input);
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, node);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, bytes] of batch.data) this.payloads.set(key, bytes);
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush() {}
  async close() {}
}

function path(backend: PersistentBackend, value: string): ResolvedPath {
  const found = backend.fs.resolveAbsolute(value);
  if (typeof found === "number") throw new Error(`resolve failed ${found}`);
  return found;
}

function createLink(backend: PersistentBackend, name: string, target: string) {
  expect(backend.execute("symlink", [path(backend, name), target], new Uint8Array())).toBe(0);
}

function readFile(backend: PersistentBackend, name: string): string {
  const value = backend.execute("readFile", [name], new Uint8Array());
  if (!(value instanceof Uint8Array)) throw new Error("expected file bytes");
  return new TextDecoder().decode(value);
}

test("actual persistent backend checkpoints raw links and reloads live targets without copied packages", async () => {
  const store = new SnapshotStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    backend.execute("writeFile", ["/packages/member/index.ts"], new TextEncoder().encode("before"));
    backend.execute("mkdirp", ["/node_modules"], new Uint8Array());
    createLink(backend, "/node_modules/member", "../packages/member");
    createLink(backend, "/dangling", "missing");
    createLink(backend, "/cycle-a", "cycle-b");
    createLink(backend, "/cycle-b", "cycle-a");
    expect(readFile(backend, "/node_modules/member/index.ts")).toBe("before");
    backend.execute("writeFile", ["/packages/member/index.ts"], new TextEncoder().encode("after"));
    expect(readFile(backend, "/node_modules/member/index.ts")).toBe("after");
    await backend.flush();
  } finally {
    await backend.close();
  }
  const reopened = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    await reopened.prepare("readFile", ["/node_modules/member/index.ts"]);
    expect(readFile(reopened, "/node_modules/member/index.ts")).toBe("after");
    const link = path(reopened, "/node_modules/member");
    expect(reopened.execute("stat", [link.node], new Uint8Array())).toMatchObject({
      kind: "symlink",
    });
    expect(reopened.execute("readlink", [link.node], new Uint8Array())).toBe("../packages/member");
    expect(reopened.execute("readlink", [path(reopened, "/dangling").node], new Uint8Array())).toBe(
      "missing",
    );
    expect(reopened.execute("readlink", [path(reopened, "/cycle-a").node], new Uint8Array())).toBe(
      "cycle-b",
    );
  } finally {
    await reopened.close();
  }
});

test("actual persistent backend checkpoint fixture preserves ordinary files across reload", async () => {
  const store = new SnapshotStore();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    backend.execute("writeFile", ["/file"], new TextEncoder().encode("persisted"));
    await backend.flush();
  } finally {
    await backend.close();
  }
  const reopened = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    await reopened.prepare("readFile", ["/file"]);
    expect(readFile(reopened, "/file")).toBe("persisted");
  } finally {
    await reopened.close();
  }
});
