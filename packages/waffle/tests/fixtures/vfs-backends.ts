import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  type FilesystemBackend,
  type FilesystemConnection,
} from "../../fs/index.js";
import { FilesystemError } from "../../fs/protocol.js";
import { PersistentBackend } from "../../fs/persistent.js";
import { MultiTabBackend, type MultiTabOpenStorageOptions } from "../../fs/multitab-backend.js";
import {
  storageLockNameFor,
  type BroadcastChannelLike,
  type LockManagerLike,
  type MultiTabTimings,
} from "../../fs/multitab-protocol.js";
import type { PersistedIndex, PersistenceBatch, StorageBackend } from "../../fs/storage.js";

export type VfsBackendKind = "memory" | "persistent" | "multitab-host" | "multitab-peer";

export const VFS_BACKEND_KINDS: readonly VfsBackendKind[] = [
  "memory",
  "persistent",
  "multitab-host",
  "multitab-peer",
];

interface MockLockRecord {
  readonly name: string;
  readonly mode: LockMode;
  readonly clientId: string;
  readonly release: () => void;
}

interface MockPendingRequest {
  readonly name: string;
  readonly mode: LockMode;
  readonly clientId: string;
  readonly signal?: AbortSignal;
  readonly grant: () => void;
}

class InMemoryLockBroker {
  private held = new Map<string, MockLockRecord[]>();
  private pending = new Map<string, MockPendingRequest[]>();

