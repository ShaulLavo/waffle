import { createPersistentResidentOwner } from "../browser/persistent-resident-owner";
import { MemoryBackend } from "../fs/backend";
import { PersistentBackend } from "../fs/persistent";
import { IndexedDBStorage } from "../fs/indexeddb";
import { FilesystemService } from "../fs/service";
import type { FilesystemConnection } from "../fs/protocol";
import { ResidentGrantAuthority } from "../fs/publication-grant";
import type { PersistenceBatch } from "../fs/storage";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format";
import { residentMemory } from "./fixtures/resident-memory";
import { publicationAdapter } from "./indexeddb-publication-browser";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  const replacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value;
  assert(JSON.stringify(actual, replacer) === JSON.stringify(expected, replacer), message);
}
async function remove(name: string) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("owned native database still open"));
  });
}
function request(name: string) {
  return {
    kind: "initial-open" as const,
    runtimeLifetime: "root-continuity-r42",
    attempt: crypto.randomUUID(),
    selected: {
      origin: location.origin,
      name,
      implementation: "indexeddb" as const,
      format: INDEXEDDB_FORMAT,
    },
    publication: { limits: publicationAdapter.fixture().limits },
  };
}

/** @browserEntry Invoked through the explicit composition runner bundle. */
export async function selectedRootComposition() {
  const name = `root-continuity-${crypto.randomUUID()}`;
  const saved = publicationAdapter.fixture();
  const storage = await IndexedDBStorage.open(name, { whenBusy: "wait" });
  try {
    await storage.persist(publicationAdapter.batch(1, saved));
    await storage.flush();
  } finally {
    await storage.close();
  }
  const memory = residentMemory();
  const connect = FilesystemService.prototype.connect;
  const attach = MemoryBackend.prototype.attachShared;
  const persist = IndexedDBStorage.prototype.persist;
  const activate = ResidentGrantAuthority.prototype.activate;
  let connection: FilesystemConnection | undefined;
  const captured: { backend?: PersistentBackend } = {};
  let completed: PersistenceBatch | undefined;
  let activations = 0;
  let durabilityMs = 0;
  FilesystemService.prototype.connect = function (value) {
    connection = value;
    return Reflect.apply(connect, this, [value]);
  };
  MemoryBackend.prototype.attachShared = function (...args) {
    assert(this instanceof PersistentBackend, "real persistent backend attached");
    captured.backend = this;
    assert(args[0] === this.shared.buffer, "borrowed actual restored root");
    return Reflect.apply(attach, this, args);
  };
  IndexedDBStorage.prototype.persist = async function (batch) {
    const start = performance.now();
    await Reflect.apply(persist, this, [batch]);
    durabilityMs += performance.now() - start;
    completed = batch;
  };
  ResidentGrantAuthority.prototype.activate = function () {
    const frontier = connection?.publication?.buffers.sessionLimit;
    assert(
      completed?.publication?.sessionSerial === frontier,
      "reserved frontier durable before activation",
    );
    activations++;
    return Reflect.apply(activate, this, []);
  };
  const owner = createPersistentResidentOwner(
    request(name),
    new AbortController().signal,
    undefined,
    memory,
  );
  try {
    const ready = await owner.ready;
    equal(ready.notice.kind, "completed-cut-recovered", "selected checkpoint restored");
    equal(ready.identity.history, saved.cut.history, "history identity retained");
    const backend = captured.backend;
    assert(connection?.publication && backend, "real attached pair captured");
    const publication = connection.publication;
    const domain = backend.shared.publication;
    assert(domain, "real domain bound");
    equal(domain.cut(), saved.cut, "settled cut unchanged during startup");
    for (const receipt of saved.receipts)
      equal(
        domain.lookupAny(receipt.id),
        { kind: "committed", receipt },
        "receipt identity preserved",
      );
    assert(
      publication.session.serial > saved.sessionSerial,
      "fresh session above old reserved frontier",
    );
    assert(activations === 1, "activated once");
    assert(memory.snapshot().obligations === 0, "fixed reservation closed");
    const published = memory.snapshot();
    await owner.stop();
    equal(memory.snapshot(), published, "escaped ledger retained after stop");
    const reopened = await IndexedDBStorage.open(name, { whenBusy: "wait" });
    try {
      const selected = await reopened.load();
      equal(
        selected?.publication?.sessionSerial,
        publication.buffers.sessionLimit,
        "selected native frontier retained",
      );
      equal(selected?.publication?.receipts, saved.receipts, "selected native receipts retained");
    } finally {
      await reopened.close();
    }
    return {
      history: ready.identity.history,
      session: publication.session.serial,
      frontier: publication.buffers.sessionLimit,
      activations,
      durabilityMs,
      ledger: published,
    };
  } finally {
    FilesystemService.prototype.connect = connect;
    MemoryBackend.prototype.attachShared = attach;
    IndexedDBStorage.prototype.persist = persist;
    ResidentGrantAuthority.prototype.activate = activate;
    await owner.stop();
    await remove(name);
  }
}

