import type {
  IdleWorkspace,
  IdleWorkspaceReadOptions,
  IdleWorkspaceWalkOptions,
  IdleWorkspaceWalk,
} from "./idle-workspace.js";
import { existingDatabase, isWorkspace } from "./idle-database.js";
import { IndexedDBStorage, OWNERSHIP_LOST_MESSAGE } from "./indexeddb.js";
import { restoreTree } from "./persisted-tree.js";
import { maintenanceLock, type StorageLockManager } from "./storage-maintenance.js";
import { attemptCleanup, throwCleanupFailures } from "./cleanup.js";
import { IdleWalk } from "./idle-walk.js";
import type { MemFS, Node } from "./memory.js";
import { FilesystemError } from "./protocol.js";
import type { PersistedIndex } from "./storage.js";

class IdleOwner implements IdleWorkspace {
  private tree: MemFS | undefined;
  private readonly keys = new Map<number, string>();
  private readonly links = new Map<number, number>();
  private readonly cursors = new Set<IdleWorkspaceWalk>();
  private closing: Promise<void> | undefined;
  private readonly abort = () => {
    void this.close().catch(() => {});
  };

  constructor(
    private readonly name: string,
    private readonly storage: IndexedDBStorage,
    index: PersistedIndex | undefined,
    private readonly assertOwned: () => void,
    private readonly release: () => Promise<void>,
    private readonly signal?: AbortSignal,
  ) {
    if (index) {
      this.tree = restoreTree(index);
      this.links.set(index.root, 1);
      for (const node of index.nodes) this.record(node);
    }
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  private record(node: PersistedIndex["nodes"][number]): void {
    if (node.data !== undefined) this.keys.set(node.ino, node.data);
    for (const [, ino] of node.children ?? []) this.links.set(ino, (this.links.get(ino) ?? 0) + 1);
  }

  private check = (): void => {
    this.assertOwned();
    this.signal?.throwIfAborted();
    if (this.closing) throw new Error("Filesystem storage is closed");
  };

  walk(path = "/", options: IdleWorkspaceWalkOptions = {}): IdleWorkspaceWalk {
    this.check();
    const cursor = new IdleWalk(
      this.tree,
      path,
      this.links,
      this.check,
      () => this.cursors.delete(cursor),
      options,
    );
    this.cursors.add(cursor);
    return cursor;
  }

  async listFiles(path: string): Promise<string[]> {
    this.check();
    return this.tree?.listFiles(path) ?? [];
  }

  async readFile(
    path: string,
    options: IdleWorkspaceReadOptions = {},
  ): Promise<Uint8Array | undefined> {
    this.check();
    const maxBytes = options.maxBytes ?? 8388608;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8388608)
      throw new RangeError("maxBytes must be an integer from 0 to 8388608");
    const signal =
      this.signal && options.signal
        ? AbortSignal.any([this.signal, options.signal])
        : (this.signal ?? options.signal);
    signal?.throwIfAborted();
    const node = this.file(path);
    if (node?.kind !== "file") return;
    if (!(node.mode & 0o400)) throw new FilesystemError(2);
    const size = node.size ?? node.data.length;
    if (size > maxBytes) throw new RangeError("Stored file exceeds maxBytes");
    const key = this.keys.get(node.ino);
    const bytes =
      key === undefined ? new Uint8Array() : await this.storage.readReadonly(key, signal);
    this.check();
    signal?.throwIfAborted();
    return bytes;
  }

  private file(path: string): Node | undefined {
    let node: Node | undefined = this.tree?.lookup(path);
    if (!node && path.startsWith("/") && this.tree) {
      const resolved = this.tree.resolveAbsolute(path, true);
      if (typeof resolved !== "number" && resolved.node !== undefined)
        node = this.tree.nodeForHandle(resolved.node);
    }
    return node;
  }

  delete(): Promise<void> {
    try {
      this.check();
    } catch (error) {
      return Promise.reject(error);
    }
    this.closing = this.finish(true);
    return this.closing;
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.finish(false);
    return this.closing;
  }

  private async finish(remove: boolean): Promise<void> {
    let connectionClosed = false;
    const failures: unknown[] = [];
    try {
      for (const cursor of this.cursors) await cursor.close();
      await this.storage.close();
      connectionClosed = true;
      if (remove) await deleteIdleDatabase(this.name, this.assertOwned, this.signal);
    } catch (error) {
      failures.push(error);
    } finally {
      this.signal?.removeEventListener("abort", this.abort);
      this.tree = undefined;
      this.keys.clear();
      this.links.clear();
      if (connectionClosed) await attemptCleanup(failures, this.release);
    }
    throwCleanupFailures(failures, "Idle workspace cleanup failed");
  }
}

async function deleteIdleDatabase(
  name: string,
  assertOwned: () => void,
  signal?: AbortSignal,
): Promise<void> {
  assertOwned();
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  signal?.throwIfAborted();
}

