import { describe, expect, test } from "bun:test";
import {
  MultiTabBackend,
  type MultiTabOpenStorageOptions,
  type MultiTabTestHooks,
} from "../fs/multitab-backend.js";
import {
  BoundedWireBuilder,
  MAX_FRAME_BYTES,
  MAX_PENDING_SETTLEMENTS,
  MAX_STAGED_DOWNLOAD_BYTES,
  aliveLockName,
  attachClaimPrefix,
  isReplayableRead,
  multitabScope,
  storageLockNameFor,
  unsharedBytes,
  validateAndStripDirCookie,
  type BroadcastChannelLike,
  type ControlMessage,
  type LockManagerLike,
  type MultiTabTimings,
} from "../fs/multitab-protocol.js";
import { FilesystemClient } from "../fs/client.js";
import { GuestWatchTable } from "../fs/guest-watch.js";
import { FilesystemService, installFilesystemWorker } from "../fs/service.js";
import {
  FilesystemError,
  createFilesystemConnection,
  revokeFilesystemService,
} from "../fs/protocol.js";
import { readIndexedDBEpochMetadata } from "../fs/indexeddb.js";
import type { PersistenceBatch, PersistedIndex, StorageBackend } from "../fs/storage.js";
import { NetHost } from "../browser/net/host.js";
import { createRing } from "../browser/net/ring.js";
import { createNotificationBridge } from "../browser/notification-relay.js";
import { NotificationWaitScope } from "../browser/notification-wait.js";
import { WATCH_OFFSET } from "../fs/storage-geometry.js";

// =============================================================================
// Deterministic In-Memory Harness: Web Locks Broker, BroadcastHub, MockStorage
// =============================================================================

interface MockLockRecord {
  readonly id: number;
  readonly name: string;
  readonly mode: LockMode;
  readonly clientId: string;
  readonly release: () => void;
  aborted: boolean;
}

interface MockPendingRequest {
  readonly name: string;
  readonly mode: LockMode;
  readonly clientId: string;
  readonly signal?: AbortSignal;
  readonly grant: () => void;
  readonly reject: (err: unknown) => void;
}

class MockLockBroker {
  private nextId = 1;
  private held = new Map<string, MockLockRecord[]>();
  private pending = new Map<string, MockPendingRequest[]>();
  /** Optional transient visibility hook (keeps a lock visible in query() for N queries after release). */
  transientVisible = new Map<string, { clientId: string; remainingQueries: number }>();

