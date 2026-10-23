import { CHUNK_SIZE } from "../fs/indexeddb-chunks.js";
import { PersistentBackend } from "../fs/persistent.js";
import { FilesystemError } from "../core/filesystem.js";
import type {
  PersistedIndex,
  PersistedNode,
  PersistenceBatch,
  StorageBackend,
} from "../fs/storage.js";
import {
  QuotaProbe,
  type AdapterKind,
  type Inventory,
  type NativeCounts,
  type Fault,
} from "./storage-quota-r2-probes.js";

export const quotaCases = [
  "churn",
  "payload-quota",
  "commit",
  "recovery-root",
  "checkpoint-debt",
] as const;
export type QuotaCase = (typeof quotaCases)[number] | "cleanup-retry";
export const churnSaves = 96;
const payloadSize = 65_553;
type Observation = {
  phase: string;
  generation: number;
  inventory: Inventory;
  native: NativeCounts;
  elapsedMs: number;
};
export interface QuotaReceipt {
  backend: AdapterKind;
  cell: QuotaCase;
  observations: Observation[];
  failures: string[];
  cleanup: boolean;
  highWater: Record<string, number>;
  debt: ReturnType<PersistentBackend["checkpointPressure"]>[];
  finalNative?: NativeCounts;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function expected(key: string): Uint8Array {
  let seed = 0x51f15e;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16_777_619);
  return Uint8Array.from(
    { length: payloadSize },
    (_, index) => (seed + Math.imul(index, 31)) & 255,
  );
}
function revision(generation: number, prefix = "churn"): PersistenceBatch {
  const children: [string, number][] = [
    ["anchor", 2],
    [generation % 3 ? "renamed" : "value", 3],
  ];
  const main = `${prefix}:${generation}`;
  const upserts: PersistedNode[] = [
    { ino: 1, kind: "dir", mtime: generation, size: 0, children },
    { ino: 2, kind: "file", mtime: 1, size: payloadSize, data: "anchor" },
    { ino: 3, kind: "file", mtime: generation, size: payloadSize, data: main },
  ];
  const data = new Map([[main, expected(main)]]);
  if (generation === 1) data.set("anchor", expected("anchor"));
  if (generation % 2) {
    const temporary = `${prefix}:temporary:${generation}`;
    children.push(["temporary", 4]);
    upserts.push({ ino: 4, kind: "file", mtime: generation, size: payloadSize, data: temporary });
    data.set(temporary, expected(temporary));
  }
  return { generation, root: 1, upserts, removes: generation % 2 ? [] : [4], data };
}
type RootImage = { index: PersistedIndex; data: Map<string, Uint8Array> };
function ordered(index: PersistedIndex): PersistedIndex {
  return { ...index, nodes: index.nodes.toSorted((a, b) => a.ino - b.ino) };
}
async function captureRoot(storage: StorageBackend): Promise<RootImage> {
  const index = structuredClone(await storage.load());
  assert(index, "checkpoint root absent");
  const data = new Map<string, Uint8Array>();
  for (const node of index.nodes) {
    if (node.data === undefined) continue;
    data.set(node.data, new Uint8Array(await storage.read(node.data)));
  }
  return { index, data };
}
async function verifyImage(storage: StorageBackend, wanted: RootImage): Promise<PersistedIndex> {
  const index = await storage.load();
  assert(index, "selected root absent");
  assert(
    JSON.stringify(ordered(index)) === JSON.stringify(ordered(wanted.index)),
    `generation ${wanted.index.generation} complete root differs`,
  );
  for (const [key, target] of wanted.data) {
    const bytes = await storage.read(key);
    assert(
      bytes.length === target.length && bytes.every((value, i) => value === target[i]),
      `payload ${key} changed`,
    );
  }
  return index;
}
function candidateRoot(before: RootImage, batch: PersistenceBatch): RootImage {
  const nodes = new Map(before.index.nodes.map((node) => [node.ino, structuredClone(node)]));
  for (const ino of batch.removes) nodes.delete(ino);
  for (const node of batch.upserts) nodes.set(node.ino, structuredClone(node));
  const data = new Map(before.data);
  for (const [key, bytes] of batch.data) data.set(key, new Uint8Array(bytes));
  const selected = new Set(Array.from(nodes.values(), (node) => node.data));
  for (const key of data.keys()) if (!selected.has(key)) data.delete(key);
  return {
    index: {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    },
    data,
  };
}
function verifyValue(image: RootImage, path: string, text: string): void {
  const root = image.index.nodes.find((node) => node.ino === image.index.root);
  assert(root?.kind === "dir", "candidate root is not a directory");
  const ino = root.children?.find(([name]) => name === path)?.[1];
  const node = image.index.nodes.find((entry) => entry.ino === ino);
  assert(node?.kind === "file" && node.data !== undefined, `candidate /${path} absent`);
  const bytes = image.data.get(node.data);
  const target = new TextEncoder().encode(text);
  assert(
    bytes?.length === target.length && bytes.every((value, i) => value === target[i]),
    `candidate /${path} bytes differ`,
  );
}
async function verifyRoot(
  storage: StorageBackend,
  generation: number,
  prefix = "churn",
): Promise<PersistedIndex> {
  const wanted = revision(generation, prefix);
  return verifyImage(storage, {
    index: { version: 1, generation, root: wanted.root, nodes: wanted.upserts },
    data: new Map(
      wanted.upserts.flatMap<[string, Uint8Array]>((node) =>
        node.data === undefined ? [] : [[node.data, expected(node.data)]],
      ),
    ),
  });
}
async function rejected(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("unexpected successful acknowledgement");
}
async function retainedFailure(action: Promise<unknown>, failure: unknown): Promise<void> {
  assert(Object.is(await rejected(action), failure), "flush did not retain the save failure");
}
function verifyFault(probe: QuotaProbe, fault: Exclude<Fault, "cleanup">, error: unknown): void {
  const injected = probe.failure;
  assert(injected?.fault === fault, "expected native fault was not injected");
  if (fault === "payload-quota")
    assert(
      injected.reason instanceof DOMException && injected.reason.name === "QuotaExceededError",
      "injected quota fault has the wrong category",
    );
  if (probe.kind === "indexeddb") {
    assert(Object.is(error, injected.reason), "IndexedDB did not propagate the injected fault");
    return;
  }
  assert(
    error instanceof Error &&
      "code" in error &&
      error.code === (fault === "payload-quota" ? "ENOSPC" : "EIO") &&
      Object.is(error.cause, injected.reason),
    "OPFS did not preserve the fault code and injected cause",
  );
}
async function writeCheckpoint(
  backend: PersistentBackend,
  text: string,
  path = "/value",
): Promise<void> {
  const args = [path, false, false];
  await backend.prepare("writeFile", args);
  await backend.execute("writeFile", args, new TextEncoder().encode(text));
}
class Scenario {
  readonly receipt: QuotaReceipt;
  readonly probe: QuotaProbe;
  private started = performance.now();
  constructor(backend: AdapterKind, cell: QuotaCase) {
    this.receipt = {
      backend,
      cell,
      observations: [],
      failures: [],
      cleanup: false,
      highWater: {},
      debt: [],
    };
    this.probe = new QuotaProbe(
      backend,
      `quota-r2-${cell}-${crypto.randomUUID()}`,
      cell === "churn" ? 4 : 1,
    );
  }
  async observe(phase: string, generation: number): Promise<Inventory> {
    const inventory = await this.probe.inspect();
    const native = { ...this.probe.counts };
    this.receipt.observations.push({
      phase,
      generation,
      inventory,
      native,
      elapsedMs: performance.now() - this.started,
    });
    globalThis.postMessage({ progress: this.receipt.observations.at(-1) });
    this.highWater("payloadRecords", inventory.payloadRecords);
    this.highWater("payloadBytes", inventory.payloadBytes);
    this.highWater("journalRecords", inventory.journalRecords);
    this.highWater("orphanPayloads", inventory.orphanPayloads.length);
    this.highWater("nativeHandles", native.peakHandles);
    this.highWater("nativeTransactions", native.peakTransactions);
    return inventory;
  }
  highWater(key: string, value: number): void {
    this.receipt.highWater[key] = Math.max(this.receipt.highWater[key] ?? 0, value);
  }
  debt(backend: PersistentBackend): ReturnType<PersistentBackend["checkpointPressure"]> {
    const debt = backend.checkpointPressure();
    this.receipt.debt.push(debt);
    this.highWater("checkpointBytes", debt.pendingBytes);
    this.highWater("checkpointOperations", debt.pendingOperations);
    return debt;
  }
  assertBounded(inventory: Inventory, compactEvery = this.probe.compactEvery): void {
    const payloadLimit = this.probe.kind === "opfs" ? 5 : 1 + compactEvery * 4;
    const multiplier = this.probe.kind === "indexeddb" ? 3 : 1;
    assert(
      inventory.payloadRecords <= payloadLimit * multiplier,
      `unbounded physical data records ${inventory.payloadRecords}`,
    );
    assert(
      inventory.payloadBytes <= payloadLimit * payloadSize,
      `unbounded physical payload bytes ${inventory.payloadBytes}`,
    );
    assert(
      inventory.payloadBytes === inventory.payloads.length * payloadSize,
      "physical payload byte inventory differs from immutable records",
    );
    if (this.probe.kind === "indexeddb")
      assert(
        inventory.chunkRecords === inventory.payloads.length * Math.ceil(payloadSize / CHUNK_SIZE),
        "manifest/chunk record inventory differs",
      );
    assert(
      this.probe.counts.peakHandles <= 6,
      "native sync handles exceeded cache plus create/metadata budgets",
    );
    assert(
      inventory.journalRecords < compactEvery * 2,
      `unbounded journal debt ${inventory.journalRecords}`,
    );
    assert(inventory.bases.length <= 2, `more than two recovery bases: ${inventory.bases}`);
    assert(
      inventory.orphanPayloads.length === 0,
      `uncollected orphan payloads: ${inventory.orphanPayloads}`,
    );
    assert(
      this.probe.counts.transactions === 0,
      "commit returned with a write transaction outstanding",
    );
    assert(this.probe.counts.handles <= 4, "commit retained more handles than cache budget");
  }
  async save(storage: StorageBackend, generation: number, prefix = "churn"): Promise<void> {
    await storage.persist(revision(generation, prefix));
    await storage.flush();
    const inventory = await this.observe("saved", generation);
    this.assertBounded(inventory);
    await verifyRoot(storage, generation, prefix);
  }
  async churn(): Promise<void> {
    let storage = await this.probe.open();
    let collections = 0;
    let prior: string[] = [];
    for (let generation = 1; generation <= churnSaves; generation++) {
      await this.save(storage, generation);
      const current = this.receipt.observations.at(-1)!.inventory.payloads;
      const removed = prior.filter((key) => !current.includes(key));
      if (removed.length) collections++;
      prior = current;
      if (generation % 16 !== 0) continue;
      await this.probe.close(storage);
      const start = performance.now();
      storage = await this.probe.open();
      await verifyRoot(storage, generation);
      this.highWater("reopenMs", performance.now() - start);
      await this.observe("reopened", generation);
    }
    this.highWater("collectionRounds", collections);
    assert(
      collections >= 10,
      `cleanup was not repeated, observed ${collections} physical key removals`,
    );
    assert(this.probe.counts.deletes > 0, "no native deletions observed");
  }
  async failedSave(fault: Exclude<Fault, "cleanup">): Promise<void> {
    let storage = await this.probe.open();
    for (let generation = 1; generation <= 6; generation++) await this.save(storage, generation);
    const before = await this.observe("before-failure", 6);
    this.probe.fault = fault;
    const failure = await rejected(storage.persist(revision(7)));
    verifyFault(this.probe, fault, failure);
    await retainedFailure(storage.flush(), failure);
    this.probe.fault = undefined;
    const after = await this.observe("failed-save", 6);
    assert(this.probe.counts.faultHits > 0, "fault did not hit the native write boundary");
    assert(
      JSON.stringify(before.payloads.toSorted()) === JSON.stringify(after.payloads.toSorted()),
      "failed save leaked physical payload records",
    );
    assert(
      after.payloadBytes === before.payloadBytes,
      "failed save changed physical payload byte debt",
    );
    await verifyRoot(storage, 6);
    await this.probe.close(storage);
    storage = await this.probe.open();
    await verifyRoot(storage, 6);
    const reopened = await this.observe("reopened-after-failure", 6);
    assert(!reopened.payloads.includes("churn:7"), "failed payload became durable before retry");
    await this.save(storage, 7);
    await this.probe.close(storage);
    storage = await this.probe.open();
    await verifyRoot(storage, 7);
    for (let generation = 8; generation <= 16; generation++) await this.save(storage, generation);
  }
  async recoveryRoot(): Promise<void> {
    let storage = await this.probe.open();
    for (let generation = 1; generation <= 8; generation++) await this.save(storage, generation);
    await this.probe.close(storage);
    await this.probe.removeLatest();
    storage = await this.probe.open();
    const selected = await verifyRoot(storage, 7);
    await this.observe("selected-recovery-root", 7);
    await storage.persist(revision(9, "replacement"));
    await storage.flush();
    const inventory = await this.observe("after-recovery-save", 9);
    for (const node of selected.nodes) {
      if (!node.data) continue;
      assert(
        inventory.payloads.includes(node.data),
        `selected recovery payload collected: ${node.data}`,
      );
      const target = expected(node.data);
      assert(
        (await storage.read(node.data)).every((byte, i) => byte === target[i]),
        `recovery payload changed: ${node.data}`,
      );
    }
    await this.probe.close(storage);
    await this.probe.removeLatest();
    storage = await this.probe.open();
    await verifyRoot(storage, 7);
    await this.observe("selected-root-proven-by-second-recovery", 7);
    for (let generation = 10; generation <= 20; generation++)
      await this.save(storage, generation, "replacement");
  }
  async cleanupRetry(): Promise<void> {
    assert(this.probe.kind === "opfs", "cleanup retry uses OPFS post-publication collector");
    const storage = await this.probe.open();
    await this.save(storage, 1);
    await this.save(storage, 2);
    for (const start of [3, 9]) {
      this.probe.fault = "cleanup";
      for (let generation = start; generation < start + 3; generation++) {
        await storage.persist(revision(generation));
        await storage.flush();
        await this.observe("cleanup-denied-but-save-acknowledged", generation);
        await verifyRoot(storage, generation);
      }
      this.probe.fault = undefined;
      const denied = this.receipt.observations.at(-1)!.inventory;
      assert(
        denied.orphanPayloads.length > 0 && denied.bases.length > 2,
        "cleanup denial did not accumulate observable physical debt",
      );
      await this.save(storage, start + 3);
      await this.save(storage, start + 4);
      await this.save(storage, start + 5);
    }
    assert(this.probe.counts.faultHits >= 6, "cleanup retry fault was not repeated");
  }
  async checkpointDebt(): Promise<void> {
    const storage = await this.probe.open();
    const backend = await PersistentBackend.open(storage, {
      intervalMs: 0,
      checkpointLimits: { maxOperations: 2 },
    });
    let candidate: RootImage | undefined;
    let submissions = 0;
    try {
      await writeCheckpoint(backend, "unchanged sibling bytes", "/anchor");
      await writeCheckpoint(backend, "old acknowledged bytes");
      await backend.flush();
      const baseline = await storage.load();
      assert(baseline, "baseline checkpoint absent");
      await this.slowCheckpoints(backend);
      const beforeFailure = await captureRoot(storage);
      assert(
        beforeFailure.index.generation === baseline.generation + 2,
        "slow saves did not commit exactly twice",
      );
      verifyValue(beforeFailure, "value", "slow second bytes");
      verifyValue(beforeFailure, "anchor", "unchanged sibling bytes");
      const persist = storage.persist.bind(storage);
      storage.persist = (batch) => {
        candidate = candidateRoot(beforeFailure, batch);
        submissions++;
        return persist(batch);
      };
      await writeCheckpoint(backend, "failed candidate bytes");
      this.probe.fault = "commit";
      const failed = backend.flush();
      const pending = this.debt(backend);
      assert(
        pending.pendingOperations === 1 && pending.pendingBytes > 0,
        "captured checkpoint debt was not observed",
      );
      const failure = await rejected(failed);
      verifyFault(this.probe, "commit", failure);
      this.probe.fault = undefined;
      await this.observe("failed-checkpoint", beforeFailure.index.generation);
      const idle = this.debt(backend);
      assert(
        idle.pendingOperations === 0 && idle.pendingBytes === 0 && idle.pendingMetadataBytes === 0,
        "failed checkpoint retained capture debt",
      );
      await verifyImage(storage, beforeFailure);
      await retainedFailure(storage.flush(), failure);
      await backend.flush();
      assert(submissions === 2 && candidate, "retry did not submit exactly one new candidate root");
      const saved = await verifyImage(storage, candidate);
      assert(
        saved.generation === beforeFailure.index.generation + 1,
        "retry did not advance exactly one durable generation",
      );
      verifyValue(candidate, "value", "failed candidate bytes");
      verifyValue(candidate, "anchor", "unchanged sibling bytes");
      const idleAfterRetry = this.debt(backend);
      assert(
        idleAfterRetry.pendingOperations === 0 && idleAfterRetry.pendingBytes === 0,
        "retry retained checkpoint debt",
      );
      await backend.close();
    } finally {
      this.probe.fault = undefined;
      backend.dispose();
    }
    assert(candidate, "retry candidate absent");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const reopened = await this.probe.open();
      await verifyImage(reopened, candidate);
      await this.observe(`checkpoint-retry-reopened-${attempt}`, candidate.index.generation);
      await this.probe.close(reopened);
    }
  }
  private async slowCheckpoints(backend: PersistentBackend): Promise<void> {
    const gate = this.probe.pause();
    const pending: Promise<void>[] = [];
    try {
      await writeCheckpoint(backend, "slow first bytes");
      pending.push(backend.flush());
      await gate.started;
      await writeCheckpoint(backend, "slow second bytes");
      pending.push(backend.flush());
      const debt = this.debt(backend);
      assert(
        debt.pendingOperations === 2 && debt.queuedOperations === 1,
        "slow storage did not hold one running and one queued checkpoint",
      );
      const pressure = await rejected(backend.flush());
      assert(
        pressure instanceof FilesystemError && pressure.errno === 6,
        "wrong checkpoint pressure error",
      );
      assert(
        this.debt(backend).pendingBytes === debt.pendingBytes,
        "rejected checkpoint added capture debt",
      );
    } finally {
      gate.release();
      await Promise.all(pending);
    }
    assert(this.debt(backend).pendingOperations === 0, "slow checkpoints did not drain");
  }
  async run(): Promise<QuotaReceipt> {
    try {
      this.probe.install();
      await this.execute();
    } catch (error) {
      this.receipt.failures.push(
        error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
      );
    } finally {
      try {
        await this.probe.destroy();
        this.receipt.cleanup = true;
        this.receipt.finalNative = { ...this.probe.counts };
      } catch (error) {
        this.receipt.failures.push(`cleanup: ${String(error)}`);
      }
    }
    return this.receipt;
  }
  private execute(): Promise<void> {
    switch (this.receipt.cell) {
      case "churn":
        return this.churn();
      case "payload-quota":
        return this.failedSave("payload-quota");
      case "commit":
        return this.failedSave("commit");
      case "recovery-root":
        return this.recoveryRoot();
      case "cleanup-retry":
        return this.cleanupRetry();
      case "checkpoint-debt":
        return this.checkpointDebt();
    }
  }
}
export function runQuotaCase(backend: AdapterKind, cell: QuotaCase): Promise<QuotaReceipt> {
  return new Scenario(backend, cell).run();
}