/** @browserEntry Invoked through the explicit composition runner bundle. */
export async function startupFenceComposition(mode: "cancel" | "failure") {
  const name = `root-continuity-${mode}-${crypto.randomUUID()}`;
  const memory = residentMemory();
  const flush = PersistentBackend.prototype.flush;
  const close = IndexedDBStorage.prototype.close;
  const activate = ResidentGrantAuthority.prototype.activate;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const failure = new Error("restored construction startup flush failed");
  let activations = 0;
  PersistentBackend.prototype.flush = async function () {
    entered.resolve();
    await release.promise;
    if (mode === "failure") throw failure;
    return Reflect.apply(flush, this, []);
  };
  IndexedDBStorage.prototype.close = async function () {
    closing.resolve();
    await releaseClose.promise;
    return Reflect.apply(close, this, []);
  };
  ResidentGrantAuthority.prototype.activate = function () {
    activations++;
    return Reflect.apply(activate, this, []);
  };
  const abort = new AbortController();
  const owner = createPersistentResidentOwner(request(name), abort.signal, undefined, memory);
  let readyPublished = false;
  const outcome = owner.ready.then(
    () => {
      readyPublished = true;
      return undefined;
    },
    (error: unknown) => error,
  );
  let stopped = false;
  try {
    await entered.promise;
    const charged = memory.snapshot();
    assert(charged.obligations === 0, "published fixed reservation already closed");
    if (mode === "cancel") abort.abort();
    release.resolve();
    const error = await outcome;
    if (mode === "failure") assert(error === failure, "startup error identity retained");
    const stopping = owner.stop();
    void stopping.then(() => {
      stopped = true;
    });
    await closing.promise;
    assert(
      !readyPublished && activations === 0,
      "no ready or activation after interrupted startup flush",
    );
    assert(!stopped, "stop joins actual native close debt");
    const locks = await navigator.locks.query();
    assert(
      locks.held?.some((lock) => lock.name?.includes(name)),
      "native close debt retains guards",
    );
    equal(memory.snapshot(), charged, "escaped accounting retained while native close is held");
    releaseClose.resolve();
    await stopping;
    equal(memory.snapshot(), charged, "escaped backing is not refunded after actual close");
    const after = await navigator.locks.query();
    assert(
      !after.held?.some((lock) => lock.name?.includes(name)),
      "owned guards released after actual close",
    );
    return { mode, activations, readyPublished, retainedBytes: charged.allocated, stopped };
  } finally {
    release.resolve();
    releaseClose.resolve();
    PersistentBackend.prototype.flush = flush;
    IndexedDBStorage.prototype.close = close;
    ResidentGrantAuthority.prototype.activate = activate;
    await owner.stop();
    await remove(name);
  }
}
