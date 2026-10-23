import { PersistentBackend } from "../fs/persistent.js";
import type { PersistedIndex, PersistedNode, PersistenceBatch, StorageBackend } from "../fs/storage.js";
import { QuotaProbe, type AdapterKind, type Inventory, type NativeCounts, type Fault } from "./storage-quota-r2-probes.js";

export const quotaCases = ["churn", "payload-quota", "commit", "recovery-root", "checkpoint-debt"] as const;
export type QuotaCase = typeof quotaCases[number] | "cleanup-retry";
export const churnSaves = 96;
const payloadSize = 65_553;
type Observation = { phase: string; generation: number; inventory: Inventory; native: NativeCounts; elapsedMs: number };
export interface QuotaReceipt {
  backend: AdapterKind;
  cell: QuotaCase;
  observations: Observation[];
  failures: string[];
  cleanup: boolean;
  highWater: Record<string, number>;
  debt: ReturnType<PersistentBackend["checkpointPressure"]>[];
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function expected(key: string): Uint8Array {
  let seed = 0x51f15e;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16_777_619);
  return Uint8Array.from({ length: payloadSize }, (_, index) => (seed + Math.imul(index, 31)) & 255);
}
function revision(generation: number, prefix = "churn"): PersistenceBatch {
  const children: [string, number][] = [["anchor", 2], [generation % 3 ? "renamed" : "value", 3]];
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
async function verifyRoot(storage: StorageBackend, generation: number, prefix = "churn"): Promise<PersistedIndex> {
  const index = await storage.load();
  assert(index?.generation === generation, `selected generation ${index?.generation}, expected ${generation}`);
  const wanted = revision(generation, prefix);
  assert(JSON.stringify(index.nodes.toSorted((a, b) => a.ino - b.ino)) === JSON.stringify(wanted.upserts), `generation ${generation} namespace differs`);
  for (const node of index.nodes) {
    if (!node.data) continue;
    const bytes = await storage.read(node.data);
    const target = expected(node.data);
    assert(bytes.length === target.length && bytes.every((value, i) => value === target[i]), `payload ${node.data} changed`);
  }
  return index;
}
async function rejected(action: Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await action;
  } catch (error) {
    assert(match.test(String(error)), `wrong rejection ${String(error)}, expected ${match}`);
    return;
  }
  throw new Error(`unexpected successful acknowledgement, expected ${match}`);
}
class Scenario {
  readonly receipt: QuotaReceipt;
  readonly probe: QuotaProbe;
  private started = performance.now();
  constructor(backend: AdapterKind, cell: QuotaCase) {
    this.receipt = { backend, cell, observations: [], failures: [], cleanup: false, highWater: {}, debt: [] };
    this.probe = new QuotaProbe(backend, `quota-r2-${cell}-${crypto.randomUUID()}`, cell === "churn" ? 4 : 1);
  }
  async observe(phase: string, generation: number): Promise<Inventory> {
    const inventory = await this.probe.inspect();
    const native = { ...this.probe.counts };
    this.receipt.observations.push({ phase, generation, inventory, native, elapsedMs: performance.now() - this.started });
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
    assert(inventory.payloadRecords <= payloadLimit * multiplier, `unbounded physical data records ${inventory.payloadRecords}`);
    assert(inventory.payloadBytes <= payloadLimit * payloadSize, `unbounded physical payload bytes ${inventory.payloadBytes}`);
    assert(inventory.journalRecords < compactEvery * 2, `unbounded journal debt ${inventory.journalRecords}`);
    assert(inventory.bases.length <= 2, `more than two recovery bases: ${inventory.bases}`);
    assert(inventory.orphanPayloads.length === 0, `uncollected orphan payloads: ${inventory.orphanPayloads}`);
    assert(this.probe.counts.transactions === 0, "commit returned with a write transaction outstanding");
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
    let drops = 0;
    let prior = 0;
    for (let generation = 1; generation <= churnSaves; generation++) {
      await this.save(storage, generation);
      const current = this.receipt.observations.at(-1)!.inventory.payloadRecords;
      if (current < prior) drops++;
      prior = current;
      if (generation % 16 !== 0) continue;
      await this.probe.close(storage);
      const start = performance.now();
      storage = await this.probe.open();
      await verifyRoot(storage, generation);
      this.highWater("reopenMs", performance.now() - start);
      await this.observe("reopened", generation);
    }
    assert(drops >= 10, `cleanup was not repeated, observed ${drops} physical record drops`);
    assert(this.probe.counts.deletes > 0, "no native deletions observed");
  }
  async failedSave(fault: Exclude<Fault, "cleanup">): Promise<void> {
    let storage = await this.probe.open();
    for (let generation = 1; generation <= 6; generation++) await this.save(storage, generation);
    const before = await this.observe("before-failure", 6);
    this.probe.fault = fault;
    await rejected(storage.persist(revision(7)), /injected|ENOSPC/);
    await rejected(storage.flush(), /injected|ENOSPC/);
    this.probe.fault = undefined;
    const after = await this.observe("failed-save", 6);
    assert(this.probe.counts.faultHits > 0, "fault did not hit the native write boundary");
    assert(JSON.stringify(before.payloads.toSorted()) === JSON.stringify(after.payloads.toSorted()), "failed save leaked physical payload records");
    assert(after.payloadBytes === before.payloadBytes, "failed save changed physical payload byte debt");
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
      assert(inventory.payloads.includes(node.data), `selected recovery payload collected: ${node.data}`);
      const target = expected(node.data);
      assert((await storage.read(node.data)).every((byte, i) => byte === target[i]), `recovery payload changed: ${node.data}`);
    }
    await this.probe.close(storage);
    await this.probe.removeLatest();
    storage = await this.probe.open();
    await verifyRoot(storage, 7);
    await this.observe("selected-root-proven-by-second-recovery", 7);
    for (let generation = 10; generation <= 20; generation++) await this.save(storage, generation, "replacement");
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
      assert(denied.orphanPayloads.length > 0 && denied.bases.length > 2, "cleanup denial did not accumulate observable physical debt");
      await this.save(storage, start + 3);
      await this.save(storage, start + 4);
      await this.save(storage, start + 5);
    }
    assert(this.probe.counts.faultHits >= 6, "cleanup retry fault was not repeated");
  }
  async checkpointDebt(): Promise<void> {
    const storage = await this.probe.open();
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    try {
      backend.fs.writeFile("/value", "old acknowledged bytes");
      await backend.flush();
      const baseline = await storage.load();
      assert(baseline, "baseline checkpoint absent");
      backend.fs.writeFile("/value", "failed candidate bytes");
      this.probe.fault = "commit";
      const failed = backend.flush();
      const pending = this.debt(backend);
      assert(pending.pendingOperations === 1 && pending.pendingBytes > 0, "captured checkpoint debt was not observed");
      await rejected(failed, /injected/);
      this.probe.fault = undefined;
      await this.observe("failed-checkpoint", baseline.generation);
      const idle = this.debt(backend);
      assert(idle.pendingOperations === 0 && idle.pendingBytes === 0 && idle.pendingMetadataBytes === 0, "failed checkpoint retained capture debt");
      assert((await storage.load())?.generation === baseline.generation, "failed checkpoint advanced durable generation");
      await rejected(storage.flush(), /injected/);
      await backend.flush();
      const saved = await storage.load();
      assert(saved?.generation === baseline.generation + 1, "retry did not advance exactly one durable generation");
      const idleAfterRetry = this.debt(backend);
      assert(idleAfterRetry.pendingOperations === 0 && idleAfterRetry.pendingBytes === 0, "retry retained checkpoint debt");
      await backend.close();
    } finally {
      this.probe.fault = undefined;
      backend.dispose();
    }
    const reopened = await this.probe.open();
    const index = await reopened.load();
    const node = index?.nodes.find((entry) => entry.kind === "file");
    assert(node?.data, "retry payload absent after reopen");
    assert(new TextDecoder().decode(await reopened.read(node.data)) === "failed candidate bytes", "retry failed to persist current dirty data");
    await this.observe("checkpoint-retry-reopened", index!.generation);
  }
  async run(): Promise<QuotaReceipt> {
    try {
      this.probe.install();
      await this.execute();
    } catch (error) {
      this.receipt.failures.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
    } finally {
      try {
        await this.probe.destroy();
        this.receipt.cleanup = true;
      } catch (error) {
        this.receipt.failures.push(`cleanup: ${String(error)}`);
      }
    }
    return this.receipt;
  }
  private execute(): Promise<void> {
    switch (this.receipt.cell) {
      case "churn": return this.churn();
      case "payload-quota": return this.failedSave("payload-quota");
      case "commit": return this.failedSave("commit");
      case "recovery-root": return this.recoveryRoot();
      case "cleanup-retry": return this.cleanupRetry();
      case "checkpoint-debt": return this.checkpointDebt();
    }
  }
}
/** @browserEntry */
export function runQuotaCase(backend: AdapterKind, cell: QuotaCase): Promise<QuotaReceipt> {
  return new Scenario(backend, cell).run();
}