async function finishIdleClaim(
  database: IDBDatabase | undefined,
  debts: Promise<void>[],
  maintenance: { release(): Promise<void> },
): Promise<void> {
  const failures: unknown[] = [];
  await attemptCleanup(failures, () => database?.close());
  const settled = await Promise.allSettled(debts);
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  // Failed native closure keeps ownership, as does unretired opening work.
  if (!failures.length) await attemptCleanup(failures, () => maintenance.release());
  throwCleanupFailures(failures, "Idle database claim cleanup failed");
}

async function requestIdleWriter(
  locks: StorageLockManager,
  name: string,
  callback: (lock: unknown | null) => Promise<void>,
): Promise<void> {
  return locks.request(
    `bun-wasm:filesystem:indexeddb:${name}`,
    { mode: "exclusive", ifAvailable: true },
    callback,
  );
}

function ownershipLost(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof DOMException && error.name === "AbortError" && !signal?.aborted;
}

function idleOwnershipCheck(opening: () => void, connection: () => void): () => void {
  return () => {
    opening();
    connection();
  };
}

export async function openIdle(
  name: string,
  signal?: AbortSignal,
): Promise<IdleWorkspace | "busy" | "missing"> {
  signal?.throwIfAborted();
  if (!globalThis.indexedDB || !globalThis.navigator?.locks)
    throw new Error("IndexedDB storage requires IndexedDB and Web Locks");
  const locks = navigator.locks;
  const maintenance = await maintenanceLock(locks, name, "exclusive", signal);
  if (maintenance === "busy") return "busy";
  const ready = Promise.withResolvers<IdleWorkspace | "busy" | "missing">();
  const held = Promise.withResolvers<void>();
  const debts: Promise<void>[] = [];
  const callbackFinished = Promise.withResolvers<void>();
  void callbackFinished.promise.catch(() => {});
  let released: Promise<void> | undefined;
  let revoke: (() => void) | undefined;
  let entered = false;
  let failure: Error | undefined;
  const assertOwned = () => {
    if (failure) throw failure;
  };
  const release = (): Promise<void> => {
    held.resolve();
    return (released ??= confirmRelease());
  };
  const confirmRelease = async (): Promise<void> => {
    const failures: unknown[] = [];
    const cleanup = await callbackFinished.promise.then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    if (cleanup) failures.push(cleanup.error);
    await lifetime.catch((error: unknown) => {
      if (ownershipLost(error, signal)) return;
      // Callback rejection also rejects request(); it is one failure, not two.
      if (cleanup && Object.is(cleanup.error, error)) return;
      failures.unshift(error);
    });
    await attemptCleanup(failures, () => locks.query());
    throwCleanupFailures(failures, "Idle writer release failed");
  };
  const lifetime = requestIdleWriter(locks, name, async (lock) => {
    entered = true;
    let database: IDBDatabase | undefined;
    try {
      signal?.throwIfAborted();
      if (!lock) return ready.resolve("busy");
      database = await existingDatabase(name, signal, (debt) => debts.push(debt));
      if (!database || !(await isWorkspace(database))) return ready.resolve("missing");
      assertOwned();
      const connection = IndexedDBStorage.readOnlyConnection(database, () => Promise.resolve());
      revoke = connection.revoke;
      const index = await connection.storage.load(signal);
      signal?.throwIfAborted();
      assertOwned();
      const owner = new IdleOwner(
        name,
        connection.storage,
        index,
        idleOwnershipCheck(assertOwned, connection.assertOwned),
        release,
        signal,
      );
      ready.resolve(owner);
      await held.promise;
    } catch (error) {
      ready.reject(error);
    } finally {
      await finishIdleClaim(database, debts, maintenance).then(
        callbackFinished.resolve,
        callbackFinished.reject,
      );
      await callbackFinished.promise;
    }
  });
  void lifetime.catch((error: unknown) => {
    const stolen = ownershipLost(error, signal);
    failure = stolen
      ? new Error(OWNERSHIP_LOST_MESSAGE)
      : error instanceof Error
        ? error
        : new Error(String(error));
    revoke?.();
    ready.reject(stolen ? failure : error);
  });
  const result = await ready.promise.catch(async (error: unknown) => {
    // Cancellation reports promptly; the entered callback still owns late native cleanup.
    if (signal?.aborted && entered) throw error;
    const failures: unknown[] = [error];
    // An entered callback owns its native debts and maintenance cleanup.
    if (entered) await attemptCleanup(failures, () => callbackFinished.promise);
    else await attemptCleanup(failures, () => maintenance.release());
    throwCleanupFailures(failures, "Idle workspace opening cleanup failed");
    throw error;
  });
  if (typeof result === "string") await lifetime;
  return result;
}