  forClient(clientId: string): LockManagerLike {
    const getHeld = () => this.held;
    const getPending = () => this.pending;
    const getTransient = () => this.transientVisible;
    const nextLockId = () => this.nextId++;
    const pumpLock = (lockName: string) => this.pump(lockName);
    return {
      query(): Promise<LockManagerSnapshot> {
        const heldList: LockInfo[] = [];
        for (const list of getHeld().values()) {
          for (const rec of list) {
            heldList.push({ name: rec.name, mode: rec.mode, clientId: rec.clientId });
          }
        }
        for (const [name, entry] of Array.from(getTransient())) {
          if (entry.remainingQueries > 0) {
            entry.remainingQueries--;
            heldList.push({ name, mode: "exclusive", clientId: entry.clientId });
          } else {
            getTransient().delete(name);
          }
        }
        const pendingList: LockInfo[] = [];
        for (const list of getPending().values()) {
          for (const req of list) {
            pendingList.push({ name: req.name, mode: req.mode, clientId: req.clientId });
          }
        }
        return Promise.resolve({ held: heldList, pending: pendingList });
      },
      request<T>(
        name: string,
        optionsOrCallback: LockOptions | ((lock: Lock | null) => T | Promise<T>),
        maybeCallback?: (lock: Lock | null) => T | Promise<T>,
      ): Promise<T> {
        const options: LockOptions =
          typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
        const callback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
        const mode: LockMode = options.mode ?? "exclusive";

        if (options.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }

        const canGrant = (): boolean => {
          const current = getHeld().get(name) ?? [];
          if (!current.length) return true;
          if (mode === "shared") return current.every((l) => l.mode === "shared");
          return false;
        };

        const runGranted = (): Promise<T> => {
          const id = nextLockId();
          const list = getHeld().get(name) ?? [];
          const rec: MockLockRecord = {
            id,
            name,
            mode,
            clientId,
            aborted: false,
            release() {
              const cur = getHeld().get(name);
              if (!cur) return;
              const idx = cur.indexOf(rec);
              if (idx >= 0) cur.splice(idx, 1);
              if (!cur.length) getHeld().delete(name);
              pumpLock(name);
            },
          };
          list.push(rec);
          getHeld().set(name, list);
          return Promise.resolve()
            .then(() => callback({ name, mode }))
            .finally(() => {
              rec.release();
            });
        };

        if (options.steal) {
          const prev = getHeld().get(name) ?? [];
          for (const rec of prev) rec.aborted = true;
          getHeld().delete(name);
          return runGranted();
        }

        if (options.ifAvailable) {
          if (!canGrant()) return Promise.resolve(callback(null));
          return runGranted();
        }

        if (canGrant() && !(getPending().get(name)?.length ?? 0)) {
          return runGranted();
        }

        return new Promise<T>((resolve, reject) => {
          const queue = getPending().get(name) ?? [];
          const onAbort = () => {
            const idx = queue.indexOf(req);
            if (idx >= 0) queue.splice(idx, 1);
            if (!queue.length) getPending().delete(name);
            reject(new DOMException("aborted", "AbortError"));
          };
          const req: MockPendingRequest = {
            name,
            mode,
            clientId,
            signal: options.signal,
            grant() {
              options.signal?.removeEventListener("abort", onAbort);
              runGranted().then(resolve, reject);
            },
            reject(err) {
              options.signal?.removeEventListener("abort", onAbort);
              reject(err);
            },
          };
          queue.push(req);
          getPending().set(name, queue);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
  }

  private pump(name: string): void {
    const queue = this.pending.get(name);
    if (!queue || !queue.length) return;
    while (queue.length) {
      const next = queue[0]!;
      const current = this.held.get(name) ?? [];
      const ok =
        !current.length || (next.mode === "shared" && current.every((l) => l.mode === "shared"));
      if (!ok) break;
      queue.shift();
      next.grant();
      if (next.mode === "exclusive") break;
    }
    if (!queue.length) this.pending.delete(name);
  }

  heldNames(): string[] {
    return Array.from(this.held.keys());
  }

  hasLock(name: string, clientId?: string): boolean {
    const list = this.held.get(name) ?? [];
    if (!clientId) return list.length > 0;
    return list.some((l) => l.clientId === clientId);
  }

  /** Simulate abrupt tab crash: release every lock held by clientId immediately! */
  crashClient(clientId: string): void {
    for (const [name, list] of Array.from(this.held)) {
      const remaining = list.filter((l) => l.clientId !== clientId);
      if (remaining.length) this.held.set(name, remaining);
      else this.held.delete(name);
      this.pump(name);
    }
  }
}

class MockBroadcastHub {
  private channels = new Map<string, Set<MockChannel>>();
  /** Optional interceptor: return false to drop a message. */
  interceptor?: (channelName: string, sender: MockChannel, message: unknown) => boolean | void;

  create(name: string, ownerTag = ""): BroadcastChannelLike {
    const ch = new MockChannel(this, name, ownerTag);
    let set = this.channels.get(name);
    if (!set) {
      set = new Set();
      this.channels.set(name, set);
    }
    set.add(ch);
    return ch;
  }

  deliver(sender: MockChannel, name: string, message: unknown): void {
    if (this.interceptor?.(name, sender, message) === false) return;
    const peers = this.channels.get(name);
    if (!peers) return;
    // Clone payload via structuredClone to validate unshared ArrayBuffer discipline (SAB would fail if not cloned carefully, and we assert no SharedArrayBuffer!)
    assertNoSharedArrayBuffer(message);
    const cloned = structuredClone(message);
    for (const peer of Array.from(peers)) {
      if (peer === sender || peer.closed) continue;
      // Preserve FIFO per sender via microtask queue
      queueMicrotask(() => {
        if (peer.closed) return;
        peer.onmessage?.({ data: structuredClone(cloned) } as MessageEvent);
      });
    }
  }

  remove(ch: MockChannel): void {
    const set = this.channels.get(ch.name);
    set?.delete(ch);
    if (set && !set.size) this.channels.delete(ch.name);
  }

  /** Simulate abrupt tab crash: sever all BroadcastChannels owned by ownerTag! */
  killOwner(ownerTag: string): void {
    for (const set of Array.from(this.channels.values())) {
      for (const ch of Array.from(set)) {
        if (ch.ownerTag === ownerTag) ch.close();
      }
    }
  }
}

function assertNoSharedArrayBuffer(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (value instanceof SharedArrayBuffer) {
    throw new TypeError("BroadcastChannel payload must not contain SharedArrayBuffer");
  }
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof SharedArrayBuffer) {
      throw new TypeError("BroadcastChannel Uint8Array view must not back onto SharedArrayBuffer");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSharedArrayBuffer(item);
    return;
  }
  for (const v of Object.values(value)) assertNoSharedArrayBuffer(v);
}

class MockChannel implements BroadcastChannelLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(
    private readonly hub: MockBroadcastHub,
    readonly name: string,
    readonly ownerTag: string,
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

class MockSharedStore {
  index: PersistedIndex | undefined = undefined;
  identityReservation?: { workspace: string; era: bigint };
  payloads = new Map<string, Uint8Array>();
  epoch = 0;
  lastExclusiveEpoch = 0;
  readCount = 0;
  persistCount = 0;
  flushFault?: { failOnce?: unknown; terminal?: unknown; terminalOnClose?: unknown };
  readFault?: { terminal?: unknown };
  beforeRead?: (key: string) => Promise<void> | void;
  beforePersist?: (batch: PersistenceBatch) => Promise<void> | void;

  createOpener(broker: MockLockBroker, clientId: string, impl: "indexeddb" | "opfs-memory") {
    const locks = broker.forClient(clientId);
    return async (
      _impl: "indexeddb" | "opfs-memory",
      name: string,
      opts: MultiTabOpenStorageOptions,
    ): Promise<StorageBackend> => this.openMockStorage(locks, impl, name, opts);
  }

  private async openMockStorage(
    locks: LockManagerLike,
    impl: "indexeddb" | "opfs-memory",
    name: string,
    opts: MultiTabOpenStorageOptions,
  ): Promise<StorageBackend> {
    const lockName = storageLockNameFor(impl, name);
    const releaseGate = Promise.withResolvers<void>();
    let lockDone: Promise<void> | undefined;
    let acquired = false;

    const acquireExclusive = (lockOpts: LockOptions) =>
      new Promise<boolean>((resolve, reject) => {
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
          .catch((err) => {
            reject(err);
            return undefined;
          }) as Promise<void>;
      });

    if (impl === "indexeddb") {
      if (opts.whenBusy === "ifAvailable") {
        const granted = await acquireExclusive({ mode: "exclusive", ifAvailable: true });
        if (!granted) {
          const busy = new Error("storage busy");
          busy.name = "IndexedDBStorageBusyError";
          throw busy;
        }
      } else if (opts.whenBusy === "takeover") {
        if (opts.verifyStealTarget && !opts.verifyStealTarget(await locks.query())) {
          const err = new Error("steal target mismatch");
          err.name = "StealTargetMismatchError";
          throw err;
        }
        if (opts.expectedEpoch !== undefined && opts.expectedEpoch !== this.epoch) {
          const err = new Error("expected epoch mismatch");
          err.name = "ExpectedEpochMismatchError";
          throw err;
        }
        await acquireExclusive({ mode: "exclusive", steal: true });
      } else {
        await acquireExclusive({ mode: "exclusive", signal: opts.signal });
      }
      this.epoch++;
      if (opts.epochOwner !== "attach") {
        this.lastExclusiveEpoch = this.epoch;
      }
    } else {
      const snap = await locks.query();
      if (snap.held?.some((l) => l.name === lockName)) opts.onWaiting?.();
      await acquireExclusive({ mode: "exclusive", signal: opts.signal });
    }

    const myEpoch = this.epoch;
    let closed = false;
    let terminalReason: { value: unknown } | undefined;
    let terminalListener: ((reason: unknown) => void) | undefined;

    const triggerTerminal = (reason: unknown) => {
      if (terminalReason) return;
      terminalReason = { value: reason };
      terminalListener?.(reason);
    };

    const readPayload = async (key: string): Promise<Uint8Array> => {
      if (terminalReason) throw terminalReason.value;
      if (this.readFault && "terminal" in this.readFault) {
        const r = this.readFault.terminal;
        this.readFault = undefined;
        triggerTerminal(r);
        throw r;
      }
      await this.beforeRead?.(key);
      this.readCount++;
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
      verifyEpoch: (): Promise<boolean> =>
        Promise.resolve(!closed && !terminalReason && this.epoch === myEpoch),
      load: async (): Promise<PersistedIndex | undefined> => {
        if (terminalReason) throw terminalReason.value;
        if (!this.index) return undefined;
        return structuredClone(this.index);
      },
      readRange: async (
        key: string,
        range: { offset: number; length: number; signal?: AbortSignal },
      ): Promise<Uint8Array> => {
        const all = await readPayload(key);
        return all.slice(range.offset, range.offset + range.length);
      },
      retainPayload: () => ({ release() {} }),
      checkPayload: (key: string) => {
        if (!this.payloads.has(key)) throw new FilesystemError(44, `missing payload ${key}`);
      },
      read: readPayload,
      persist: async (batch: PersistenceBatch): Promise<void> => {
        if (terminalReason) throw terminalReason.value;
        if (impl === "indexeddb" && this.epoch !== myEpoch) {
          opts.onOwnershipLost?.();
          throw new FilesystemError(11, "epoch fenced");
        }
        await this.beforePersist?.(batch);
        if (this.flushFault && "terminal" in this.flushFault) {
          const r = this.flushFault.terminal;
          this.flushFault = undefined;
          triggerTerminal(r);
          throw r;
        }
        if (this.flushFault && "failOnce" in this.flushFault) {
          const r = this.flushFault.failOnce;
          this.flushFault = undefined;
          throw r;
        }
        this.persistCount++;
        for (const [k, v] of batch.data) this.payloads.set(k, v.slice());
        const nodes = new Map((this.index?.nodes ?? []).map((n) => [n.ino, n]));
        for (const ino of batch.removes) nodes.delete(ino);
        for (const node of batch.upserts) nodes.set(node.ino, structuredClone(node));
        this.index = {
          version: 1,
          generation: batch.generation,
          root: batch.root,
          nodes: Array.from(nodes.values()),
        };
      },
      flush: async (): Promise<void> => {
        if (terminalReason) throw terminalReason.value;
        if (this.flushFault && "terminal" in this.flushFault) {
          const r = this.flushFault.terminal;
          this.flushFault = undefined;
          triggerTerminal(r);
          throw r;
        }
        if (this.flushFault && "failOnce" in this.flushFault) {
          const r = this.flushFault.failOnce;
          this.flushFault = undefined;
          throw r;
        }
      },
      reserveIdentity: async (workspace?: string): Promise<{ workspace: string; era: bigint }> => {
        const prev = this.identityReservation;
        const next = {
          workspace: prev?.workspace ?? workspace ?? crypto.randomUUID(),
          era: (prev?.era ?? 0n) + 1n,
        };
        this.identityReservation = next;
        return next;
      },
      isTerminallyFailed: (): boolean => terminalReason !== undefined,
      terminalFailureReason: (): unknown => terminalReason?.value,
      setTerminalFailureListener: (listener: (reason: unknown) => void): void => {
        terminalListener = listener;
      },
      close: async (): Promise<void> => {
        if (terminalReason) throw terminalReason.value;
        if (this.flushFault && "terminalOnClose" in this.flushFault) {
          const r = this.flushFault.terminalOnClose;
          this.flushFault = undefined;
          triggerTerminal(r);
          throw r;
        }
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

const FAST_TIMINGS: Partial<MultiTabTimings> = {
  leaseDurationMs: 250,
  leaseRenewMs: 60,
  leaseClockSafetyMs: 40,
  heartbeatIntervalMs: 80,
  heartbeatTimeoutMs: 280,
  confirmGraceMs: 60,
  attachRetryMs: 40,
  waitPollMs: 30,
  recoverTimeoutMs: 300,
  drainGraceMs: 40,
  attachIdleTimeoutMs: 900,
};

interface TestTab {
  readonly clientId: string;
  readonly backend: MultiTabBackend;
  readonly service: FilesystemService;
  readonly client: FilesystemClient;
  readonly connection: ReturnType<typeof createFilesystemConnection>;
  readonly states: string[];
  readonly fatals: { error: unknown; released: boolean }[];
  ownershipLostCount: number;
  close(): Promise<void>;
}

async function openTab(
  broker: MockLockBroker,
  hub: MockBroadcastHub,
  store: MockSharedStore,
  options: {
    clientId: string;
    name: string;
    implementation?: "indexeddb" | "opfs-memory";
    timings?: Partial<MultiTabTimings>;
    hooks?: MultiTabTestHooks;
    signal?: AbortSignal;
  },
): Promise<TestTab> {
  const impl = options.implementation ?? "indexeddb";
  const connection = createFilesystemConnection();
  const states: string[] = [];
  const fatals: { error: unknown; released: boolean }[] = [];
  let ownershipLostCount = 0;

  const backend = await MultiTabBackend.open({
    implementation: impl,
    name: options.name,
    sharedRoot: {
      shared: connection.server.shared,
      maxBytes: connection.server.maxBytes,
      segments: connection.server.segments,
    },
    locks: broker.forClient(options.clientId),
    createChannel: (chName) => hub.create(chName, options.clientId),
    openStorage: store.createOpener(broker, options.clientId, impl),
    readEpochMetadata: async () => ({
      epoch: store.epoch,
      lastExclusiveEpoch: store.lastExclusiveEpoch,
    }),
    timings: { ...FAST_TIMINGS, ...options.timings },
    hooks: options.hooks,
    signal: options.signal,
    onState: (s) => states.push(s),
    onOwnershipLost: () => {
      ownershipLostCount++;
    },
    onFatalError: (error, released) => {
      fatals.push({ error, released });
    },
  });

  const service = new FilesystemService(backend);
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);

  return {
    clientId: options.clientId,
    backend,
    service,
    client,
    connection,
    states,
    fatals,
    get ownershipLostCount() {
      return ownershipLostCount;
    },
    async close() {
      client.dispose();
      await service.shutdown().catch(() => {});
      connection.client.port.close();
      connection.server.port.close();
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// =============================================================================
// 1. Protocol Helpers, Cookies, Replay Classification, & Bounded Wire Builder
// =============================================================================

describe("multitab protocol primitives", () => {
  test("unsharedBytes copies SharedArrayBuffer views into plain ArrayBuffer", () => {
    const sab = new SharedArrayBuffer(16);
    const view = new Uint8Array(sab, 4, 6);
    view.set([1, 2, 3, 4, 5, 6]);
    const copy = unsharedBytes(view);
    expect(copy.buffer instanceof ArrayBuffer).toBe(true);
    expect(Array.from(copy)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("directory cookie validation, low-48-bit stripping, and stale tag EBADF", () => {
    expect(validateAndStripDirCookie(0n, 1n)).toBe(0n);
    expect(validateAndStripDirCookie(1n, 5n)).toBe(1n);
    expect(validateAndStripDirCookie(2n, 5n)).toBe(2n);
    const tagged = (7n << 48n) | 42n;
    expect(validateAndStripDirCookie(tagged, 7n)).toBe(42n);
    expect(() => validateAndStripDirCookie(tagged, 8n)).toThrow(FilesystemError);
    try {
      validateAndStripDirCookie(tagged, 8n);
    } catch (err) {
      expect((err as FilesystemError).errno).toBe(8);
    }
  });

  test("replay classification refuses mutations (including preopen) and tagged readdirPage cookies", () => {
    expect(isReplayableRead("readFile", ["/a"])).toBe(true);
    expect(isReplayableRead("stat", [1])).toBe(true);
    expect(isReplayableRead("readdirPage", [1, 0n, 4096])).toBe(true);
    expect(isReplayableRead("readdirPage", [1, 2n, 4096])).toBe(true);
    expect(isReplayableRead("readdirPage", [1, (1n << 48n) | 3n, 4096])).toBe(false);
    expect(isReplayableRead("preopen", ["/"])).toBe(false);
    expect(isReplayableRead("writeFile", ["/a", false, false])).toBe(false);
    expect(isReplayableRead("create", [{}])).toBe(false);
  });

  test("BoundedWireBuilder enforces actual escape-heavy UTF-8 wire bytes with EFBIG & EAGAIN", () => {
    let used = 0;
    const hardCap = 256 * 1024;
    const escapeHeavy = "\u0001".repeat(50_000); // 50 KB raw UTF-8 -> 300 KB JSON escaped (\u0001)!
    const builder = new BoundedWireBuilder(
      hardCap,
      (delta) => {
        used += delta;
        return true;
      },
      (all) => {
        used -= all;
      },
    );
    expect(() => builder.appendPacked(escapeHeavy)).toThrow(FilesystemError);
    expect(used).toBe(0);

    // Transient budget refusal -> EAGAIN (6) and full release
    let budgetUsed = 0;
    const builder2 = new BoundedWireBuilder(
      MAX_STAGED_DOWNLOAD_BYTES,
      (delta) => {
        if (budgetUsed + delta > 64 * 1024) return false;
        budgetUsed += delta;
        return true;
      },
      (all) => {
        budgetUsed -= all;
      },
    );
    try {
      builder2.appendPacked("x".repeat(100_000));
      throw new Error("expected EAGAIN");
    } catch (err) {
      expect((err as FilesystemError).errno).toBe(6);
    }
    expect(budgetUsed).toBe(0);
  });
});

// =============================================================================
// 2. Multi-Tab Live R/W, Chunking, Client NO_DIRECT_IO, & Watch Propagation
// =============================================================================

describe("multitab 2-tab & 3-tab live operations", () => {
  test("2 tabs share live R/W, chunked >1 MiB upload/download, readdirPage continuation, and NO_DIRECT_IO", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      expect(tabA.backend.currentRole).toBe("host");
      expect(tabB.backend.currentRole).toBe("peer");
      expect(tabA.client.shared.isDirectDisabled()).toBe(true);
      expect(tabB.client.shared.isDirectDisabled()).toBe(true);
      expect(tabA.client.shared.isClientCacheDisabled()).toBe(true);
      expect(tabB.client.shared.isClientCacheDisabled()).toBe(true);

      // Host writes, Peer reads live without flush!
      await tabA.client.asyncCall(
        "writeFile",
        ["/hello.txt", false, false],
        new TextEncoder().encode("from-A"),
      );
      const fromB: Uint8Array = await tabB.client.asyncCall("readFile", ["/hello.txt"]);
      expect(new TextDecoder().decode(fromB)).toBe("from-A");

      // Peer writes > 1 MiB chunked payload (1.5 MiB), Host reads!
      const big = new Uint8Array(Math.floor(1.5 * MAX_FRAME_BYTES));
      for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff;
      await tabB.client.asyncCall("writeFile", ["/big.bin", false, false], big);
      const bigOnA: Uint8Array = await tabA.client.asyncCall("readFile", ["/big.bin"]);
      expect(bigOnA.byteLength).toBe(big.byteLength);
      expect(bigOnA[4096]).toBe(1);
      // Peer reads > 1 MiB chunked download back!
      const bigOnB: Uint8Array = await tabB.client.asyncCall("readFile", ["/big.bin"]);
      expect(bigOnB.byteLength).toBe(big.byteLength);
      expect(bigOnB[8192]).toBe(2);

      // Conditional remove with > 1 MiB ifContent chunked upload!
      const wrongBytes = big.slice();
      wrongBytes[0] = (wrongBytes[0] ?? 0) ^ 1;
      expect(await tabB.client.asyncCall("remove", ["/big.bin", true], wrongBytes)).toBe(false);
      expect(await tabB.client.asyncCall("remove", ["/big.bin", true], big)).toBe(true);
      expect(await tabA.client.asyncCall("readFile", ["/big.bin"])).toBeUndefined();

      // Uniform -58 (-ENOTSUP) for tryRead/tryWrite/tryAppend & ioReadiness!
      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      const resolved = await tabB.client.asyncCall("resolve", [rootB, "hello.txt", true]);
      expect(tabB.client.tryRead(resolved.node, [new Uint8Array(8)], 0)).toBe(-58);
      expect(tabB.client.tryWrite(resolved.node, [new Uint8Array(8)], 0)).toBe(-58);
      expect(tabB.client.tryAppend(resolved.node, [new Uint8Array(8)])).toBe(-58);
      expect(tabB.client.ioReadiness(resolved.node, false)).toEqual({
        readable: true,
        writable: false,
        hangup: false,
      });

      // Same-session multi-page readdirPage continuation (low 48-bit strip + high 16-bit tag!)
      for (let i = 0; i < 6; i++) {
        await tabA.client.asyncCall("writeFile", [`/f${i}.txt`, false, false], new Uint8Array([i]));
      }
      const page1: Uint8Array = await tabB.client.asyncCall("readdirPage", [rootB, 0n, 96]);
      expect(page1.byteLength).toBeGreaterThan(24);
      const view1 = new DataView(page1.buffer, page1.byteOffset, page1.byteLength);
      // Walk entries in page1 to extract last complete entry's cookie
      let off = 0;
      let lastCookie = 0n;
      while (off + 24 <= page1.byteLength) {
        const nextCookie = view1.getBigUint64(off, true);
        const nameLen = view1.getUint32(off + 16, true);
        if (off + 24 + nameLen > page1.byteLength) break;
        lastCookie = nextCookie;
        off += 24 + nameLen;
      }
      expect(lastCookie).toBeGreaterThan(0n);
      const page2: Uint8Array = await tabB.client.asyncCall("readdirPage", [
        rootB,
        lastCookie,
        4096,
      ]);
      expect(page2.byteLength).toBeGreaterThan(0);

      // Stale tagged cookie from another epoch fails with EBADF (8)!
      const badTagged = (99n << 48n) | 3n;
      let staleErr: unknown;
      try {
        await tabB.client.asyncCall("readdirPage", [rootB, badTagged, 4096]);
      } catch (err) {
        staleErr = err;
      }
      expect(staleErr).toMatchObject({ errno: 8 });
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("cross-tab fs.watch propagates events and supports immediate guest drain (remote: true)", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-watch-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      const watchId: number = await tabB.client.asyncCall("watchOpen", [rootB, true]);

      // Write on Host A -> Peer B drains watch immediately!
      await tabA.client.asyncCall(
        "writeFile",
        ["/watched.txt", false, false],
        new TextEncoder().encode("hi"),
      );
      const batch = await tabB.client.asyncCall("watchRead", [watchId]);
      expect(batch.kind).toBe("events");
      expect(batch.events.some((e: { name: string | null }) => e.name === "watched.txt")).toBe(
        true,
      );

      // Watch close cleans up cleanly
      await tabB.client.asyncCall("watchClose", [watchId]);
      expect(tabA.backend.resources().multitabHostPeers).toBe(1);
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("pre-preparation & mid-hydration readFile identity replacement refuses >32 MiB with 0 bytes hydrated", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-readfile-${crypto.randomUUID()}`;

    // Pre-populate store with a small cold file /p and a huge >32 MiB cold file /huge
    const preTab = await openTab(broker, hub, store, { clientId: "seed", name });
    await preTab.client.asyncCall("writeFile", ["/p", false, false], new Uint8Array([1, 2, 3]));
    await preTab.client.asyncCall("writeFile", ["/huge", false, false], new Uint8Array([9]));
    await preTab.client.asyncCall("flush", []);
    await preTab.close();
    // Inflate /huge's persisted metadata size to > 32 MiB without needing 33 MiB of RAM!
    const hugeNode = store.index!.nodes.find((n) => n.kind === "file" && n.size === 1)!;
    (hugeNode as { size: number }).size = MAX_STAGED_DOWNLOAD_BYTES + 1024;
    store.readCount = 0;

    let swapBeforeHydrate = false;
    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      hooks: {
        async beforeReadFileHydrate(path) {
          if (path === "/p" && !swapBeforeHydrate) {
            swapBeforeHydrate = true;
            // Replace /p with the cold >32 MiB /huge file right before hydration!
            await tabA.client.asyncCall("move", ["/huge", "/p"]);
          }
        },
      },
    });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      await expect(tabB.client.asyncCall("readFile", ["/p"])).rejects.toMatchObject({ errno: 22 });
      // Zero bytes of the >32 MiB file were ever hydrated from storage!
      expect(store.readCount).toBe(0);
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });
});

// =============================================================================
// 3. Failover, Lease Expiry, Cooperative OPFS Step-Down, & Terminal Failures
// =============================================================================

describe("multitab failover, cooperative step-down, and terminal storage failure", () => {
  test("graceful Host close promotes Peer with zero lost writes and watch overflow", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-graceful-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      const watchId: number = await tabB.client.asyncCall("watchOpen", [rootB, false]);

      // Write on Host A WITHOUT explicit flush, then close A gracefully -> A flushes before stepping down!
      await tabA.client.asyncCall(
        "writeFile",
        ["/survive.txt", false, false],
        new TextEncoder().encode("durable-on-close"),
      );
      await tabA.close();

      await waitUntil(() => tabB.backend.currentRole === "host", 3000, "tabB host promotion");
      const content: Uint8Array = await tabB.client.asyncCall("readFile", ["/survive.txt"]);
      expect(new TextDecoder().decode(content)).toBe("durable-on-close");

      // Watch opened before failover delivers honest overflow!
      const batch = await tabB.client.asyncCall("watchRead", [watchId]);
      expect(batch.kind).toBe("overflow");
    } finally {
      await tabB.close();
      tabA.client.dispose();
      tabA.connection.client.port.close();
      tabA.connection.server.port.close();
      hub.killOwner("tab-A");
    }
  });

  test("abrupt Host crash promotes Peer immediately (0 ms cutover wait when only shared watchers remain)", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-crash-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      await tabA.client.asyncCall(
        "writeFile",
        ["/flushed.txt", false, false],
        new TextEncoder().encode("saved"),
      );
      await tabA.client.asyncCall("flush", []);

      // Abrupt crash: kill A's locks AND sever A's channels without close()
      hub.killOwner("tab-A");
      broker.crashClient("tab-A");
      const started = performance.now();
      await waitUntil(() => tabB.backend.currentRole === "host", 3000, "tabB crash promotion");
      expect(performance.now() - started).toBeLessThan(1500);

      const bytes: Uint8Array = await tabB.client.asyncCall("readFile", ["/flushed.txt"]);
      expect(new TextDecoder().decode(bytes)).toBe("saved");
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("recoverable cooperative OPFS flush failure + expired first renewal restores ready & executes retryQueue once", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-opfs-recover-${crypto.randomUUID()}`;

    const flushGate = Promise.withResolvers<void>();
    let renewalCount = 0;
    let delayFirstRestoreCheck = false;
    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      implementation: "opfs-memory",
      timings: { leaseDurationMs: 120, leaseRenewMs: 5000 },
      hooks: {
        async beforeCooperativeFlush() {
          await flushGate.promise;
        },
        beforeCooperativeRestoreRenewal(_attemptId, attempt) {
          renewalCount = attempt;
          if (attempt === 1) delayFirstRestoreCheck = true;
        },
        async afterLeaseCheck() {
          if (delayFirstRestoreCheck) {
            delayFirstRestoreCheck = false;
            // Delay AFTER anchored startMono so the first renewal window expires!
            await new Promise((r) => setTimeout(r, 150));
          }
        },
      },
    });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      implementation: "opfs-memory",
    });

    try {
      // Acknowledge write on A (unflushed in memory!)
      await tabA.client.asyncCall(
        "writeFile",
        ["/ack.txt", false, false],
        new TextEncoder().encode("kept"),
      );

      // Trigger cooperative-step-down on A
      const ctrl = hub.create(
        `waffle:multitab:v1:ctrl:${multitabScope("opfs-memory", name)}`,
        "probe",
      );
      ctrl.postMessage({
        kind: "cooperative-step-down",
        targetAttemptId: tabA.backend.attemptId!,
        targetTerm: tabA.backend.currentHostTerm.toString(16),
      } satisfies ControlMessage);

      // Wait until A is retiring, then issue a Peer mutation which gets { retry: true }!
      await waitUntil(() => tabA.backend.currentPhase === "retiring", 2000, "A retiring");
      const peerWrite = tabB.client.asyncCall(
        "writeFile",
        ["/peer-retry.txt", false, false],
        new TextEncoder().encode("retried-once"),
      );

      // Let A's lease expire while Step 3 flush is paused, then inject recoverable flush failure!
      await new Promise((r) => setTimeout(r, 150));
      store.flushFault = { failOnce: new Error("transient disk hiccup") };
      flushGate.resolve();
      await peerWrite;

      expect(tabA.backend.currentRole).toBe("host");
      expect(tabA.backend.currentPhase).toBe("ready");
      expect(renewalCount).toBeGreaterThanOrEqual(2);
      // Both the acknowledged unflushed write AND the retried peer write are intact!
      expect(new TextDecoder().decode(await tabB.client.asyncCall("readFile", ["/ack.txt"]))).toBe(
        "kept",
      );
      expect(
        new TextDecoder().decode(await tabA.client.asyncCall("readFile", ["/peer-retry.txt"])),
      ).toBe("retried-once");
      ctrl.close();
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("terminal OPFS flush failure enters host-failed, rejects retryQueue with EIO, resolves watchRead with overflow, and retains attempt locks", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-opfs-term-${crypto.randomUUID()}`;

    const flushGate = Promise.withResolvers<void>();
    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      implementation: "opfs-memory",
      hooks: {
        async beforeCooperativeFlush() {
          await flushGate.promise;
        },
      },
    });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      implementation: "opfs-memory",
    });

    try {
      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      const watchId: number = await tabB.client.asyncCall("watchOpen", [rootB, false]);

      // Trigger cooperative-step-down with a TERMINAL OPFS close error (undefined falsy reason!)
      store.flushFault = { terminal: undefined };
      const ctrl = hub.create(
        `waffle:multitab:v1:ctrl:${multitabScope("opfs-memory", name)}`,
        "probe",
      );
      ctrl.postMessage({
        kind: "cooperative-step-down",
        targetAttemptId: tabA.backend.attemptId!,
        targetTerm: tabA.backend.currentHostTerm.toString(16),
      } satisfies ControlMessage);

      await waitUntil(() => tabA.backend.currentPhase === "retiring", 2000, "A retiring");
      const peerWrite = tabB.client.asyncCall(
        "writeFile",
        ["/queued.txt", false, false],
        new TextEncoder().encode("nope"),
      );

      // Release flush -> terminal failure!
      flushGate.resolve();

      // Queued Peer mutation rejects with EIO (29), zero replay!
      await expect(peerWrite).rejects.toMatchObject({ errno: 29 });

      // Peer's open watch delivers overflow (never EIO!)
      const batch = await tabB.client.asyncCall("watchRead", [watchId]);
      expect(batch.kind).toBe("overflow");

      // Host A entered terminal failure, retained attempt locks, and reported released: false!
      expect(tabA.backend.isTerminallyFailed).toBe(true);
      expect(tabA.fatals.length).toBe(1);
      expect(tabA.fatals[0]!.released).toBe(false);
      expect(
        broker
          .heldNames()
          .some((n) => n.startsWith(attachClaimPrefix(multitabScope("opfs-memory", name)))),
      ).toBe(true);
      expect(
        broker.hasLock(aliveLockName(multitabScope("opfs-memory", name), tabA.backend.attemptId!)),
      ).toBe(true);

      // Even after beginDispose() + shutdown(), Host A STILL answers discover with host-failed!
      tabA.backend.beginDispose();
      await expect(tabA.service.shutdown()).rejects.toMatchObject({ released: false });

      const probeReplies: ControlMessage[] = [];
      ctrl.onmessage = (e) => probeReplies.push(e.data as ControlMessage);
      ctrl.postMessage({ kind: "discover", fromPeerId: "late-peer" } satisfies ControlMessage);
      const hasHostFailed = () => probeReplies.some((m) => m.kind === "host-failed");
      await waitUntil(hasHostFailed, 1000, "host-failed reply");
      ctrl.close();
    } finally {
      await tabB.close();
      tabA.client.dispose();
      tabA.connection.client.port.close();
      tabA.connection.server.port.close();
      hub.killOwner("tab-A");
    }
  });

  test("normal-service OPFS handle-eviction terminal failure blocks paused already-admitted RPC from publishing success", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-opfs-evict-${crypto.randomUUID()}`;

    // Seed a cold file
    const seed = await openTab(broker, hub, store, {
      clientId: "seed",
      name,
      implementation: "opfs-memory",
    });
    await seed.client.asyncCall(
      "writeFile",
      ["/cold.txt", false, false],
      new TextEncoder().encode("cold"),
    );
    await seed.client.asyncCall("flush", []);
    await seed.close();

    const publishGate = Promise.withResolvers<void>();
    let pausedWrite = false;
    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      implementation: "opfs-memory",
      hooks: {
        async beforeHostReplyPublish(op) {
          if (op === "writeFile" && !pausedWrite) {
            pausedWrite = true;
            await publishGate.promise;
          }
        },
      },
    });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      implementation: "opfs-memory",
    });
    try {
      // Peer starts a writeFile which pauses right before reply publication
      const admittedWrite = tabB.client
        .asyncCall("writeFile", ["/paused.txt", false, false], new TextEncoder().encode("p"))
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
      await waitUntil(() => pausedWrite, 2000, "pausedWrite");

      // Cold read on Host triggers terminal OPFS handle eviction failure!
      store.readFault = { terminal: new Error("eviction close failed") };
      await expect(tabA.client.asyncCall("readFile", ["/cold.txt"])).rejects.toThrow();

      // Release paused reply -> must NOT publish success (must reject with EIO 29)!
      publishGate.resolve();
      const outcome = await admittedWrite;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect((outcome.error as FilesystemError).errno).toBe(29);
      expect(tabA.backend.isTerminallyFailed).toBe(true);
      expect(tabA.fatals[0]?.released).toBe(false);
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("dispose() with checkpoint error and confirmed storage.close() reports released: true", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-ckpt-released-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    await tabA.client.asyncCall(
      "writeFile",
      ["/a.txt", false, false],
      new TextEncoder().encode("1"),
    );
    store.flushFault = { failOnce: new Error("checkpoint failed") };

    const scope = {
      onmessage: null as ((event: MessageEvent<any>) => void) | null,
      messages: [] as any[],
      postMessage(msg: unknown) {
        this.messages.push(msg);
      },
    };
    // Verify backend.close() rejects with released: true and releases all locks!
    let caught: any;
    try {
      await tabA.service.shutdown();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.released).toBe(true);
    expect(broker.heldNames()).toEqual([]);
    tabA.client.dispose();
    tabA.connection.client.port.close();
    tabA.connection.server.port.close();
    void scope;
  });

  test("dispose() with lease ALREADY expired before beginDispose() advertises retiring and flushes acknowledged writes", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-expired-dispose-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      timings: { leaseDurationMs: 80, leaseRenewMs: 5000 }, // disable background renewal so lease expires
    });
    try {
      await tabA.client.asyncCall(
        "writeFile",
        ["/ack.txt", false, false],
        new TextEncoder().encode("must-flush"),
      );
      // Wait past leaseDurationMs so lease is ALREADY expired BEFORE beginDispose()!
      await new Promise((r) => setTimeout(r, 110));
      expect(tabA.backend.isLeaseValid()).toBe(false);

      tabA.backend.beginDispose();

      // Probing Peer MUST receive lease-independent host-status("retiring")!
      const ctrl = hub.create(
        `waffle:multitab:v1:ctrl:${multitabScope("indexeddb", name)}`,
        "probe",
      );
      const replies: ControlMessage[] = [];
      ctrl.onmessage = (e) => replies.push(e.data as ControlMessage);
      ctrl.postMessage({ kind: "discover", fromPeerId: "probe" } satisfies ControlMessage);
      const hasRetiringReply = () =>
        replies.some((m) => m.kind === "host-status" && m.phase === "retiring");
      await waitUntil(hasRetiringReply, 1000, "retiring status reply");
      ctrl.close();

      // Local queued write fails ECANCELED while close() still flushes /ack.txt durably!
      await expect(
        tabA.client.asyncCall("writeFile", ["/late.txt", false, false], new Uint8Array([1])),
      ).rejects.toMatchObject({ errno: 11 });

      await tabA.close();
      expect(store.index?.nodes.some((n) => n.kind === "file" && n.size === 10)).toBe(true);
    } finally {
      await tabA.close();
    }
  });

  test("MAX_PENDING_SETTLEMENTS (1024) cap triggers session reset before exceeding 1024", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-settle-cap-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      timings: { heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 15000 },
    });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      timings: { heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 15000 },
    });

    try {
      const initialSessionId = tabB.backend.sessionId;
      // Drop all settled/unpin confirmations so pendingUnpins accumulates!
      hub.interceptor = (_ch, _sender, msg) => {
        if (
          msg &&
          typeof msg === "object" &&
          (Reflect.get(msg, "kind") === "settled" || Reflect.get(msg, "kind") === "unpin")
        ) {
          return false;
        }
      };

      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      // Trigger redundant canonical-handle unpins by calling resolve(".", ...) repeatedly!
      for (let i = 0; i < MAX_PENDING_SETTLEMENTS + 5; i++) {
        await tabB.client.asyncCall("resolve", [rootB, ".", true]);
        expect(tabB.backend.resources().multitabPeerPendingSettlements).toBeLessThanOrEqual(
          MAX_PENDING_SETTLEMENTS,
        );
        if (tabB.backend.sessionId !== initialSessionId) break;
      }
      await waitUntil(
        () => tabB.backend.sessionId !== undefined && tabB.backend.sessionId !== initialSessionId,
        2000,
        "session reset at settlement cap",
      );
      expect(tabB.backend.resources().multitabPeerPendingSettlements).toBeLessThanOrEqual(
        MAX_PENDING_SETTLEMENTS,
      );
    } finally {
      hub.interceptor = undefined;
      await tabB.close();
      await tabA.close();
    }
  });

  test("external-takeover receiver filter fails old cohort (epoch 1) while fresh cohort (epoch 3) ignores it", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-takeover-filter-${crypto.randomUUID()}`;

    // Old cohort at epoch 1
    const oldHost = await openTab(broker, hub, store, { clientId: "old-host", name });
    const oldPeer = await openTab(broker, hub, store, { clientId: "old-peer", name });
    const workspaceId = oldHost.backend.workspaceId!;
    // Advance store epoch to 2 (legacy) then 3 (fresh cohort)
    store.epoch = 2;
    store.lastExclusiveEpoch = 2;
    broker.crashClient("old-host");

    const freshHost = await openTab(broker, hub, store, { clientId: "fresh-host", name });
    const freshPeer = await openTab(broker, hub, store, { clientId: "fresh-peer", name });
    try {
      expect(freshHost.backend.workspaceId).toBe(workspaceId);
      expect(store.epoch).toBe(3);

      // Broadcast stale external-takeover(lastExclusiveEpoch: 2, affectedEpoch: 1) from oldHost
      const ctrl = hub.create(
        `waffle:multitab:v1:ctrl:${multitabScope("indexeddb", name)}`,
        "stale",
      );
      ctrl.postMessage({
        kind: "external-takeover",
        attemptId: oldHost.backend.attemptId!,
        hostTerm: oldHost.backend.currentHostTerm.toString(16),
        workspaceId,
        lastExclusiveEpoch: 2,
        affectedEpoch: 1,
      } satisfies ControlMessage);

      await waitUntil(() => oldPeer.ownershipLostCount === 1, 1000, "oldPeer ownership lost");
      expect(freshHost.ownershipLostCount).toBe(0);
      expect(freshPeer.ownershipLostCount).toBe(0);

      // Fresh cohort continues operating undisturbed!
      await freshPeer.client.asyncCall(
        "writeFile",
        ["/ok.txt", false, false],
        new TextEncoder().encode("fresh"),
      );
      expect(
        new TextDecoder().decode(await freshHost.client.asyncCall("readFile", ["/ok.txt"])),
      ).toBe("fresh");
      ctrl.close();
    } finally {
      await freshPeer.close();
      await freshHost.close();
      await oldPeer.close();
      await oldHost.close();
    }
  });

  test("pre-ready OPFS native close failure propagates released: false through startup disposal without swallowing", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-preready-fail-${crypto.randomUUID()}`;

    const messages: any[] = [];
    const scope = {
      onmessage: null as ((event: MessageEvent<any>) => void) | null,
      postMessage(msg: unknown) {
        messages.push(msg);
      },
    };
    const openedGate = Promise.withResolvers<void>();
    store.flushFault = { terminalOnClose: new Error("native OPFS handle refused to close") };

    const conn = createFilesystemConnection();
    installFilesystemWorker(scope, (_opts, _stage, signal, _wait, callbacks) =>
      MultiTabBackend.open({
        implementation: "opfs-memory",
        name,
        locks: broker.forClient("tab-pre"),
        createChannel: (c) => hub.create(c, "tab-pre"),
        openStorage: store.createOpener(broker, "tab-pre", "opfs-memory"),
        timings: FAST_TIMINGS,
        signal,
        onFatalError: callbacks?.onFatalError,
        hooks: {
          async beforeCutoverBarrier() {
            openedGate.resolve();
            await new Promise((r) => setTimeout(r, 80));
          },
        },
      }),
    );

    scope.onmessage?.(new MessageEvent("message", { data: { connect: conn.server } }));
    await openedGate.promise;
    // Concurrent dispose during startup!
    scope.onmessage?.(new MessageEvent("message", { data: { dispose: true } }));

    const hasDisposedAck = () => messages.some((m) => m.type === "filesystem-disposed");
    await waitUntil(hasDisposedAck, 3000, "filesystem-disposed ack");
    const disposed = messages.find((m) => m.type === "filesystem-disposed");
    expect(disposed.error).toBeTruthy();
    expect(disposed.released).toBe(false);
    conn.client.port.close();
    conn.server.port.close();
  });
});

// =============================================================================
// 4. Real notification-worker.ts + NetHost + Attach-Only GuestWatchTable Revocation
// =============================================================================

describe("attach-only GuestWatchTable revocation & real notification relay", () => {
  test("revokeFilesystemService increments watch.cells[3] and wakes parked NetHost via real notification-worker.ts once without spinning", async () => {
    const conn = createFilesystemConnection();
    const client = new FilesystemClient(conn.client);
    const watchCells = new Int32Array(conn.client.shared, WATCH_OFFSET, 4);
    const ownerStates = new Int32Array(conn.client.ownerStates);

    const makeWatchFs = (remote: boolean) => ({
      cells: watchCells,
      get revoked() {
        return Atomics.load(ownerStates, 0) !== 0;
      },
      remote,
      open: () => 1,
      read: () => ({ kind: "events" as const, events: [] }),
      close: () => {},
    });

    // Legacy (!remote): pending() stays false after revocation!
    const legacyTable = new GuestWatchTable(makeWatchFs(false));
    expect(legacyTable.open(1, false)).toBe(1);

    // Attach (remote: true): pending() returns true ONCE after revocation until watch_read observes ECANCELED!
    const attachTable = new GuestWatchTable(makeWatchFs(true));
    const watchId = attachTable.open(1, false);
    expect(watchId).toBe(1);

    // Spin up the REAL notification-worker.ts relay!
    const bridge = createNotificationBridge(
      new URL("../browser/notification-worker.ts", import.meta.url).href,
    );
    const scope = new NotificationWaitScope(bridge.connection, client);
    const netHost = new NetHost(createRing(), () => {});
    // Spawn a tiny background worker to revoke AFTER NetHost.poll(5000) has parked on the mixed notification word!
    const revokerUrl = URL.createObjectURL(
      new Blob(
        [
          `self.onmessage = ({ data }) => {
            setTimeout(() => {
              const ownerStates = new Int32Array(data.ownerStates);
              const watchCells = new Int32Array(data.shared, ${WATCH_OFFSET}, 4);
              Atomics.store(ownerStates, 0, 1);
              Atomics.add(watchCells, 3, 1);
              Atomics.notify(watchCells, 3);
              self.postMessage("revoked");
            }, 60);
          };`,
        ],
        { type: "application/javascript" },
      ),
    );
    const revoker = new Worker(revokerUrl);
    try {
      const waitSet = await scope.arm({ network: netHost });
      netHost.attachNotifications(waitSet, () => attachTable);

      const beforeWord = Atomics.load(watchCells, 3);
      revoker.postMessage({
        ownerStates: conn.client.ownerStates,
        shared: conn.client.shared,
      });

      const started = performance.now();
      const pollResult = netHost.poll(5000);
      const elapsed = performance.now() - started;

      expect(pollResult).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(1500);
      expect(Atomics.load(watchCells, 3)).toBe(beforeWord + 1);

      // Also verify revokeFilesystemService() itself increments cells[3] synchronously!
      const conn2 = createFilesystemConnection();
      const client2 = new FilesystemClient(conn2.client);
      const watchCells2 = new Int32Array(conn2.client.shared, WATCH_OFFSET, 4);
      const before2 = Atomics.load(watchCells2, 3);
      revokeFilesystemService(conn2.client);
      expect(Atomics.load(watchCells2, 3)).toBe(before2 + 1);
      client2.dispose();
      conn2.client.port.close();
      conn2.server.port.close();

      // Legacy pending() MUST remain false after revocation!
      expect(legacyTable.pending()).toBe(false);
      // Attach pending() is true until watch_read observes ECANCELED (errno 11)!
      expect(attachTable.pending()).toBe(true);
      const readRes = attachTable.read(watchId, 256);
      expect(readRes.kind).toBe("error");
      if (readRes.kind === "error") expect(readRes.errno).toBe(11);

      // After ECANCELED is observed, pending() returns false so subsequent polls do NOT spin!
      expect(attachTable.pending()).toBe(false);
      const spinStart = performance.now();
      expect(netHost.poll(35)).toBe(0);
      expect(performance.now() - spinStart).toBeGreaterThanOrEqual(30);
    } finally {
      revoker.terminate();
      URL.revokeObjectURL(revokerUrl);
      netHost.dispose();
      scope.dispose();
      await bridge.dispose();
      client.dispose();
      conn.client.port.close();
      conn.server.port.close();
    }
  });
});

// =============================================================================
// 5. Additional Rev 24 §9 Pause-Point, Credit, Cold-Read, Watch, & Waiting Tests
// =============================================================================

describe("multitab Rev 24 pause-point & protocol invariants", () => {
  test("lost attached, req/res, and watch-wake frames recover cleanly via retry and heartbeat pong", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-lost-frames-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    // Drop the first attached frame -> idempotent attach retry succeeds without double-allocating credits!
    let droppedAttached = false;
    hub.interceptor = (_ch, _sender, msg) => {
      if (
        !droppedAttached &&
        msg &&
        typeof msg === "object" &&
        Reflect.get(msg, "kind") === "attached"
      ) {
        droppedAttached = true;
        return false;
      }
    };
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      expect(droppedAttached).toBe(true);
      expect(tabB.backend.currentRole).toBe("peer");
      // Only one peer slot allocated despite retry!
      expect(tabA.backend.resources().multitabHostCreditSlots).toBe(1);

      // Seed file and open watch on B
      await tabA.client.asyncCall(
        "writeFile",
        ["/seed.txt", false, false],
        new TextEncoder().encode("v1"),
      );
      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      const watchId: number = await tabB.client.asyncCall("watchOpen", [rootB, false]);

      // Drop watch-wake frame -> heartbeat pong.latestWakeSeq wakes watchCells[3]!
      let droppedWake = false;
      hub.interceptor = (_ch, _sender, msg) => {
        if (
          !droppedWake &&
          msg &&
          typeof msg === "object" &&
          Reflect.get(msg, "kind") === "watch-wake"
        ) {
          droppedWake = true;
          return false;
        }
      };
      const watchCellsB = new Int32Array(tabB.connection.client.shared, WATCH_OFFSET, 4);
      const beforeWake = Atomics.load(watchCellsB, 3);
      await tabA.client.asyncCall(
        "writeFile",
        ["/seed.txt", false, false],
        new TextEncoder().encode("v2"),
      );
      expect(droppedWake).toBe(true);
      await waitUntil(() => Atomics.load(watchCellsB, 3) > beforeWake, 1500, "pong wake recovery");

      // Drop a mutation req -> FIFO pong detects missing activeReqId -> session reset -> mutation fails EIO!
      let droppedWriteReq = false;
      let droppedReadReq = false;
      hub.interceptor = (_ch, _sender, msg) => {
        if (msg && typeof msg === "object" && Reflect.get(msg, "kind") === "req") {
          if (!droppedWriteReq && Reflect.get(msg, "op") === "writeFile") {
            droppedWriteReq = true;
            return false;
          }
          if (!droppedReadReq && Reflect.get(msg, "op") === "readFile") {
            droppedReadReq = true;
            return false;
          }
        }
      };
      const writeOutcome = tabB.client
        .asyncCall("writeFile", ["/lost.txt", false, false], new TextEncoder().encode("x"))
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
      const readOutcome = tabB.client.asyncCall("readFile", ["/seed.txt"]);

      const wRes = await writeOutcome;
      expect(wRes.ok).toBe(false);
      if (!wRes.ok) expect((wRes.error as FilesystemError).errno).toBe(29);
      // Pure stateless read retries automatically after session reset and succeeds!
      expect(new TextDecoder().decode(await readOutcome)).toBe("v2");
      // Watch opened before session reset delivers overflow!
      expect((await tabB.client.asyncCall("watchRead", [watchId])).kind).toBe("overflow");
    } finally {
      hub.interceptor = undefined;
      await tabB.close();
      await tabA.close();
    }
  });