  forClient(clientId: string): LockManagerLike {
    return {
      query: async (): Promise<LockManagerSnapshot> => {
        const held: LockInfo[] = [];
        for (const list of this.held.values())
          for (const rec of list)
            held.push({ name: rec.name, mode: rec.mode, clientId: rec.clientId });
        const pending: LockInfo[] = [];
        for (const list of this.pending.values())
          for (const req of list)
            pending.push({ name: req.name, mode: req.mode, clientId: req.clientId });
        return { held, pending };
      },
      request: <T>(
        name: string,
        optionsOrCallback: LockOptions | ((lock: Lock | null) => T | Promise<T>),
        maybeCallback?: (lock: Lock | null) => T | Promise<T>,
      ): Promise<T> => {
        const options: LockOptions =
          typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
        const callback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
        const mode: LockMode = options.mode ?? "exclusive";
        if (options.signal?.aborted)
          return Promise.reject(new DOMException("aborted", "AbortError"));
        const canGrant = (): boolean => {
          const current = this.held.get(name) ?? [];
          if (!current.length) return true;
          return mode === "shared" && current.every((item) => item.mode === "shared");
        };
        const runGranted = (): Promise<T> => {
          const list = this.held.get(name) ?? [];
          const rec: MockLockRecord = {
            name,
            mode,
            clientId,
            release: () => {
              const cur = this.held.get(name);
              if (!cur) return;
              const idx = cur.indexOf(rec);
              if (idx >= 0) cur.splice(idx, 1);
              if (!cur.length) this.held.delete(name);
              this.pump(name);
            },
          };
          list.push(rec);
          this.held.set(name, list);
          return Promise.resolve()
            .then(() => callback({ name, mode }))
            .finally(() => rec.release());
        };
        if (options.steal) {
          this.held.delete(name);
          return runGranted();
        }
        if (options.ifAvailable) return canGrant() ? runGranted() : Promise.resolve(callback(null));
        if (canGrant() && !(this.pending.get(name)?.length ?? 0)) return runGranted();
        return new Promise<T>((resolve, reject) => {
          const queue = this.pending.get(name) ?? [];
          const onAbort = () => {
            const idx = queue.indexOf(req);
            if (idx >= 0) queue.splice(idx, 1);
            if (!queue.length) this.pending.delete(name);
            reject(new DOMException("aborted", "AbortError"));
          };
          const req: MockPendingRequest = {
            name,
            mode,
            clientId,
            signal: options.signal,
            grant: () => {
              options.signal?.removeEventListener("abort", onAbort);
              runGranted().then(resolve, reject);
            },
          };
          queue.push(req);
          this.pending.set(name, queue);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
  }

  private pump(name: string): void {
    const queue = this.pending.get(name);
    if (!queue?.length) return;
    while (queue.length) {
      const next = queue[0]!;
      const current = this.held.get(name) ?? [];
      const ok =
        !current.length ||
        (next.mode === "shared" && current.every((item) => item.mode === "shared"));
      if (!ok) break;
      queue.shift();
      next.grant();
      if (next.mode === "exclusive") break;
    }
    if (!queue.length) this.pending.delete(name);
  }
}

function assertUnsharedMessage(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (value instanceof SharedArrayBuffer)
    throw new TypeError("BroadcastChannel payload must not contain SharedArrayBuffer");
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof SharedArrayBuffer)
      throw new TypeError("BroadcastChannel view must not back onto SharedArrayBuffer");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertUnsharedMessage(item);
    return;
  }
  for (const item of Object.values(value)) assertUnsharedMessage(item);
}

class InMemoryBroadcastHub {
  private channels = new Map<string, Set<InMemoryChannel>>();

  create(name: string): BroadcastChannelLike {
    const channel = new InMemoryChannel(this, name);
    const set = this.channels.get(name) ?? new Set<InMemoryChannel>();
    set.add(channel);
    this.channels.set(name, set);
    return channel;
  }

  deliver(sender: InMemoryChannel, name: string, message: unknown): void {
    const peers = this.channels.get(name);
    if (!peers) return;
    assertUnsharedMessage(message);
    const cloned = structuredClone(message);
    for (const peer of Array.from(peers)) {
      if (peer === sender || peer.closed) continue;
      queueMicrotask(() => {
        if (!peer.closed) peer.onmessage?.({ data: structuredClone(cloned) } as MessageEvent);
      });
    }
  }

  remove(channel: InMemoryChannel): void {
    const set = this.channels.get(channel.name);
    set?.delete(channel);
    if (set && !set.size) this.channels.delete(channel.name);
  }
}

class InMemoryChannel implements BroadcastChannelLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(
    private readonly hub: InMemoryBroadcastHub,
    readonly name: string,
  ) {}
  postMessage(message: unknown): void {
    if (this.closed) throw new DOMException("Channel is closed", "InvalidStateError");
    this.hub.deliver(this, this.name, message);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.remove(this);
  }
}

class InMemoryPersistentStore {
  index: PersistedIndex | undefined;
  identityReservation?: { workspace: string; era: bigint };
  payloads = new Map<string, Uint8Array>();
  epoch = 0;
  lastExclusiveEpoch = 0;

  openStorage(
    locks?: LockManagerLike,
    name?: string,
    opts?: MultiTabOpenStorageOptions,
  ): Promise<StorageBackend> {
    return this.openInternal(locks, name, opts);
  }

