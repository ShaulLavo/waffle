import { IndexedDBStorage } from "../fs/indexeddb.js";
import { PersistentBackend } from "../fs/persistent.js";
import { createFilesystemConnection, FilesystemService } from "../fs/index.js";
import { SharedFilesystemState } from "../fs/shared.js";
import { State } from "../fs/protocol.js";
import { CHUNK_SIZE as CHUNK } from "../fs/indexeddb-chunks.js";
import { ExperimentUnconfirmed, WORKSPACE, type ExperimentReceipt } from "../fs/checkpoint-map.js";
import type { CheckpointCut } from "../fs/checkpoint-mutations.js";
import { hostFilesystemClient } from "../tests/fixtures/filesystem-host.js";

const EMPTY = new Uint8Array();
const PATH = "/file";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  check(
    actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
    label,
  );
}

async function rejected(work: Promise<unknown>, message: string): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    check(String(error).includes(message), `Expected rejection ${message}, received ${error}`);
    return error;
  }
  throw new Error(`Expected rejection: ${message}`);
}

async function call(backend: PersistentBackend, operation: string, args: unknown[], bytes = EMPTY) {
  await backend.prepare(operation, args);
  return backend.execute(operation, args, bytes);
}

async function storeOwner(compactEvery = 128) {
  const storage = await IndexedDBStorage.open(WORKSPACE, { compactEvery });
  try {
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    return {
      storage,
      backend,
      async close() {
        backend.dispose();
        await storage.close();
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
}

function handleFor(backend: PersistentBackend, path = PATH): number {
  const resolution = backend.fs.resolveAbsolute(path);
  check(typeof resolution !== "number" && resolution.node !== undefined, `Missing file ${path}`);
  return resolution.node;
}

async function fileKey(storage: IndexedDBStorage, path = PATH): Promise<string> {
  const index = await storage.load();
  const ino = index?.nodes
    .find((node) => node.ino === index.root)
    ?.children?.find(([name]) => name === path.slice(1))?.[1];
  const node = index?.nodes.find((node) => node.ino === ino && node.kind === "file");
  check(node?.data, `Missing durable file ${path}`);
  return node.data;
}

function gate(storage: IndexedDBStorage) {
  const entered = Promise.withResolvers<ExperimentReceipt>();
  const reply = Promise.withResolvers<"commit" | "abort" | "lose-ack" | "stop">();
  storage.experimentBeforeTransaction = (receipt) => {
    storage.experimentBeforeTransaction = undefined;
    entered.resolve(receipt);
    return reply.promise;
  };
  return { entered: entered.promise, release: reply.resolve };
}

async function ordered(abort: boolean) {
  const owner = await storeOwner();
  const { backend, storage } = owner;
  const captures: CheckpointCut[] = [];
  let pause: ReturnType<typeof gate> | undefined;
  try {
    const seed = new Uint8Array(3 * CHUNK).fill(0x61);
    await call(backend, "writeFile", [PATH], seed);
    await backend.flush();
    const firstKey = await fileKey(storage);
    const handle = handleFor(backend);
    backend.retain(handle);
    backend.experimentOnCapture = (capture) => {
      captures.push(capture);
    };
    try {
      await call(backend, "resize", [handle, CHUNK + 3, true]);
      pause = gate(storage);
      const a = backend.flush();
      const aRejection = abort ? rejected(a, "Injected checkpoint transaction abort") : undefined;
      const receipt = await pause.entered;
      await call(backend, "resize", [handle, 3 * CHUNK + 11, false]);
      await call(backend, "write", [handle, CHUNK - 2], new Uint8Array(8).fill(0x62));
      await call(backend, "append", [handle], new Uint8Array([0x63, 0x64]));
      await call(backend, "move", [PATH, "/renamed"]);
      const b = backend.flush("/renamed");
      const bRejection = abort ? rejected(b, "Injected checkpoint transaction abort") : undefined;
      const [first, second] = captures;
      check(
        first?.id === receipt.id && second?.parent === first.id,
        "Dependent flush did not freeze its predecessor",
      );
      const cut = Array.from(second.deltas.values())[0];
      check(
        cut?.chunks.get(1)?.[0] === 0x62 && cut.chunks.get(3)?.[11] === 0x63,
        "Queued cut missed cross-boundary write or final append offset",
      );
      check(
        cut.file?.handle === handle && cut.file.stat.size === cut.size && cut.file.identity,
        "Queued cut omitted its locked file identity or stat",
      );
      await call(backend, "write", [handle, CHUNK], new Uint8Array([0x65]));
      check(cut.chunks.get(1)?.[0] === 0x62, "Late overlapping edit mutated the queued cut");
      const expected = new Uint8Array(3 * CHUNK + 13);
      expected.set(seed.subarray(0, CHUNK + 3));
      expected.fill(0x62, CHUNK - 2, CHUNK + 6);
      expected.set([0x63, 0x64], 3 * CHUNK + 11);
      if (abort) {
        pause.release("abort");
        await Promise.all([aRejection, bRejection]);
        check(
          (await fileKey(storage)) === firstKey,
          "Aborted predecessor changed durable namespace",
        );
        bytesEqual(await storage.read(firstKey), seed, "Aborted predecessor changed durable bytes");
      } else {
        pause.release("commit");
        await Promise.all([a, b]);
        bytesEqual(
          await storage.read(await fileKey(storage, "/renamed")),
          expected,
          "Queued cut published later bytes",
        );
      }
      expected[CHUNK] = 0x65;
      await backend.flush();
      await owner.close();
      const reopened = await IndexedDBStorage.open(WORKSPACE);
      try {
        const key = await fileKey(reopened, "/renamed");
        bytesEqual(
          await reopened.read(key),
          expected,
          "Truncate, regrow, overwrite and append did not survive reopen",
        );
      } finally {
        await reopened.close();
      }
      return {
        frozenParent: receipt.id,
        predecessor: abort ? "aborted" : "committed",
        verifiedBytes: expected.length,
      };
    } finally {
      backend.release(handle);
    }
  } finally {
    pause?.release("stop");
    await owner.close();
  }
}

async function detached() {
  const owner = await storeOwner();
  const { backend, storage } = owner;
  const cuts: CheckpointCut[] = [];
  let pause: ReturnType<typeof gate> | undefined;
  try {
    await call(backend, "writeFile", [PATH], new Uint8Array([1, 2]));
    await call(backend, "writeFile", ["/replacement"], new Uint8Array([7, 8]));
    await backend.flush();
    const original = handleFor(backend);
    backend.retain(original);
    let retained = true;
    try {
      await call(backend, "move", ["/replacement", PATH]);
      check(handleFor(backend) !== original, "Replacement reused the detached file handle");
      await call(backend, "write", [original, 0], new Uint8Array([3]));
      backend.experimentOnCapture = (cut) => {
        cuts.push(cut);
      };
      pause = gate(storage);
      const a = backend.flush(original);
      await pause.entered;
      await call(backend, "append", [original], new Uint8Array([4]));
      const b = backend.flush();
      const [first, second] = cuts;
      const [keyA] = first?.deltas.keys() ?? [];
      const entryB = Array.from(second?.deltas ?? []).find(
        ([, delta]) => delta.file?.handle === original,
      );
      check(
        keyA && entryB?.[1].parent === keyA,
        "Queued detached cut omitted its captured predecessor",
      );
      backend.release(original);
      retained = false;
      pause.release("commit");
      await Promise.all([a, b]);
      bytesEqual(
        await storage.read(keyA),
        new Uint8Array([3, 2]),
        "Targeted flush lost detached version",
      );
      bytesEqual(
        await storage.read(entryB[0]),
        new Uint8Array([3, 2, 4]),
        "Global flush lost later detached version",
      );
      bytesEqual(
        await storage.read(await fileKey(storage)),
        new Uint8Array([7, 8]),
        "Detached publication recreated the replaced name",
      );
      for (let index = 0; index < 24; index++)
        await call(backend, "writeFile", ["/small" + index], new Uint8Array([index]));
      await backend.flush();
      const last = await fileKey(storage, "/small23");
      bytesEqual(
        await storage.read(last),
        new Uint8Array([23]),
        "Small-file checkpoint burst lost its last file",
      );
      return {
        targetedDetachedBytes: 2,
        globalDetachedBytes: 3,
        replacedNameBytes: [7, 8],
        smallFiles: 24,
      };
    } finally {
      if (retained) backend.release(original);
    }
  } finally {
    pause?.release("stop");
    await owner.close();
  }
}

async function reconcile() {
  const owner = await storeOwner();
  const { backend, storage } = owner;
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = hostFilesystemClient(service, pair);
  let pause: ReturnType<typeof gate> | undefined;
  try {
    await client.asyncCall("writeFile", [PATH], new Uint8Array([1, 2, 3]));
    await backend.flush();
    const oldHead = storage.experimentHead;
    await client.asyncCall("writeFile", [PATH], new Uint8Array([4, 5, 6]));
    pause = gate(storage);
    const before = rejected(backend.flush(), "Stopped before checkpoint transaction");
    const beforeReceipt = await pause.entered;
    pause.release("stop");
    await before;
    check(storage.experimentHead === oldHead, "Pretransaction stop advanced durable head");
    await client.asyncCall("move", [PATH, "/new"]);
    const expected = backend.shared.publication?.checkpoint();
    check(expected?.changes.length, "Real publication changes are required for this control");
    pause = gate(storage);
    const lost = rejected(backend.flush(), "Checkpoint committed but acknowledgement was lost");
    const receipt = await pause.entered;
    check(receipt.parent === oldHead, "Retry did not use confirmed predecessor");
    pause.release("lose-ack");
    const failure = await lost;
    check(failure instanceof ExperimentUnconfirmed, "Missing exact unconfirmed receipt");
    const held = backend.checkpointPressure();
    check(
      held.pendingBytes > 0 && held.pendingOperations === 1,
      "Unknown outcome released its capture charge",
    );
    await rejected(backend.flush(), "Checkpoint recovery is required");
    await owner.close();
    const next = await IndexedDBStorage.open(WORKSPACE);
    try {
      const state = await next.load();
      check(
        JSON.stringify(state?.publication) === JSON.stringify(expected),
        "Recovered different CheckpointPublication",
      );
      check(
        (await next.experimentOutcome(beforeReceipt)) === "aborted",
        "Old stopped cut reconciled as committed",
      );
      await rejected(
        next.experimentOutcome({ ...receipt, journal: "wrong digest" }),
        "differs from frozen cut",
      );
      check(
        (await next.reconcileExperiment(failure)) === "committed",
        "New writer did not reconcile the exact cut",
      );
      check(
        backend.checkpointPressure().pendingOperations === 0,
        "Confirmed outcome did not release captured charge",
      );
      bytesEqual(
        await next.read(await fileKey(next, "/new")),
        new Uint8Array([4, 5, 6]),
        "Lost acknowledgement lost durable bytes",
      );
      return {
        oldHead,
        exactId: receipt.id,
        publicationChanges: expected.changes.length,
        retainedCharge: held.pendingBytes,
      };
    } finally {
      await next.close();
    }
  } finally {
    pause?.release("stop");
    client.dispose();
    service.dispose();
    pair.client.port.close();
    pair.server.port.close();
    await owner.close();
  }
}

async function stageAndDeadOwner() {
  const owner = await storeOwner();
  const { backend, storage } = owner;
  try {
    await call(backend, "writeFile", [PATH], new Uint8Array([1, 2, 3]));
    await backend.flush();
    const handle = handleFor(backend);
    const state = backend.shared;
    const peer = new SharedFilesystemState(state.buffer, undefined, 177);
    const epoch = new Int32Array(new SharedArrayBuffer(4));
    const cells = new Int32Array(new SharedArrayBuffer(8));
    cells[0] = State.Complete;
    const bytes = new Uint8Array([7]);
    const stage = state.stageWrite(handle, 1, false, bytes.slice(), cells);
    const slot = state.fileSlot(handle);
    const end = peer.commitStagedWrite(
      slot,
      handle,
      cells,
      bytes,
      false,
      1,
      epoch,
      () => false,
      177,
    );
    check(end === 2 && stage.bytes !== undefined, "Stage did not commit ahead of owner settlement");
    let settlements = 0;
    state.experimentAfterStage = () => {
      check(
        state.experimentFileOwner(handle) === state.lockOwner,
        "Owner settled stage outside file lock",
      );
      settlements++;
    };
    await backend.flush();
    check(
      stage.bytes === undefined && settlements === 1,
      "Flush did not settle committed stage exactly once",
    );
    const key = await fileKey(storage);
    bytesEqual(await storage.read(key), new Uint8Array([1, 7, 3]), "Staged capture used old bytes");

    const worker = new Worker("/dead-writer.js", { type: "module" });
    const epochBefore = Atomics.load(epoch, 0);
    const abandoned = Promise.withResolvers<void>();
    worker.onmessage = () => abandoned.resolve();
    worker.onerror = (error) => abandoned.reject(new Error(error.message));
    try {
      worker.postMessage({ buffer: state.buffer, handle, epoch });
      await abandoned.promise;
    } finally {
      worker.terminate();
    }
    let fencedBeforeUnlock = false;
    state.experimentBeforeUnlock = () => {
      check(state.experimentFileOwner(handle) === 178, "Reaper dropped file lock before fencing");
      try {
        state.checkpointMutations.assertLive();
      } catch {
        fencedBeforeUnlock = true;
      }
    };
    state.revokeOwner(178, epoch);
    check(fencedBeforeUnlock, "Dead-owner mutation was not fenced");
    check(
      !state.experimentFileOwner(handle) && epoch[0] === epochBefore + 2,
      "Reaper did not unlock and repair the odd epoch",
    );
    await rejected(backend.flush(), "Unresolved filesystem mutation");
    await owner.close();
    const recovered = await IndexedDBStorage.open(WORKSPACE);
    try {
      bytesEqual(
        await recovered.read(await fileKey(recovered)),
        new Uint8Array([1, 7, 3]),
        "Recovery selected dead writer's unconfirmed bytes",
      );
    } finally {
      await recovered.close();
    }
    return { settlements, fencedBeforeUnlock, durableBytes: [1, 7, 3] };
  } finally {
    await owner.close();
  }
}

async function staleOwner() {
  const owner = await storeOwner();
  const { backend, storage } = owner;
  let pause: ReturnType<typeof gate> | undefined;
  let replacement: IndexedDBStorage | undefined;
  try {
    await call(backend, "writeFile", [PATH], new Uint8Array([1]));
    await backend.flush();
    const oldHead = storage.experimentHead;
    await call(backend, "writeFile", [PATH], new Uint8Array([2]));
    pause = gate(storage);
    const write = rejected(backend.flush(), "opened in another tab");
    const receipt = await pause.entered;
    replacement = await IndexedDBStorage.open(WORKSPACE);
    pause.release("commit");
    await write;
    check(
      (await replacement.experimentOutcome(receipt)) === "aborted" &&
        replacement.experimentHead === oldHead,
      "Stale writer published after a new epoch opened",
    );
    bytesEqual(
      await replacement.read(await fileKey(replacement)),
      new Uint8Array([1]),
      "Stale writer changed durable bytes",
    );
    return { rejected: true, unchangedHead: true };
  } finally {
    pause?.release("stop");
    await replacement?.close();
    await owner.close();
  }
}

async function crashBeforeTransaction() {
  const worker = new Worker("/crash-before-checkpoint.js", { type: "module" });
  const prepared = Promise.withResolvers<ExperimentReceipt>();
  worker.onmessage = (event: MessageEvent<ExperimentReceipt>) => prepared.resolve(event.data);
  worker.onerror = (error) => prepared.reject(new Error(error.message));
  let receipt: ExperimentReceipt;
  try {
    worker.postMessage("begin");
    receipt = await prepared.promise;
  } finally {
    worker.terminate();
  }
  const reopened = await IndexedDBStorage.open(WORKSPACE);
  try {
    check(
      (await reopened.experimentOutcome(receipt)) === "aborted",
      "Dying before the transaction published a checkpoint",
    );
    bytesEqual(
      await reopened.read(await fileKey(reopened)),
      new Uint8Array([1]),
      "A pretransaction crash changed durable bytes",
    );
    return { stoppedCheckpoint: receipt.id, durablePriorByte: 1 };
  } finally {
    await reopened.close();
  }
}

async function removePhysical(key: IDBValidKey): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("data", "readwrite", { durability: "strict" });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.objectStore("data").delete(key);
    });
  } finally {
    db.close();
  }
}