  test("both cold-read directions revalidate via readVersion across cross-tab writes (#620)", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-cold-read-${crypto.randomUUID()}`;

    // Seed a cold file /cold.txt
    const seed = await openTab(broker, hub, store, { clientId: "seed", name });
    await seed.client.asyncCall(
      "writeFile",
      ["/cold.txt", false, false],
      new TextEncoder().encode("old-bytes"),
    );
    await seed.client.asyncCall("flush", []);
    await seed.close();

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      // Direction 1: Host-local cold descriptor read paused while Peer writes new bytes!
      const rootA: number = await tabA.client.asyncCall("preopen", ["/"]);
      const resA = await tabA.client.asyncCall("resolve", [rootA, "cold.txt", true]);
      let pausedOnce = false;
      const readStarted = Promise.withResolvers<void>();
      const resumeRead = Promise.withResolvers<void>();
      store.beforeRead = async () => {
        if (!pausedOnce) {
          pausedOnce = true;
          readStarted.resolve();
          await resumeRead.promise;
        }
      };

      const coldReadA = tabA.client.asyncCall("read", [resA.node, 32, 0]);
      await readStarted.promise;
      // Peer overwrites /cold.txt while Host-local cold read is in flight!
      await tabB.client.asyncCall(
        "writeFile",
        ["/cold.txt", false, false],
        new TextEncoder().encode("peer-new!"),
      );
      resumeRead.resolve();

      const bytesA: Uint8Array = await coldReadA;
      expect(new TextDecoder().decode(bytesA)).toBe("peer-new!");

      // Direction 2: Reopen cold and pause Peer's cold descriptor read while Host writes new bytes!
      await tabA.client.asyncCall("flush", []);
      await tabB.close();
      await tabA.close();

      store.beforeRead = undefined;
      const tabA2 = await openTab(broker, hub, store, { clientId: "tab-A2", name });
      const tabB2 = await openTab(broker, hub, store, { clientId: "tab-B2", name });
      try {
        const rootB2: number = await tabB2.client.asyncCall("preopen", ["/"]);
        const resB2 = await tabB2.client.asyncCall("resolve", [rootB2, "cold.txt", true]);
        let pausedPeer = false;
        const pStarted = Promise.withResolvers<void>();
        const pResume = Promise.withResolvers<void>();
        store.beforeRead = async () => {
          if (!pausedPeer) {
            pausedPeer = true;
            pStarted.resolve();
            await pResume.promise;
          }
        };
        const coldReadB = tabB2.client.asyncCall("read", [resB2.node, 32, 0]);
        await pStarted.promise;
        await tabA2.client.asyncCall(
          "writeFile",
          ["/cold.txt", false, false],
          new TextEncoder().encode("host-new!"),
        );
        pResume.resolve();
        const bytesB: Uint8Array = await coldReadB;
        expect(new TextDecoder().decode(bytesB)).toBe("host-new!");
      } finally {
        await tabB2.close();
        await tabA2.close();
      }
      return;
    } catch (error) {
      await tabB.close();
      await tabA.close();
      throw error;
    }
  });

  test("mid-hydration readFile replacement refuses cold >32 MiB replacement with 0 bytes hydrated", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-mid-hydrate-${crypto.randomUUID()}`;

    const seed = await openTab(broker, hub, store, { clientId: "seed", name });
    await seed.client.asyncCall("writeFile", ["/p", false, false], new Uint8Array([1, 2, 3]));
    await seed.client.asyncCall("writeFile", ["/huge", false, false], new Uint8Array([9]));
    await seed.client.asyncCall("flush", []);
    await seed.close();
    const hugeNode = store.index!.nodes.find((n) => n.kind === "file" && n.size === 1)!;
    (hugeNode as { size: number }).size = MAX_STAGED_DOWNLOAD_BYTES + 4096;
    store.readCount = 0;

    let swapped = false;
    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      hooks: {
        async afterReadFilePrepare(path) {
          if (path === "/p" && !swapped) {
            swapped = true;
            await tabA.client.asyncCall("move", ["/huge", "/p"]);
          }
        },
      },
    });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      let err: unknown;
      try {
        await tabB.client.asyncCall("readFile", ["/p"]);
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ errno: 22 });
      // Only the initial 3-byte /p was hydrated (1 read), NEVER /huge!
      expect(store.readCount).toBe(1);
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("overflow watchRead cancelled after final take & guest teardown rolls back batch and redelivers", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-watch-rollback-${crypto.randomUUID()}`;
    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      const watchId: number = await tabB.client.asyncCall("watchOpen", [
        await tabB.client.asyncCall("preopen", ["/"]),
        false,
      ]);

      // Trigger a watch event, submit watchRead, and cancel BEFORE consuming!
      await tabA.client.asyncCall(
        "writeFile",
        ["/rollback-target.txt", false, false],
        new TextEncoder().encode("1"),
      );
      const comp = tabB.client.submit("watchRead", [watchId]);
      // Wait for Host reply to arrive in shared request buffer, then cancel WITHOUT consuming!
      await waitUntil(() => comp.ready, 1500, "watchRead reply ready");
      comp.cancel();
      comp.release();

      // Wait briefly for watchAck(false) rollback to reach Host and re-arm wake
      await new Promise((r) => setTimeout(r, 40));

      // Next watchRead MUST redeliver the rolled-back event!
      const redelivered = await tabB.client.asyncCall("watchRead", [watchId]);
      expect(redelivered.kind).toBe("events");
      expect(
        redelivered.events.some((e: { name: string | null }) => e.name === "rollback-target.txt"),
      ).toBe(true);
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("queued legacy writer veto (externalPending) & hard-frozen OPFS wait cancel cleanly with ECANCELED on dispose()", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-veto-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    // Freeze A's channels (simulating frozen IndexedDB Host holding storageLock + attach-claim)
    hub.killOwner("tab-A");
    // Enqueue a legacy wait opener on storageLock (creating externalPending === true!)
    const legacyAbort = new AbortController();
    const legacyWait = broker
      .forClient("legacy-waiter")
      .request(
        storageLockNameFor("indexeddb", name),
        { mode: "exclusive", signal: legacyAbort.signal },
        () => {},
      )
      .catch(() => {});

    const tabBAbort = new AbortController();
    const tabBStates: string[] = [];
    const tabBOpening = MultiTabBackend.open({
      implementation: "indexeddb",
      name,
      locks: broker.forClient("tab-B"),
      createChannel: (c) => hub.create(c, "tab-B"),
      openStorage: store.createOpener(broker, "tab-B", "indexeddb"),
      readEpochMetadata: async () => ({
        epoch: store.epoch,
        lastExclusiveEpoch: store.lastExclusiveEpoch,
      }),
      timings: FAST_TIMINGS,
      signal: tabBAbort.signal,
      onState: (s) => tabBStates.push(s),
    }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );

    try {
      await waitUntil(
        () => tabBStates.includes("waiting"),
        2000,
        "tabB enters waiting due to legacy veto",
      );
      // Verify tabA still holds storageLock (tabB refused to steal!)
      expect(broker.hasLock(storageLockNameFor("indexeddb", name), "tab-A")).toBe(true);
      // Cancel tabB via dispose/abort -> fails cleanly with ECANCELED (11)!
      tabBAbort.abort();
      const res = await tabBOpening;
      expect(res.ok).toBe(false);
      if (!res.ok) expect((res.error as { errno?: number }).errno).toBe(11);
    } finally {
      legacyAbort.abort();
      await legacyWait;
      await tabA.close();
    }
  });

  test("per-attempt attemptId mismatch and late host-ready during steal abort recovery without evicting live Host", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-late-ready-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    // Suppress tabA's initial discover replies so tabB enters recovery, then answer host-ready during beforeRecoverySteal!
    let blockDiscover = true;
    hub.interceptor = (_ch, sender, msg) => {
      if (
        blockDiscover &&
        sender.ownerTag === "tab-A" &&
        msg &&
        typeof msg === "object" &&
        Reflect.get(msg, "kind") === "host-ready"
      ) {
        return false;
      }
    };

    let sawBeforeSteal = false;
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      hooks: {
        async beforeRecoverySteal() {
          sawBeforeSteal = true;
          blockDiscover = false;
          // Tab A wakes up and sends host-ready BEFORE steal runs -> continuous targetResponded must abort steal!
          const ctrl = hub.create(
            `waffle:multitab:v1:ctrl:${multitabScope("indexeddb", name)}`,
            "tab-A",
          );
          ctrl.postMessage({
            kind: "host-ready",
            attemptId: tabA.backend.attemptId!,
            clientId: tabA.backend.lockClientId,
            hostTerm: tabA.backend.currentHostTerm.toString(16),
            workspaceId: tabA.backend.workspaceId!,
            storageEpoch: store.epoch,
            lastExclusiveEpoch: store.lastExclusiveEpoch,
          } satisfies ControlMessage);
          ctrl.close();
          await new Promise((r) => setTimeout(r, 15));
        },
      },
    });
    try {
      expect(sawBeforeSteal).toBe(true);
      // Tab A was NEVER evicted and remains Host; Tab B attached cleanly as Peer!
      expect(tabA.backend.currentRole).toBe("host");
      expect(tabB.backend.currentRole).toBe("peer");
      expect(broker.hasLock(storageLockNameFor("indexeddb", name), "tab-A")).toBe(true);
    } finally {
      hub.interceptor = undefined;
      await tabB.close();
      await tabA.close();
    }
  });

  test("in-flight Peer watchRead resolves with overflow (never EIO) when Host fails terminally", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-watch-term-${crypto.randomUUID()}`;

    const publishGate = Promise.withResolvers<void>();
    let pausedWatchRead = false;
    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      implementation: "opfs-memory",
      hooks: {
        async beforeHostReplyPublish(op) {
          if (op === "watchRead" && !pausedWatchRead) {
            pausedWatchRead = true;
            await publishGate.promise;
          }
        },
      },
    });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      implementation: "opfs-memory",
    });
    try {
      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      const watchId: number = await tabB.client.asyncCall("watchOpen", [rootB, false]);

      // Start an in-flight watchRead paused on Host, drop host-failed so EIO RPC reply arrives FIRST!
      hub.interceptor = (_ch, _sender, msg) => {
        if (msg && typeof msg === "object" && Reflect.get(msg, "kind") === "host-failed") {
          return false;
        }
      };
      const inFlightRead = tabB.client.asyncCall("watchRead", [watchId]);
      await waitUntil(() => pausedWatchRead, 2000, "watchRead paused on Host");

      // Trigger terminal OPFS failure on Host A!
      store.flushFault = { terminal: new Error("terminal opfs failure") };
      await expect(tabA.client.asyncCall("flush", [])).rejects.toThrow();
      publishGate.resolve();

      // Even though EIO arrived BEFORE host-failed (which was dropped!), watchRead MUST resolve with overflow!
      const batch = await inFlightRead;
      expect(batch.kind).toBe("overflow");
    } finally {
      hub.interceptor = undefined;
      await tabB.close();
      tabA.client.dispose();
      tabA.connection.client.port.close();
      tabA.connection.server.port.close();
      hub.killOwner("tab-A");
    }
  });

  test("cold readFile queued on Peer during abrupt Host crash hydrates cleanly on promoted Host (IndexedDB and OPFS)", async () => {
    for (const impl of ["indexeddb", "opfs-memory"] as const) {
      const broker = new MockLockBroker();
      const hub = new MockBroadcastHub();
      const store = new MockSharedStore();
      const name = `ws-cold-promote-${impl}-${crypto.randomUUID()}`;

      const tabA = await openTab(broker, hub, store, {
        clientId: "tab-A",
        name,
        implementation: impl,
      });
      const tabB = await openTab(broker, hub, store, {
        clientId: "tab-B",
        name,
        implementation: impl,
      });
      try {
        await tabA.client.asyncCall(
          "writeFile",
          ["/cold-after-crash.txt", false, false],
          new TextEncoder().encode(`payload-${impl}`),
        );
        await tabA.client.asyncCall("flush", []);

        // Abruptly crash Host A and immediately issue a Peer readFile while Tab B is still Peer/failover!
        hub.killOwner("tab-A");
        broker.crashClient("tab-A");
        const bytes: Uint8Array = await tabB.client.asyncCall("readFile", [
          "/cold-after-crash.txt",
        ]);
        expect(new TextDecoder().decode(bytes)).toBe(`payload-${impl}`);
        expect(tabB.backend.currentRole).toBe("host");
      } finally {
        await tabB.close();
        tabA.client.dispose();
        tabA.connection.client.port.close();
        tabA.connection.server.port.close();
      }
    }
  });

  test("OPFS startup racing storage open with host-ready closes storage cleanly and attaches as Peer", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-opfs-race-${crypto.randomUUID()}`;

    const enteredOpen = Promise.withResolvers<void>();
    let closedRacedStorage = false;
    let tabA: TestTab | undefined;
    try {
      // Drop Tab B's host-status so Tab A does not wait for Tab B and mounts as Host immediately.
      hub.interceptor = (_ch, _sender, msg) => {
        if (msg && typeof msg === "object" && Reflect.get(msg, "kind") === "host-status") {
          return false;
        }
      };
      const openingB = MultiTabBackend.open({
        implementation: "opfs-memory",
        name,
        locks: broker.forClient("tab-B"),
        createChannel: (ch) => hub.create(ch, "tab-B"),
        timings: FAST_TIMINGS,
        openStorage: async (_impl, _n, opts) => {
          enteredOpen.resolve();
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) resolve();
            else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // Simulate a racing storage handle that resolved right as host-ready fired
          return {
            load: async () => undefined,
            read: async () => new Uint8Array(),
            readRange: async () => new Uint8Array(),
            retainPayload: () => ({ release() {} }),
            checkPayload: () => {},
            persist: async () => {},
            flush: async () => {},
            reserveIdentity: async () => ({ workspace: crypto.randomUUID(), era: 1n }),
            async close() {
              closedRacedStorage = true;
            },
          };
        },
      });
      await enteredOpen.promise;
      // Tab A sees free storageLock, mounts as Host, and broadcasts host-ready!
      tabA = await openTab(broker, hub, store, {
        clientId: "tab-A",
        name,
        implementation: "opfs-memory",
      });
      const backendB = await openingB;
      try {
        expect(closedRacedStorage).toBe(true);
        expect(backendB.currentRole).toBe("peer");
      } finally {
        await backendB.close();
      }
    } finally {
      hub.interceptor = undefined;
      if (tabA) await tabA.close();
    }
  });

  test("chunked upload interrupted by stepping-down refunds hostUsedUploadBytes and succeeds on retry", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-upload-accounting-${crypto.randomUUID()}`;
    const flushGate = Promise.withResolvers<void>();
    let triggered = false;

    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      implementation: "opfs-memory",
      hooks: {
        async beforeCooperativeFlush() {
          await flushGate.promise;
        },
      },
    });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      implementation: "opfs-memory",
    });
    try {
      store.flushFault = { failOnce: new Error("transient cooperative flush failure") };
      // Intercept the second chunk-put to trigger cooperative step-down mid-upload!
      hub.interceptor = (_ch, _sender, msg) => {
        if (
          !triggered &&
          msg &&
          typeof msg === "object" &&
          Reflect.get(msg, "kind") === "chunk-put" &&
          Reflect.get(msg, "offset") === 1024 * 1024
        ) {
          triggered = true;
          const ctrl = hub.create(
            `waffle:multitab:v1:ctrl:${multitabScope("opfs-memory", name)}`,
            "trigger",
          );
          ctrl.postMessage({
            kind: "cooperative-step-down",
            targetAttemptId: tabA.backend.attemptId!,
            targetTerm: tabA.backend.currentHostTerm.toString(16),
          } satisfies ControlMessage);
          ctrl.close();
          setTimeout(() => flushGate.resolve(), 25);
        }
      };

      const big = new Uint8Array(1536 * 1024);
      big[0] = 42;
      big[big.length - 1] = 99;
      await tabB.client.asyncCall("writeFile", ["/retried-big.bin", false, false], big);
      const readBack: Uint8Array = await tabA.client.asyncCall("readFile", ["/retried-big.bin"]);
      expect(readBack.byteLength).toBe(big.byteLength);
      expect(readBack[0]).toBe(42);
      expect(readBack[readBack.length - 1]).toBe(99);
      expect(tabA.backend.resources().multitabHostUsedUploadBytes).toBe(0);
    } finally {
      hub.interceptor = undefined;
      flushGate.resolve();
      await tabB.close();
      await tabA.close();
    }
  });

  test("session reset with Host death falls through to failover and replayed readdirPage tags fresh dirEpoch", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-reset-failover-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      for (let i = 0; i < 6; i++) {
        await tabA.client.asyncCall(
          "writeFile",
          [`/entry-${i}.txt`, false, false],
          new Uint8Array([i]),
        );
      }
      await tabA.client.asyncCall("flush", []);

      const rootB: number = await tabB.client.asyncCall("preopen", ["/"]);
      // Drop the first readdirPage reply AND kill Host A right when reset starts!
      let dropped = false;
      hub.interceptor = (_ch, _sender, msg) => {
        if (!dropped && msg && typeof msg === "object" && Reflect.get(msg, "kind") === "res") {
          dropped = true;
          setTimeout(() => {
            hub.killOwner("tab-A");
            broker.crashClient("tab-A");
          }, 10);
          return false;
        }
      };

      const page1: Uint8Array = await tabB.client.asyncCall("readdirPage", [rootB, 0n, 96]);
      expect(page1.byteLength).toBeGreaterThan(0);
      // Extract next cookie from page1 and verify continuation succeeds on fresh dirEpoch!
      const view = new DataView(page1.buffer, page1.byteOffset, page1.byteLength);
      let cursor = 0;
      let nextCookie = 0n;
      while (cursor + 24 <= page1.byteLength) {
        nextCookie = view.getBigUint64(cursor, true);
        const nameLen = view.getUint32(cursor + 16, true);
        cursor += 24 + nameLen;
      }
      if (nextCookie >= 3n) {
        const page2: Uint8Array = await tabB.client.asyncCall("readdirPage", [
          rootB,
          nextCookie,
          4096,
        ]);
        expect(page2).toBeInstanceOf(Uint8Array);
      }
      expect(tabB.backend.currentRole).toBe("host");
    } finally {
      hub.interceptor = undefined;
      await tabB.close();
      tabA.client.dispose();
      tabA.connection.client.port.close();
      tabA.connection.server.port.close();
    }
  });

  test("disposal joins in-flight Peer promotion paused before cutover barrier before releasing locks", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-dispose-promote-${crypto.randomUUID()}`;
    const cutoverEntered = Promise.withResolvers<void>();
    const releaseCutover = Promise.withResolvers<void>();

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, {
      clientId: "tab-B",
      name,
      hooks: {
        async beforeCutoverBarrier() {
          cutoverEntered.resolve();
          await releaseCutover.promise;
        },
      },
    });
    try {
      hub.killOwner("tab-A");
      broker.crashClient("tab-A");
      await cutoverEntered.promise;
      // Peer B now holds the IndexedDB writer lock mid-promotion (before cutover barrier)!
      expect(broker.hasLock(`bun-wasm:filesystem:indexeddb:${name}`)).toBe(true);

      let shutdownResolved = false;
      const shutdownPromise = tabB.service.shutdown().then(() => {
        shutdownResolved = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      // Shutdown MUST NOT resolve while promotion still holds storageLock!
      expect(shutdownResolved).toBe(false);
      expect(broker.hasLock(`bun-wasm:filesystem:indexeddb:${name}`)).toBe(true);

      releaseCutover.resolve();
      await shutdownPromise;
      expect(shutdownResolved).toBe(true);
      expect(broker.hasLock(`bun-wasm:filesystem:indexeddb:${name}`)).toBe(false);
      expect(broker.heldNames()).toEqual([]);
    } finally {
      releaseCutover.resolve();
      tabB.client.dispose();
      tabB.connection.client.port.close();
      tabB.connection.server.port.close();
      tabA.client.dispose();
      tabA.connection.client.port.close();
      tabA.connection.server.port.close();
    }
  });

  test("Host-local cold descriptor read and chunk-get enforce lease and terminal state at reply time", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-lease-read-${crypto.randomUUID()}`;

    const seed = await openTab(broker, hub, store, { clientId: "seed", name });
    await seed.client.asyncCall(
      "writeFile",
      ["/cold.txt", false, false],
      new TextEncoder().encode("secret-cold"),
    );
    await seed.client.asyncCall("flush", []);
    await seed.close();

    const readEntered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    store.beforeRead = async () => {
      readEntered.resolve();
      await releaseRead.promise;
    };

    const tabA = await openTab(broker, hub, store, {
      clientId: "tab-A",
      name,
      timings: { leaseDurationMs: 80, leaseRenewMs: 5000 },
    });
    try {
      const rootA: number = await tabA.client.asyncCall("preopen", ["/"]);
      const resolved = await tabA.client.asyncCall("resolve", [rootA, "cold.txt", true]);
      const pendingRead = tabA.client.asyncCall("read", [resolved.node, 32, 0]);
      await readEntered.promise;
      // Expire lease AND latch beginDispose() so renewal cannot extend it!
      await new Promise((r) => setTimeout(r, 110));
      expect(tabA.backend.isLeaseValid()).toBe(false);
      tabA.backend.beginDispose();
      releaseRead.resolve();

      await expect(pendingRead).rejects.toMatchObject({ errno: 11 });
    } finally {
      store.beforeRead = undefined;
      releaseRead.resolve();
      await tabA.close();
    }
  });

  test("Peer lookup enforces directory read permissions (0o100 -> EACCES)", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-lookup-perm-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      await tabA.client.asyncCall("mkdirp", ["/restricted"]);
      await tabA.client.asyncCall(
        "writeFile",
        ["/restricted/secret.txt", false, false],
        new TextEncoder().encode("hi"),
      );
      const rootA: number = await tabA.client.asyncCall("preopen", ["/"]);
      const dir = await tabA.client.asyncCall("resolve", [rootA, "restricted", true]);
      await tabA.client.asyncCall("setMode", [dir.node, 0o100, BigInt(Date.now()) * 1_000_000n]);

      const errA = await tabA.client.asyncCall("lookup", ["/restricted"]).then(
        () => undefined,
        (e) => e,
      );
      expect(errA).toMatchObject({ errno: 2 });
      const errB = await tabB.client.asyncCall("lookup", ["/restricted"]).then(
        () => undefined,
        (e) => e,
      );
      expect(errB).toMatchObject({ errno: 2 });
    } finally {
      await tabB.close();
      await tabA.close();
    }
  });

  test("frozen recoverLock contender is broken after recoverTimeoutMs so another Peer recovers", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-recover-steal-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      await tabA.client.asyncCall(
        "writeFile",
        ["/data.txt", false, false],
        new TextEncoder().encode("ok"),
      );
      await tabA.client.asyncCall("flush", []);

      // Hold recoverLock with a frozen third client!
      const scope = multitabScope("indexeddb", name);
      const recoverName = `waffle:multitab:v1:recover:${scope}`;
      const frozenLocks = broker.forClient("frozen-contender");
      const holdForever = Promise.withResolvers<void>();
      void frozenLocks
        .request(recoverName, { mode: "exclusive" }, () => holdForever.promise)
        .catch(() => {});
      await waitUntil(() => broker.hasLock(recoverName), 1000, "recoverLock held");

      // Freeze Host A (keep its storageLock + attach-claim held in broker, stop its broadcasts!)
      hub.killOwner("tab-A");
      // Peer B must break the frozen recoverLock after recoverTimeoutMs and promote to Host!
      await waitUntil(
        () => tabB.backend.currentRole === "host",
        4000,
        "tabB broke frozen recoverLock",
      );
      const out: Uint8Array = await tabB.client.asyncCall("readFile", ["/data.txt"]);
      expect(new TextDecoder().decode(out)).toBe("ok");
      holdForever.resolve();
    } finally {
      await tabB.close();
      tabA.client.dispose();
      tabA.connection.client.port.close();
      tabA.connection.server.port.close();
    }
  });

  test("cancelled readIndexedDBEpochMetadata closes late-arriving IDBDatabase connection", async () => {
    const controller = new AbortController();
    let closeCount = 0;
    const req: {
      result?: IDBDatabase;
      onsuccess?: () => void;
      onerror?: () => void;
      onupgradeneeded?: () => void;
      onblocked?: () => void;
    } = {};
    const fakeFactory = {
      open: () => req,
    } as unknown as IDBFactory;

    const pending = readIndexedDBEpochMetadata("late-close-db", {
      indexedDB: fakeFactory,
      signal: controller.signal,
    });
    controller.abort(new DOMException("aborted", "AbortError"));
    await expect(pending).rejects.toThrow();

    // Deliver late onsuccess AFTER abort -> must immediately close the database!
    req.result = {
      close() {
        closeCount++;
      },
    } as unknown as IDBDatabase;
    req.onsuccess?.();
    expect(closeCount).toBe(1);
  });

  test("credit-waiter unsent write resumes on session reset and rejects with EIO on terminal Host failure", async () => {
    // Part A: session reset replays unsent credit-waiter write cleanly!
    {
      const broker = new MockLockBroker();
      const hub = new MockBroadcastHub();
      const store = new MockSharedStore();
      const name = `ws-credit-reset-${crypto.randomUUID()}`;
      const gate = Promise.withResolvers<void>();
      let paused = 0;

      const tabA = await openTab(broker, hub, store, {
        clientId: "tab-A",
        name,
        hooks: {
          async beforeHostReplyPublish(op) {
            if (op === "readFile" && paused < 4) {
              paused++;
              await gate.promise;
            }
          },
        },
      });
      const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
      try {
        await tabA.client.asyncCall(
          "writeFile",
          ["/seed.txt", false, false],
          new TextEncoder().encode("s"),
        );
        // Saturate all 4 peer frame credits with paused concurrent readFile calls!
        const reads = Array.from({ length: 4 }, () =>
          Promise.resolve(tabB.backend.execute("readFile", ["/seed.txt"], new Uint8Array())),
        );
        await waitUntil(() => paused === 4, 2000, "4 credits saturated");

        // 5th operation (unsent writeFile) parks in reservePeerCredits!
        const parkedWrite = Promise.resolve(
          tabB.backend.execute(
            "writeFile",
            ["/from-credit-waiter.txt", false, false],
            new TextEncoder().encode("resumed"),
          ),
        );
        // Let parkedWrite reach reservePeerCredits before closing Host A!
        await new Promise((r) => setTimeout(r, 20));
        // Trigger graceful Host close -> failover -> unsent parked write resumes and succeeds!
        gate.resolve();
        await tabA.close();
        await Promise.all(reads);
        await parkedWrite;
        const text = new TextDecoder().decode(
          await tabB.client.asyncCall("readFile", ["/from-credit-waiter.txt"]),
        );
        expect(text).toBe("resumed");
      } finally {
        gate.resolve();
        await tabB.close();
        await tabA.close();
      }
    }

    // Part B: terminal Host failure rejects parked credit-waiter with EIO (29)!
    {
      const broker = new MockLockBroker();
      const hub = new MockBroadcastHub();
      const store = new MockSharedStore();
      const name = `ws-credit-eio-${crypto.randomUUID()}`;
      const gate = Promise.withResolvers<void>();
      let paused = 0;

      const tabA = await openTab(broker, hub, store, {
        clientId: "tab-A",
        name,
        implementation: "opfs-memory",
        hooks: {
          async beforeHostReplyPublish(op) {
            if (op === "readFile" && paused < 4) {
              paused++;
              await gate.promise;
            }
          },
        },
      });
      const tabB = await openTab(broker, hub, store, {
        clientId: "tab-B",
        name,
        implementation: "opfs-memory",
      });
      try {
        await tabA.client.asyncCall(
          "writeFile",
          ["/seed.txt", false, false],
          new TextEncoder().encode("s"),
        );
        const reads: Promise<unknown>[] = [];
        for (let i = 0; i < 4; i++) {
          reads.push(
            Promise.resolve(
              tabB.backend.execute("readFile", ["/seed.txt"], new Uint8Array()),
            ).catch((e) => e),
          );
        }
        await waitUntil(() => paused === 4, 2000, "4 credits saturated");

        const parkedWrite = Promise.resolve(
          tabB.backend.execute(
            "writeFile",
            ["/parked-fail.txt", false, false],
            new TextEncoder().encode("x"),
          ),
        );
        const parkedOutcome = parkedWrite.then(
          () => ({ ok: true }),
          (err) => err,
        );
        await new Promise((r) => setTimeout(r, 20));
        store.flushFault = { terminal: new Error("terminal opfs fail") };
        await expect(tabA.client.asyncCall("flush", [])).rejects.toThrow();
        gate.resolve();

        expect(await parkedOutcome).toMatchObject({ errno: 29 });
        await Promise.all(reads);
      } finally {
        gate.resolve();
        await tabB.close();
        tabA.client.dispose();
        tabA.connection.client.port.close();
        tabA.connection.server.port.close();
        hub.killOwner("tab-A");
      }
    }
  });

  test("attachSocketScope and bindSocket return ENOTSUP (58) on attach backend", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-sockets-enotsup-${crypto.randomUUID()}`;

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const extraConn = createFilesystemConnection();
    try {
      const rootA: number = await tabA.client.asyncCall("preopen", ["/"]);
      expect(() =>
        tabA.service.attachSocketScope(tabA.connection.client, rootA, extraConn.server),
      ).toThrow(/58/);
      const bindErr = await tabA.client.asyncCall("bindSocket", [rootA, "s"]).then(
        () => undefined,
        (e) => e,
      );
      expect(bindErr).toMatchObject({ errno: 58 });
    } finally {
      extraConn.client.port.close();
      extraConn.server.port.close();
      await tabA.close();
    }
  });

  test("chunked upload keeps hostUsedUploadBytes accounted across Host prepare() and execute()", async () => {
    const broker = new MockLockBroker();
    const hub = new MockBroadcastHub();
    const store = new MockSharedStore();
    const name = `ws-upload-live-budget-${crypto.randomUUID()}`;

    const seed = await openTab(broker, hub, store, { clientId: "seed", name });
    await seed.client.asyncCall(
      "writeFile",
      ["/target.bin", false, false],
      new TextEncoder().encode("initial-cold"),
    );
    await seed.client.asyncCall("flush", []);
    await seed.close();

    const readEntered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    store.beforeRead = async () => {
      readEntered.resolve();
      await releaseRead.promise;
    };

    const tabA = await openTab(broker, hub, store, { clientId: "tab-A", name });
    const tabB = await openTab(broker, hub, store, { clientId: "tab-B", name });
    try {
      const payload = new Uint8Array(1_200_000);
      payload.fill(0x5a);
      // Append to a cold file so Host's persistent.prepare("writeFile", ...) hydrates asynchronously!
      const writePromise = tabB.client.asyncCall(
        "writeFile",
        ["/target.bin", true, false],
        payload,
      );
      await readEntered.promise;
      // While Host is paused inside prepare(), the 1.2 MiB upload buffer is STILL live and MUST stay charged!
      expect(tabA.backend.resources().multitabHostUsedUploadBytes).toBe(payload.byteLength);
      releaseRead.resolve();
      await writePromise;
      expect(tabA.backend.resources().multitabHostUsedUploadBytes).toBe(0);
    } finally {
      store.beforeRead = undefined;
      releaseRead.resolve();
      await tabB.close();
      await tabA.close();
    }
  });
});