  private async openInternal(
    locks?: LockManagerLike,
    name?: string,
    opts?: MultiTabOpenStorageOptions,
  ): Promise<StorageBackend> {
    const releaseGate = Promise.withResolvers<void>();
    let lockDone: Promise<void> | undefined;
    let acquired = false;
    if (locks && name) {
      const lockName = storageLockNameFor("indexeddb", name);
      const granted = await new Promise<boolean>((resolve, reject) => {
        const lockOpts: LockOptions =
          opts?.whenBusy === "ifAvailable"
            ? { mode: "exclusive", ifAvailable: true }
            : opts?.whenBusy === "takeover"
              ? { mode: "exclusive", steal: true }
              : { mode: "exclusive", signal: opts?.signal };
        lockDone = locks
          .request(lockName, lockOpts, (lock) => {
            if (!lock) {
              resolve(false);
              return;
            }
            acquired = true;
            resolve(true);
            return releaseGate.promise;
          })
          .catch((error) => {
            reject(error);
            return undefined;
          }) as Promise<void>;
      });
      if (!granted) {
        const busy = new Error("storage busy");
        busy.name = "IndexedDBStorageBusyError";
        throw busy;
      }
      this.epoch++;
      if (opts?.epochOwner !== "attach") this.lastExclusiveEpoch = this.epoch;
    }
    const myEpoch = this.epoch;
    let closed = false;
    const readPayload = async (key: string): Promise<Uint8Array> => {
      const data = this.payloads.get(key);
      if (!data) throw new FilesystemError(44, `missing payload ${key}`);
      return data.slice();
    };
    const storage: StorageBackend & {
      readonly currentEpoch: number;
      readonly lastExclusiveEpoch: number;
      verifyEpoch(): Promise<boolean>;
    } = {
      currentEpoch: myEpoch,
      lastExclusiveEpoch: this.lastExclusiveEpoch,
      verifyEpoch: () => Promise.resolve(!closed && this.epoch === myEpoch),
      load: async () => (this.index ? structuredClone(this.index) : undefined),
      read: readPayload,
      readRange: async (key, range) =>
        (await readPayload(key)).slice(range.offset, range.offset + range.length),
      retainPayload: () => ({ release() {} }),
      checkPayload: (key) => {
        if (!this.payloads.has(key)) throw new FilesystemError(44, `missing payload ${key}`);
      },
      persist: async (batch: PersistenceBatch) => {
        for (const [key, value] of batch.data) this.payloads.set(key, value.slice());
        const nodes = new Map((this.index?.nodes ?? []).map((node) => [node.ino, node]));
        for (const ino of batch.removes) nodes.delete(ino);
        for (const node of batch.upserts) nodes.set(node.ino, structuredClone(node));
        this.index = {
          version: 1,
          generation: batch.generation,
          root: batch.root,
          nodes: Array.from(nodes.values()),
        };
      },
      flush: async () => {},
      reserveIdentity: async (workspace?: string) => {
        const prev = this.identityReservation;
        const next = {
          workspace: prev?.workspace ?? workspace ?? crypto.randomUUID(),
          era: (prev?.era ?? 0n) + 1n,
        };
        this.identityReservation = next;
        return next;
      },
      isTerminallyFailed: () => false,
      terminalFailureReason: () => undefined,
      setTerminalFailureListener: () => {},
      close: async () => {
        if (closed) return;
        closed = true;
        if (acquired) {
          releaseGate.resolve();
          await lockDone?.catch(() => {});
        }
      },
    };
    return storage;
  }
}

const CONFORMANCE_MULTITAB_TIMINGS: Partial<MultiTabTimings> = {
  leaseDurationMs: 600,
  leaseRenewMs: 150,
  leaseClockSafetyMs: 80,
  heartbeatIntervalMs: 150,
  heartbeatTimeoutMs: 600,
  confirmGraceMs: 120,
  attachRetryMs: 40,
  waitPollMs: 30,
  recoverTimeoutMs: 500,
  drainGraceMs: 25,
};

export interface VfsBackendHandle {
  readonly kind: VfsBackendKind;
  readonly backend: FilesystemBackend;
  readonly service: FilesystemService;
  readonly client: FilesystemClient;
  /** For multi-tab backends, the counterpart tab's client (peer when kind is host, host when peer). */
  readonly peerClient?: FilesystemClient;
  readonly peerService?: FilesystemService;
  /** For multi-tab backends, gracefully closes the counterpart tab (e.g. Host failover to Peer). */
  closeCounterpart?(): Promise<void>;
  forkConnection(
    which?: "primary" | "counterpart",
    reserveHandles?: readonly number[],
  ): FilesystemConnection;
  close(): Promise<void>;
}

async function openMultiTabNode(
  broker: InMemoryLockBroker,
  hub: InMemoryBroadcastHub,
  store: InMemoryPersistentStore,
  name: string,
  clientId: string,
): Promise<{
  backend: MultiTabBackend;
  service: FilesystemService;
  client: FilesystemClient;
  close(): Promise<void>;
}> {
  const locks = broker.forClient(clientId);
  const pair = createFilesystemConnection();
  const backend = await MultiTabBackend.open({
    implementation: "indexeddb",
    name,
    sharedRoot: {
      shared: pair.server.shared,
      maxBytes: pair.server.maxBytes,
      segments: pair.server.segments,
    },
    locks,
    createChannel: (channelName) => hub.create(channelName),
    openStorage: (_impl, wsName, opts) => store.openStorage(locks, wsName, opts),
    readEpochMetadata: async () => ({
      epoch: store.epoch,
      lastExclusiveEpoch: store.lastExclusiveEpoch,
    }),
    timings: CONFORMANCE_MULTITAB_TIMINGS,
  });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  let closed = false;
  return {
    backend,
    service,
    client,
    async close() {
      if (closed) return;
      closed = true;
      client.dispose();
      await service.shutdown();
      await backend.close();
      service.dispose();
    },
  };
}

function forkReservedConnection(
  client: FilesystemClient,
  service: FilesystemService,
  reserveHandles?: readonly number[],
): FilesystemConnection {
  const child = createFilesystemConnection(client.connection);
  if (reserveHandles?.length) {
    for (const handle of reserveHandles) {
      const reservation = client.reserve(handle, child.client);
      child.client.reservations.push(reservation);
      child.server.reservations.push(reservation);
    }
  }
  service.connect(child.server);
  return child.client;
}

export async function openVfsBackend(kind: VfsBackendKind): Promise<VfsBackendHandle> {
  if (kind === "memory") {
    const backend = new MemoryBackend();
    const service = new FilesystemService(backend);
    const pair = createFilesystemConnection();
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    return {
      kind,
      backend,
      service,
      client,
      forkConnection(_which, reserveHandles) {
        return forkReservedConnection(client, service, reserveHandles);
      },
      async close() {
        client.dispose();
        await service.shutdown();
        service.dispose();
      },
    };
  }
  if (kind === "persistent") {
    const store = new InMemoryPersistentStore();
    const storage = await store.openStorage();
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    const service = new FilesystemService(backend);
    const pair = createFilesystemConnection();
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    return {
      kind,
      backend,
      service,
      client,
      forkConnection(_which, reserveHandles) {
        return forkReservedConnection(client, service, reserveHandles);
      },
      async close() {
        client.dispose();
        await service.shutdown();
        await backend.close();
        service.dispose();
      },
    };
  }
  const broker = new InMemoryLockBroker();
  const hub = new InMemoryBroadcastHub();
  const store = new InMemoryPersistentStore();
  const name = `conform-${kind}-${crypto.randomUUID()}`;
  const host = await openMultiTabNode(broker, hub, store, name, "tab-host");
  const peer = await openMultiTabNode(broker, hub, store, name, "tab-peer");
  if (host.backend.currentRole !== "host" || peer.backend.currentRole !== "peer") {
    await peer.close();
    await host.close();
    throw new Error(
      `unexpected multitab roles: host=${host.backend.currentRole} peer=${peer.backend.currentRole}`,
    );
  }
  const primary = kind === "multitab-host" ? host : peer;
  const counterpart = kind === "multitab-host" ? peer : host;
  return {
    kind,
    backend: primary.backend,
    service: primary.service,
    client: primary.client,
    peerClient: counterpart.client,
    peerService: counterpart.service,
    closeCounterpart: () => counterpart.close(),
    forkConnection(which = "primary", reserveHandles) {
      const target = which === "counterpart" ? counterpart : primary;
      return forkReservedConnection(target.client, target.service, reserveHandles);
    },
    async close() {
      await peer.close();
      await host.close();
    },
  };
}