function blocked(operation: () => unknown, label: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(label);
}

async function reclamation() {
  const owner = await storeOwner(1);
  const { backend, storage } = owner;
  try {
    await call(backend, "writeFile", [PATH], new Uint8Array(2 * CHUNK).fill(1));
    await backend.flush();
    const retired = await fileKey(storage);
    const handle = handleFor(backend);
    for (const byte of [2, 3]) {
      const count = await call(backend, "write", [handle, 0], new Uint8Array([byte]));
      check(count === 1, "Ordinary host write failed");
      await backend.flush();
    }
    const newest = await fileKey(storage);
    const broken = storage.experimentChunkKey(newest, 0);
    check(broken, "Missing newest physical record");
    let lease: ReturnType<IndexedDBStorage["retainPayload"]> | undefined;
    try {
      const retained = await storage.collectExperiment({
        afterMark(keys) {
          check(keys.includes(retired), "Old manifest did not reach the deletion candidates");
          lease = storage.retainPayload(retired, 2 * CHUNK);
        },
      });
      check(retained.marked > retained.deleted, "Reclamation missed a lease acquired after mark");
      bytesEqual(
        await storage.readRange(retired, { offset: 0, length: 2 }),
        new Uint8Array([1, 1]),
        "Cold lease lost its old version",
      );
    } finally {
      lease?.release();
    }
    check(
      storage.resources().readerStorageDebt === 2 * CHUNK,
      "Released cold lease lost deletion debt",
    );
    let guarded = 0;
    const assertProtected = (keys: readonly IDBValidKey[]) => {
      check(keys.includes(retired), "Retired manifest should be queued for deletion");
      blocked(
        () => storage.retainPayload(retired, 2 * CHUNK),
        "Renewed reader entered deletion set",
      );
      blocked(() => storage.experimentReference(retired), "New root entered deletion set");
      guarded++;
    };
    await rejected(
      storage.collectExperiment({
        beforeComplete: assertProtected,
        afterNativeDelete(keys) {
          assertProtected(keys);
          throw new Error("abort reclaim");
        },
      }),
      "IndexedDB transaction aborted",
    );
    check(
      guarded === 2 && storage.resources().readerStorageDebt === 2 * CHUNK,
      "Aborted reclamation lost its retained debt",
    );
    const afterAbort = storage.retainPayload(retired, 2 * CHUNK);
    afterAbort.release();
    const deletion = await storage.collectExperiment({
      beforeComplete: assertProtected,
      afterNativeDelete: assertProtected,
    });
    check(
      Number(guarded) === 4 && deletion.deleted > 0 && storage.resources().readerStorageDebt === 0,
      "Native reclamation did not retire exact debt",
    );
    blocked(
      () => storage.retainPayload(retired, 2 * CHUNK),
      "Deleted manifest still admitted reads",
    );
    await owner.close();
    await removePhysical(broken);
    const reopened = await IndexedDBStorage.open(WORKSPACE);
    let sharedChunk: IDBValidKey | undefined;
    try {
      const previous = await fileKey(reopened);
      check(
        previous !== newest && previous !== retired,
        "Incomplete newest root did not fall back to the complete previous base",
      );
      const expected = new Uint8Array(2 * CHUNK).fill(1);
      expected[0] = 2;
      bytesEqual(await reopened.read(previous), expected, "Previous base lost a shared chunk");
      sharedChunk = reopened.experimentChunkKey(previous, 1);
    } finally {
      await reopened.close();
    }
    check(sharedChunk, "Previous complete root did not include its reused chunk");
    await removePhysical(sharedChunk);
    const corrupt = await IndexedDBStorage.open(WORKSPACE);
    try {
      await rejected(corrupt.load(), "no valid snapshot can be recovered");
    } finally {
      await corrupt.close();
    }
    return { guarded, ...deletion, fallbackVerifiedBytes: 2 * CHUNK, corruptRootsRejected: true };
  } finally {
    await owner.close();
  }
}

function reset(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(WORKSPACE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Private test database still has an open connection"));
  });
}

const cases = {
  orderedCommit: () => ordered(false),
  orderedAbort: () => ordered(true),
  detached,
  reconciliation: reconcile,
  crashBeforeTransaction,
  stageAndDeadOwner,
  staleOwner,
  reclamation,
};

Object.assign(globalThis, {
  async checkpointControls() {
    const results: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(cases)) {
      await reset();
      const start = performance.now();
      try {
        results[name] = { ...(await run()), ms: performance.now() - start };
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.stack : error}`, {
          cause: error,
        });
      }
    }
    await reset();
    return results;
  },
});
