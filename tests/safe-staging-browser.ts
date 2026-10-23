import { IndexedDBStorage } from "../fs/indexeddb.js";
import { getVfsDescriptor, VfsError } from "../fs/vfs.js";
import {
  StagedCommitDriver,
  STAGED_FORMAT,
  decodeCommit,
  encodeCommit,
  operationKey,
  prepareDurableGroup,
  lookupReceipt,
  type CommittedStorage,
  type CompleteStage,
  type DurableReceipt,
  type NativeOutcome,
} from "../fs/safe-staging.js";
import { encodeRecord, type PersistenceBatch } from "../fs/storage.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const bytes = (value: string) => new TextEncoder().encode(value);
const request = { digest: "a".repeat(64), length: 1 };
function batch(generation: number, text = `v${generation}`): PersistenceBatch {
  return {
    generation,
    root: 1,
    removes: [],
    upserts: [
      {
        ino: 1,
        kind: "dir",
        size: 0,
        mtime: generation,
        children: [
          ["a", 2],
          ["b", 3],
        ],
      },
      { ino: 2, kind: "file", size: text.length, mtime: generation, data: `a:${generation}` },
      { ino: 3, kind: "file", size: text.length, mtime: generation, data: `b:${generation}` },
    ],
    data: new Map([
      [`a:${generation}`, bytes(text)],
      [`b:${generation}`, bytes(text)],
    ]),
  };
}
function stage(
  generation: number,
  publish: (receipt: DurableReceipt) => void = () => {},
): CompleteStage {
  return {
    batch: batch(generation),
    cut: { history: "original-cut", generation },
    result: { kind: "append", written: 1, offset: generation + 7 },
    retained: [],
    orphans: [],
    publish,
    release() {},
  };
}
async function group(storage: CommittedStorage, generation: number, selected = stage(generation)) {
  return prepareDurableGroup(
    await storage.recoverCommitted(),
    operationKey(1n, BigInt(generation)),
    request,
    selected,
  );
}
async function commit(
  storage: CommittedStorage,
  generation: number,
  selected?: CompleteStage,
): Promise<DurableReceipt> {
  const outcome = await storage.beginCommit(await group(storage, generation, selected)).terminal;
  assert(outcome.kind === "committed", "complete group commits");
  return outcome.receipt;
}
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function raw<T>(name: string, work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await idbRequest(indexedDB.open(name));
  try {
    return await work(database);
  } finally {
    database.close();
  }
}
async function readRaw(name: string, store: string, key: IDBValidKey): Promise<unknown> {
  return raw(name, (db) => idbRequest(db.transaction(store).objectStore(store).get(key)));
}
async function change(
  name: string,
  store: string,
  key: IDBValidKey,
  value?: unknown,
): Promise<void> {
  await raw(
    name,
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite", { durability: "strict" });
        if (value === undefined) tx.objectStore(store).delete(key);
        else tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      }),
  );
}
async function formatFailure(action: Promise<unknown>): Promise<void> {
  try {
    await action;
  } catch (error) {
    assert(
      error instanceof VfsError && error.code === "INVALID_VFS_FORMAT",
      `format failure, got ${error}`,
    );
    return;
  }
  throw new Error("Expected fail-closed required-head recovery");
}
function invokeTerminal(
  callback: IDBTransaction["oncomplete"],
  transaction: IDBTransaction,
  event: Event,
): () => void {
  return () => callback?.call(transaction, event);
}
function equal(actual: number, expected: number): boolean {
  return actual === expected;
}
function terminalGate(kind: "complete" | "abort") {
  const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, `on${kind}`)!;
  const seen = Promise.withResolvers<void>();
  let delivery: (() => void) | undefined;
  Object.defineProperty(IDBTransaction.prototype, `on${kind}`, {
    ...descriptor,
    set(callback: IDBTransaction["oncomplete"]) {
      if (this.mode !== "readwrite" || !this.objectStoreNames.contains("journal")) {
        descriptor.set!.call(this, callback);
        return;
      }
      descriptor.set!.call(this, (event: Event) => {
        delivery = invokeTerminal(callback, this, event);
        seen.resolve();
      });
    },
  });
  return {
    seen: seen.promise,
    release() {
      delivery?.();
    },
    restore() {
      Object.defineProperty(IDBTransaction.prototype, `on${kind}`, descriptor);
    },
  };
}
function failureOnReceipt(cause: unknown) {
  const original = IDBObjectStore.prototype.put;
  let payloadPuts = 0;
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    if (this.name === "data") payloadPuts++;
    if (this.name === "metadata" && key === "commit") throw cause;
    return original.call(this, value, key);
  };
  return {
    get payloadPuts() {
      return payloadPuts;
    },
    restore() {
      IDBObjectStore.prototype.put = original;
    },
  };
}
async function fixture(
  run: (name: string, open: () => Promise<CommittedStorage>) => Promise<void>,
): Promise<void> {
  const name = `waffle-staged-test-${crypto.randomUUID()}`,
    stores: CommittedStorage[] = [];
  const open = async () => {
    const storage = await IndexedDBStorage.openCommitted(name, { compactEvery: 1 });
    stores.push(storage);
    return storage;
  };
  try {
    await run(name, open);
  } finally {
    for (const storage of stores) await storage.close();
    await idbRequest(indexedDB.deleteDatabase(name));
  }
}
async function abortAtomic(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  const prepared = await group(storage, 2),
    cause = { exact: "quota sentinel" };
  const gate = terminalGate("abort"),
    injection = failureOnReceipt(cause);
  let outcome: NativeOutcome | undefined;
  let closing = false;
  try {
    const pending = storage.beginCommit(prepared).terminal.then((value) => {
      outcome = value;
      return value;
    });
    await gate.seen;
    const close = storage.close().then(() => {
      closing = true;
    });
    await Promise.resolve();
    assert(
      !outcome && !closing && injection.payloadPuts === 4,
      "abort requests keep native and close debt after four actual payload puts",
    );
    gate.release();
    const terminal = await pending;
    await close;
    assert(
      terminal.kind === "aborted" && terminal.cause === cause,
      "native abort preserves exact cause",
    );
  } finally {
    gate.release();
    gate.restore();
    injection.restore();
  }
  const reopened = await open(),
    recovered = await reopened.recoverCommitted();
  assert(
    recovered.index?.generation === 1 && recovered.envelope.head.sequence === 1n,
    "root and receipt both rolled back",
  );
  assert(
    (await readRaw(name, "data", "a:2")) === undefined &&
      (await readRaw(name, "data", "b:2")) === undefined,
    "both new payloads rolled back",
  );
}
async function nullAbortCauses(
  _name: string,
  open: () => Promise<CommittedStorage>,
): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  for (const cause of [undefined, null]) {
    const prepared = await group(storage, 2),
      injection = failureOnReceipt(cause);
    try {
      const outcome = await storage.beginCommit(prepared).terminal;
      assert(
        outcome.kind === "aborted" && outcome.cause === cause,
        "explicit nullish throw stays exact",
      );
    } finally {
      injection.restore();
    }
  }
}
async function nativeAbortRequest(
  _name: string,
  open: () => Promise<CommittedStorage>,
): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  const prepared = await group(storage, 2),
    gate = terminalGate("abort");
  const original = IDBObjectStore.prototype.put;
  let handle: ReturnType<CommittedStorage["beginCommit"]> | undefined;
  let settled = false;
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    const result = original.call(this, value, key);
    if (this.name === "metadata" && key === "commit") handle?.requestAbort();
    return result;
  };
  try {
    handle = storage.beginCommit(prepared);
    const terminal = handle.terminal.then((value) => {
      settled = true;
      return value;
    });
    await gate.seen;
    assert(!settled, "requestAbort cannot settle before native abort event delivery");
    gate.release();
    const outcome = await terminal;
    assert(
      outcome.kind === "aborted" &&
        outcome.cause instanceof DOMException &&
        outcome.cause.name === "AbortError",
      "native abort request returns AbortError",
    );
    assert(
      (await storage.recoverCommitted()).envelope.head.sequence === 1n,
      "native abort keeps prior receipt head",
    );
  } finally {
    gate.release();
    gate.restore();
    IDBObjectStore.prototype.put = original;
  }
}
async function commitBeforeReply(
  name: string,
  open: () => Promise<CommittedStorage>,
): Promise<void> {
  const storage = await open(),
    driver = await StagedCommitDriver.open(storage);
  const gate = terminalGate("complete"),
    observer = new AbortController(),
    lost = { exact: "reply lost" };
  let publishes = 0,
    releases = 0,
    drained = false;
  try {
    const selected = stage(1, () => {
      publishes++;
      throw lost;
    });
    const observed = driver.submit({
      key: operationKey(1n, 1n),
      request,
      charge: { inputBytes: 1, payloadBytes: 4, metadataBytes: 4096, publicationBytes: 64 },
      signal: observer.signal,
      async prepare() {
        return {
          ...selected,
          release() {
            releases++;
          },
        };
      },
    });
    await gate.seen;
    const duplicate = driver.submit({
      key: operationKey(1n, 1n),
      request,
      charge: { inputBytes: 0, payloadBytes: 0, metadataBytes: 0, publicationBytes: 0 },
      async prepare() {
        throw new Error("pending duplicate cannot stage");
      },
    });
    const refused = await driver.submit({
      key: operationKey(1n, 2n),
      request,
      charge: { inputBytes: 0, payloadBytes: 0, metadataBytes: 0, publicationBytes: 0 },
      async prepare() {
        throw new Error("busy driver cannot queue input");
      },
    });
    assert(refused.kind === "not-admitted", "busy driver refuses another complete group");
    assert(
      (await readRaw(name, "metadata", "active")) === 1,
      "real database has committed before terminal delivery",
    );
    const durable = await decodeCommit(await readRaw(name, "metadata", "commit"));
    assert(
      durable.head.sequence === 1n &&
        lookupReceipt(durable, operationKey(1n, 1n), request).kind === "retained",
      "receipt and required head are durable before reply",
    );
    const debt = driver.resources();
    assert(
      debt.nativeDebt === 1 && debt.debtBytes >= 4 * 6 && publishes === 0,
      "ACK and reserved publication wait for native complete delivery",
    );
    observer.abort(lost);
    const observedOutcome = await observed;
    assert(
      observedOutcome.kind === "indeterminate" && observedOutcome.cause === lost,
      "cancelled observer is not native abort",
    );
    const drain = driver.drain().then(
      () => {
        drained = true;
      },
      (error: unknown) => {
        assert(error === lost, "publish error stays exact");
        drained = true;
      },
    );
    await Promise.resolve();
    assert(
      !drained && releases === 0 && driver.resources().nativeDebt === 1,
      "observer cannot free native stage debt",
    );
    gate.release();
    await drain;
    const joined = await duplicate;
    assert(
      joined.kind === "indeterminate" && joined.cause === lost,
      "pending duplicate joins exact terminal outcome",
    );
    assert(
      equal(publishes, 1) &&
        equal(releases, 1) &&
        driver.resources().state === "stopped" &&
        driver.resources().debtBytes === 0,
      "post-commit publish failure stops root without rollback",
    );
  } finally {
    gate.release();
    gate.restore();
  }
  await storage.close();
  const reopened = await open(),
    fresh = await StagedCommitDriver.open(reopened);
  const replay = await fresh.submit({
    key: operationKey(1n, 1n),
    request,
    charge: { inputBytes: 0, payloadBytes: 0, metadataBytes: 0, publicationBytes: 0 },
    async prepare() {
      throw new Error("replay must not run producer");
    },
  });
  assert(
    replay.kind === "committed" &&
      replay.receipt.result.kind === "append" &&
      replay.receipt.result.offset === 8 &&
      replay.receipt.cut.history === "original-cut",
    "reopen returns exact result and original cut",
  );
  assert(
    (await reopened.recoverCommitted()).envelope.head.sequence === 1n,
    "replay never executes a second append",
  );
}
async function postCommitInstallFailure(
  name: string,
  open: () => Promise<CommittedStorage>,
): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  const prepared = await group(storage, 2),
    install = { exact: "adapter install" },
    observed = { exact: "ownership observer" };
  let notified = 0;
  Object.defineProperty(storage, "installCommit", {
    configurable: true,
    value() {
      throw install;
    },
  });
  Object.defineProperty(storage, "onOwnershipLost", {
    configurable: true,
    value() {
      notified++;
      throw observed;
    },
  });
  const outcome = await storage.beginCommit(prepared).terminal;
  assert(
    outcome.kind === "committed" && outcome.receipt.commit === 2n && equal(notified, 1),
    "adapter install and ownership observer errors cannot relabel native commit",
  );
  let stopped = false;
  try {
    await storage.recoverCommitted();
  } catch (error) {
    stopped = String(error).includes("another tab");
  }
  assert(stopped, "failed adapter memory reconciliation stops authority");
  await storage.close();
  const reopened = await open();
  assert(
    (await reopened.recoverCommitted()).envelope.head.sequence === 2n &&
      (await readRaw(name, "metadata", "active")) === 2,
    "native commit survives adapter memory failure and reopen",
  );
}
async function preNativeCancellation(
  name: string,
  open: () => Promise<CommittedStorage>,
): Promise<void> {
  const storage = await open(),
    driver = await StagedCommitDriver.open(storage);
  const started = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const observer = new AbortController(),
    cause = { exact: "cancel during staging" };
  let released = 0,
    published = 0;
  const observed = driver.submit({
    key: operationKey(1n, 1n),
    request,
    signal: observer.signal,
    charge: { inputBytes: 1, payloadBytes: 4, metadataBytes: 4096, publicationBytes: 64 },
    async prepare() {
      started.resolve();
      await resume.promise;
      return {
        ...stage(1, () => {
          published++;
        }),
        release() {
          released++;
        },
      };
    },
  });
  await started.promise;
  observer.abort(cause);
  const outcome = await observed;
  assert(
    outcome.kind === "indeterminate" && outcome.cause === cause && driver.resources().debtBytes > 0,
    "staging cancellation retains producer debt",
  );
  resume.resolve();
  await driver.drain();
  assert(
    equal(released, 1) && published === 0 && driver.resources().debtBytes === 0,
    "cancelled private stage releases without publication",
  );
  assert(
    (await storage.recoverCommitted()).envelope.head.sequence === 0n &&
      (await readRaw(name, "metadata", "active")) === undefined,
    "pre-native cancellation leaves genesis unchanged",
  );
}
async function requiredHead(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  await commit(storage, 2);
  await storage.close();
  const before = await readRaw(name, "metadata", "commit");
  await change(name, "metadata", 1, { json: "corrupt", checksum: "bad" });
  const exact = await open();
  assert(
    (await exact.recoverCommitted()).index?.generation === 2,
    "journal can reconstruct exact required head",
  );
  await exact.close();
  await change(name, "journal", 2, { json: "corrupt", checksum: "bad" });
  await formatFailure(open());
  const after = await readRaw(name, "metadata", "commit");
  assert(
    JSON.stringify(before) === JSON.stringify(after) &&
      (await readRaw(name, "data", "a:2")) !== undefined,
    "corrupt required root preserves database and receipt",
  );
}
async function headFence(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  const prepared = await group(storage, 2),
    original = await readRaw(name, "metadata", "commit");
  const forged = await decodeCommit(original);
  await change(
    name,
    "metadata",
    "commit",
    await encodeCommit({ ...forged, head: { ...forged.head, workspace: "other-authority" } }),
  );
  const failed = await storage.beginCommit(prepared).terminal;
  assert(
    failed.kind === "aborted" && String(failed.cause).includes("head changed"),
    "expected-head compares inside native transaction",
  );
  assert((await readRaw(name, "data", "a:2")) === undefined, "head mismatch rolls data back");
  await change(name, "metadata", "commit", original);
  const recovery = await storage.recoverCommitted();
  await change(name, "metadata", "epoch", recovery.epoch + 1);
  const stale = await storage.beginCommit(prepared).terminal;
  assert(
    stale.kind === "aborted" && String(stale.cause).includes("another tab"),
    "native epoch fence rejects stale authority",
  );
}
async function retainedRoots(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open(),
    first = stage(1);
  first.batch.data.set("orphan", bytes("kept"));
  await commit(storage, 1, {
    ...first,
    orphans: [{ key: "orphan", size: 4 }],
    retained: [{ key: "orphan", size: 4 }],
  });
  await commit(storage, 2, { ...stage(2), orphans: [] });
  await commit(storage, 3);
  assert(
    new TextDecoder().decode(await storage.read("orphan")) === "kept",
    "retained outcome payload survives compaction without runtime pins",
  );
  await storage.close();
  const reopened = await open();
  assert(
    new TextDecoder().decode(await reopened.read("orphan")) === "kept",
    "receipt payload recovers outside reachable namespace",
  );
  await change(name, "data", "orphan");
  await reopened.close();
  await formatFailure(open());
}
async function formatIsolation(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open();
  await storage.close();
  assert((await readRaw(name, "metadata", "format")) === STAGED_FORMAT, "private marker installed");
  const fast = await IndexedDBStorage.open(name);
  try {
    await formatFailure(fast.load());
  } finally {
    await fast.close();
  }
  await change(name, "metadata", "format", "waffle-indexeddb-chunks-v2");
  await formatFailure(open());
  try {
    getVfsDescriptor("safe");
  } catch (error) {
    assert(
      error instanceof VfsError && error.code === "UNSUPPORTED_VFS",
      "SAFE remains unsupported",
    );
    return;
  }
  throw new Error("SAFE unexpectedly supported");
}
async function missingEnvelope(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  await storage.close();
  await change(name, "metadata", "commit");
  await formatFailure(open());
  assert(
    (await readRaw(name, "metadata", "active")) === 1,
    "missing required envelope fails closed without deletion",
  );
}
async function retirement(_name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open(),
    driver = await StagedCommitDriver.open(storage, { receipts: 1 });
  const submit = (generation: number) =>
    driver.submit({
      key: operationKey(1n, BigInt(generation)),
      request,
      charge: { inputBytes: 1, payloadBytes: 4, metadataBytes: 4096, publicationBytes: 0 },
      async prepare() {
        return stage(generation);
      },
    });
  assert(
    (await submit(1)).kind === "committed" && (await submit(2)).kind === "committed",
    "bounded receipt window advances",
  );
  const recovered = await storage.recoverCommitted();
  assert(
    lookupReceipt(recovered.envelope, operationKey(1n, 1n), request).kind === "retired",
    "eviction persists retirement floor",
  );
  assert((await submit(1)).kind === "retired", "retired request never invokes producer");
  const conflict = driver.submit({
    key: operationKey(1n, 2n),
    request: { ...request, digest: "b".repeat(64) },
    charge: { inputBytes: 0, payloadBytes: 0, metadataBytes: 0, publicationBytes: 0 },
    async prepare() {
      throw new Error("conflict cannot stage");
    },
  });
  assert((await conflict).kind === "conflict", "changed canonical input conflicts");
}
async function splitReceiptMutant(name: string): Promise<void> {
  const fast = await IndexedDBStorage.open(name, { compactEvery: 1 });
  try {
    await fast.persist(batch(1));
    await fast.persist(batch(2));
  } finally {
    await fast.close();
  }
  const active = await readRaw(name, "metadata", "active"),
    receipt = await readRaw(name, "metadata", "commit");
  let caught = false;
  try {
    assert(
      active !== 2 || receipt !== undefined,
      "split persist-then-receipt lost required outcome",
    );
  } catch {
    caught = true;
  }
  assert(caught, "real split-transaction mutant must fail the atomic receipt assertion");
  await change(name, "metadata", 1, { json: "corrupt", checksum: "bad" });
  await change(name, "journal", 2, { json: "corrupt", checksum: "bad" });
  const recovered = await IndexedDBStorage.open(name);
  try {
    assert(
      (await recovered.load())?.generation === 1,
      "FAST control still recovers older valid root",
    );
  } finally {
    await recovered.close();
  }
}
async function corruptEnvelope(name: string, open: () => Promise<CommittedStorage>): Promise<void> {
  const storage = await open();
  await commit(storage, 1);
  await storage.close();
  const original = await readRaw(name, "metadata", "commit");
  assert(
    !!original &&
      typeof original === "object" &&
      "json" in original &&
      typeof original.json === "string",
    "stored record exists",
  );
  const envelope = JSON.parse(original.json);
  envelope.head.sequence = "01";
  await change(name, "metadata", "commit", await encodeRecord(envelope));
  await formatFailure(open());
}
const cases = {
  abortAtomic,
  nullAbortCauses,
  nativeAbortRequest,
  commitBeforeReply,
  preNativeCancellation,
  postCommitInstallFailure,
  requiredHead,
  headFence,
  retainedRoots,
  formatIsolation,
  missingEnvelope,
  retirement,
  splitReceiptMutant,
  corruptEnvelope,
};
/** @browserEntry Invoked by the dedicated native staging runner. */
export async function safeStagingNative(selected?: string): Promise<string[]> {
  if (selected && !(selected in cases)) throw new Error(`Unknown staged control ${selected}`);
  const passed: string[] = [];
  for (const [name, run] of Object.entries(cases)) {
    if (selected && selected !== name) continue;
    await fixture(run);
    passed.push(name);
    console.log(`staged control passed: ${name}`);
  }
  return passed;
}
