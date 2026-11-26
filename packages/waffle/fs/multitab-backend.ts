import type { FileHandle, ResolvedPath } from "../core/index.js";
import { fileTimeMs } from "../core/filesystem.js";
import type { FilesystemBackend, MemoryBackendSharedRoot } from "./backend.js";
import { IndexedDBStorage, readIndexedDBEpochMetadata } from "./indexeddb.js";
import type { MemoryBudget } from "./memory-budget.js";
import type { Node } from "./memory.js";
import { OpfsStorage } from "./opfs.js";
import { PersistentBackend } from "./persistent.js";
import {
  DEFAULT_SHARED_MAX_BYTES,
  FilesystemError,
  errno as errorToErrno,
  pack,
  unpack,
} from "./protocol.js";
import {
  CLIENT_MODE,
  CLIENT_MODE_NO_CLIENT_CACHE,
  CLIENT_MODE_NO_DIRECT_IO,
  CLIENT_MODE_NO_WATCH_DRAIN,
} from "./shared.js";
import type { RuntimeStartupObserver } from "./startup.js";
import type { StorageBackend } from "./storage.js";
import { HEADER_WORDS, WATCH_OFFSET } from "./storage-geometry.js";
import { WatchRing } from "./watch-ring.js";
import { WatchService } from "./watch-service.js";
import type { HeldWatchBatch } from "./watch-subscriptions.js";
import type { WatchBatch } from "./watch.js";
import {
  BoundedWireBuilder,
  DEFAULT_PEER_BYTES,
  DEFAULT_PEER_FRAMES,
  DIR_EPOCH_MAX,
  MAX_CONCURRENT_DOWNLOADS_PER_PEER,
  MAX_CONCURRENT_UPLOADS_PER_PEER,
  MAX_FRAME_BYTES,
  MAX_HOST_FRAMES,
  MAX_HOST_WIRE_BYTES,
  MAX_PENDING_SETTLEMENTS,
  MAX_STAGED_DOWNLOAD_BYTES,
  MAX_STAGED_UPLOAD_BYTES,
  MIN_PEER_BYTES,
  MIN_PEER_FRAMES,
  type MultiTabReleaseError,
  PONG_SETTLEMENT_LIMIT,
  SETTLEMENT_BATCH_SIZE,
  aliveLockName,
  aliveLockPrefix,
  attachClaimLockName,
  attachClaimPrefix,
  controlChannelName,
  describeReason,
  electionLockName,
  formatTerm,
  isControlMessage,
  isPeerMessage,
  isReplayableRead,
  maintenanceLockNameFor,
  multitabScope,
  parseAttachClaimAttemptId,
  parseTerm,
  peerAliveLockName,
  peerChannelName,
  recoverLockName,
  resolveMultiTabTimings,
  storageLockNameFor,
  unsharedBytes,
  validateAndStripDirCookie,
  wrapReleaseError,
  type BroadcastChannelLike,
  type ControlMessage,
  type HostHealthState,
  type LockManagerLike,
  type MultiTabImplementation,
  type MultiTabTimings,
  type PeerCreditLimit,
  type PeerMessage,
  type WirePinnedHandle,
  type WireResolveResult,
} from "./multitab-protocol.js";

const MUTATION_OPS = new Set([
  "preopen",
  "write",
  "append",
  "resize",
  "setTimes",
  "setMode",
  "create",
  "symlink",
  "link",
  "removePath",
  "rename",
  "writeFile",
  "mkdirp",
  "remove",
  "move",
  "grow",
]);

const UNSUPPORTED_ATTACH_OPS = new Set([
  "bindSocket",
  "bindSocketPath",
  "unbindSocket",
  "connectSocket",
  "walkOpen",
  "walkPage",
  "walkRelease",
  "walkClose",
  "stageWrite",
]);

export interface MultiTabTestHooks {
  onControlSend?(message: ControlMessage): boolean | void;
  onPeerSend?(peerId: string, message: PeerMessage): boolean | void;
  beforeLeaseCheck?(attemptId: string): Promise<void> | void;
  afterLeaseCheck?(attemptId: string): Promise<void> | void;
  beforeCutoverBarrier?(attemptId: string): Promise<void> | void;
  beforeReadFileHydrate?(path: string, fileId: bigint): Promise<void> | void;
  afterReadFilePrepare?(path: string, fileId: bigint): Promise<void> | void;
  beforeHostReplyPublish?(op: string, reqId: number): Promise<void> | void;
  beforeRecoveryReadonlyCheck?(): Promise<void> | void;
  beforeRecoverySteal?(): Promise<void> | void;
  afterOpfsAbortBrokerCheck?(attempt: number): Promise<void> | void;
  beforeCooperativeFlush?(attemptId: string): Promise<void> | void;
  beforeCooperativeRestoreRenewal?(attemptId: string, attempt: number): Promise<void> | void;
}

export interface MultiTabOpenStorageOptions {
  readonly whenBusy?: "wait" | "takeover" | "ifAvailable";
  readonly epochOwner?: "exclusive" | "attach";
  readonly expectedEpoch?: number;
  readonly verifyStealTarget?: (snapshot: LockManagerSnapshot) => boolean;
  readonly preStealSignal?: AbortSignal;
  readonly signal?: AbortSignal;
  readonly onWaiting?: () => void;
  readonly onOwnershipLost?: () => void;
  readonly onStartupStage?: RuntimeStartupObserver;
}

export interface MultiTabBackendOptions {
  readonly implementation: MultiTabImplementation;
  readonly name: string;
  readonly startupRoot?: MemoryBudget;
  readonly sharedRoot?: MemoryBackendSharedRoot;
  readonly onStartupStage?: RuntimeStartupObserver;
  readonly signal?: AbortSignal;
  readonly onWaiting?: () => void;
  readonly onState?: (status: "waiting" | "ready") => void;
  readonly onOwnershipLost?: () => void;
  readonly onFatalError?: (error: unknown, released: boolean) => void;
  readonly timings?: Partial<MultiTabTimings>;
  readonly locks?: LockManagerLike;
  readonly createChannel?: (name: string) => BroadcastChannelLike;
  readonly openStorage?: (
    implementation: MultiTabImplementation,
    name: string,
    options: MultiTabOpenStorageOptions,
  ) => Promise<StorageBackend>;
  readonly readEpochMetadata?: (
    name: string,
    signal?: AbortSignal,
  ) => Promise<{ epoch: number; lastExclusiveEpoch: number } | undefined>;
  readonly hooks?: MultiTabTestHooks;
}

interface HeldLock {
  readonly name: string;
  release(): Promise<void>;
}

interface LocalHandleEntry {
  readonly localHandle: number;
  readonly fileId: bigint;
  remoteHandle?: number;
  remoteTerm?: bigint;
  remoteSessionId?: string;
  pinToken?: number;
  stale: boolean;
  unlinked: boolean;
  serviceRefs: number;
  provisional: number;
  releasedDuringRebind?: boolean;
}

interface LocalWatchEntry {
  readonly localWatchId: number;
  readonly localOwner: number;
  readonly fileId: bigint;
  readonly recursive: boolean;
  hostTerm: bigint;
  hostWatchId?: number;
  overflowed: boolean;
  closed: boolean;
}

interface PeerCreditSlot {
  readonly peerId: string;
  reservedFrames: number;
  reservedBytes: number;
  activeInFlightFrames: number;
  activeInFlightBytes: number;
  retiredInFlightFrames: number;
  retiredInFlightBytes: number;
  pendingDetach: boolean;
  deferredAttach?: {
    readonly sessionId: string;
    readonly hostTerm: bigint;
  };
}

interface StagedUpload {
  readonly uploadId: string;
  readonly totalBytes: number;
  readonly buffer: Uint8Array;
  receivedBytes: number;
}

interface StagedDownload {
  readonly downloadId: string;
  readonly bytes: Uint8Array;
  readonly reservedBytes: number;
  readonly watchAckId?: number;
}

interface HostPeerSession {
  readonly peerId: string;
  readonly sessionId: string;
  readonly hostTerm: bigint;
  readonly ownerId: number;
  readonly channel: BroadcastChannelLike;
  readonly pins: Map<number, number>;
  readonly activeReqs: Set<number>;
  readonly uploads: Map<string, StagedUpload>;
  readonly downloads: Map<string, StagedDownload>;
  readonly heldWatches: Map<number, { held: HeldWatchBatch; hostWatchId: number }>;
  readonly watchIds: Set<number>;
  readonly pendingSettledUnpins: number[];
  readonly pendingSettledWatchAcks: number[];
  readonly pendingSettledWatchCloses: number[];
  readonly pendingSettledUploadAborts: string[];
  settledFlushTimer?: ReturnType<typeof setTimeout>;
  latestWakeSeq: number;
  wakeInFlightSeq?: number;
  wakeDirty: boolean;
  lastActivityAt: number;
  peerAliveAbort: AbortController;
  revoked: boolean;
}

class RetryOnHostReadyError extends Error {
  constructor() {
    super("retry");
  }
}
class FailoverReplayError extends Error {
  constructor() {
    super("failover-replay");
  }
}

interface PendingRpc {
  readonly reqId: number;
  readonly op: string;
  /** Original local arguments (with local handles) for safe replay after rebind. */
  readonly localArgs: unknown[];
  readonly data?: Uint8Array;
  readonly payloadBytes: number;
  readonly responseCookieTag?: bigint;
  readonly sent: boolean;
  sentBeforePingId?: number;
  readonly isWatchRead?: boolean;
  readonly localWatchId?: number;
  readonly replayOnSessionBreak?: boolean;
  readonly resolve: (value: any) => void;
  readonly reject: (error: unknown) => void;
}

interface QueuedPeerOp {
  readonly op: string;
  readonly args: unknown[];
  readonly data?: Uint8Array;
  readonly responseCookieTag?: bigint;
  readonly isWatchRead?: boolean;
  readonly localWatchId?: number;
  readonly replayOnSessionBreak?: boolean;
  readonly cancelled?: () => boolean;
  readonly resolve: (value: any) => void;
  readonly reject: (error: unknown) => void;
}

type SettlementItem =
  | { readonly kind: "unpin"; readonly pinToken: number }
  | { readonly kind: "watch-ack"; readonly ackId: number; readonly accepted: boolean }
  | { readonly kind: "watch-close"; readonly hostWatchId: number }
  | { readonly kind: "chunk-abort"; readonly uploadId: string };

function abortError(): FilesystemError {
  return new FilesystemError(11, "operation cancelled");
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof FilesystemError && error.errno === 11) return true;
  if (error && typeof error === "object" && Reflect.get(error, "name") === "AbortError")
    return true;
  return false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAbortOrCancel(
  signal: AbortSignal,
  cancelled?: () => boolean,
): { promise: Promise<void>; cleanup: () => void } {
  let onAbort: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    if (!cancelled) return;
    poll = setInterval(() => {
      if (cancelled()) resolve();
    }, 20);
  });
  const cleanup = () => {
    if (poll) clearInterval(poll);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  };
  return { promise, cleanup };
}

/** Ends one local Host attempt whose only problem is a lapsed lease; the caller renews and retries. */
class LeaseLapsedError extends Error {}
const LEASE_LAPSED = new LeaseLapsedError("host lease lapsed");
/** How long one call may spend renewing a lapsed lease, in lease durations from its first lapse. */
const LEASE_RENEWAL_BUDGET_LEASES = 4;
/** One call's renewal deadline, set at its first lapse and shared by every retry of that call. */
interface LeaseRenewalBudget {
  deadline?: number;
}

async function raceWithAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
  cancelled?: () => boolean,
): Promise<void> {
  if (signal.aborted || cancelled?.()) return;
  const waiter = waitForAbortOrCancel(signal, cancelled);
  try {
    await Promise.race([promise.catch(() => {}), waiter.promise]);
  } finally {
    waiter.cleanup();
  }
}

async function awaitUnlessCancelled<T>(promise: Promise<T>, cancelled?: () => boolean): Promise<T> {
  if (!cancelled) return promise;
  if (cancelled()) {
    void promise.catch(() => {});
    throw abortError();
  }
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      promise.then(resolve, reject);
      poll = setInterval(() => {
        if (cancelled()) reject(abortError());
      }, 20);
    });
  } finally {
    if (poll) clearInterval(poll);
  }
}

function linkAbortSignals(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: [AbortSignal, () => void][] = [];
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener("abort", abort, { once: true });
    listeners.push([sig, abort]);
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [sig, fn] of listeners) sig.removeEventListener("abort", fn);
    },
  };
}

function acquireHeldLock(
  locks: LockManagerLike,
  name: string,
  options: LockOptions,
): Promise<HeldLock | undefined> {
  return new Promise<HeldLock | undefined>((resolve, reject) => {
    let settled = false;
    const done = locks.request(name, options, (lock) => {
      if (!lock) {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
        return;
      }
      const gate = Promise.withResolvers<void>();
      const held: HeldLock = {
        name,
        release() {
          gate.resolve();
          return done.then(
            () => {},
            () => {},
          );
        },
      };
      if (!settled) {
        settled = true;
        resolve(held);
      }
      return gate.promise;
    });
    void done.catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function watchLockRelease(
  locks: LockManagerLike,
  name: string,
  signal: AbortSignal,
  onReleased: () => void,
): void {
  if (signal.aborted) return;
  void locks
    .request(name, { mode: "shared", signal }, () => {
      if (!signal.aborted) onReleased();
    })
    .catch(() => {});
}

function hasAttachClaim(
  snapshot: LockManagerSnapshot,
  scope: string,
  clientId: string | undefined,
): LockInfo | undefined {
  if (!clientId) return undefined;
  const prefix = attachClaimPrefix(scope);
  return snapshot.held?.find(
    (l) => typeof l.name === "string" && l.name.startsWith(prefix) && l.clientId === clientId,
  );
}

function isHeldWatchBatch(value: unknown): value is HeldWatchBatch {
  return (
    typeof value === "object" &&
    value !== null &&
    "batch" in value &&
    "release" in value &&
    "rollback" in value
  );
}

function defaultOpenStorage(
  implementation: MultiTabImplementation,
  name: string,
  options: MultiTabOpenStorageOptions,
): Promise<StorageBackend> {
  if (implementation === "opfs-memory") {
    return OpfsStorage.open(name, {
      signal: options.signal,
      onWaiting: options.onWaiting,
      onStartupStage: options.onStartupStage,
    });
  }
  return IndexedDBStorage.open(name, {
    whenBusy: options.whenBusy,
    epochOwner: options.epochOwner,
    expectedEpoch: options.expectedEpoch,
    verifyStealTarget: options.verifyStealTarget,
    preStealSignal: options.preStealSignal,
    signal: options.signal,
    onWaiting: options.onWaiting,
    onOwnershipLost: options.onOwnershipLost,
    onStartupStage: options.onStartupStage,
  });
}

/** Orders flush/sync barriers behind prior in-flight mutations and holds later mutations until
 * an active barrier settles, while allowing concurrent non-barrier mutations between barriers. */
class BarrierGate {
  private readonly mutations = new Set<Promise<void>>();
  private activeBarrier: Promise<void> | undefined;

  runMutation<T>(fn: () => Promise<T>): Promise<T> {
    const barrier = this.activeBarrier;
    const result = barrier ? barrier.then(fn) : fn();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.mutations.add(settled);
    void settled.finally(() => {
      this.mutations.delete(settled);
    });
    return result;
  }

  runBarrier<T>(fn: () => Promise<T>): Promise<T> {
    const prior = Array.from(this.mutations);
    if (this.activeBarrier) prior.push(this.activeBarrier);
    const result = prior.length ? Promise.allSettled(prior).then(fn) : fn();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.activeBarrier = settled;
    void settled.finally(() => {
      if (this.activeBarrier === settled) this.activeBarrier = undefined;
    });
    return result;
  }
}

/**
 * Multi-tab shared persistent filesystem backend (`whenBusy: "attach"`).
 * Implements Rev 24 of the Waffle multi-tab persistent FS design:
 * one elected Host owns `PersistentBackend` + `WatchService`; Peer tabs proxy
 * over term-keyed `BroadcastChannel`s with broker-anchored leases, bounded
 * credits/chunking, canonical `(workspaceId, fileId)` handles, and automatic failover.
 */
export class MultiTabBackend implements FilesystemBackend {
  private readonly scope: string;
  private readonly storageLockName: string;
  private readonly maintLockName: string;
  private readonly timings: MultiTabTimings;
  private readonly locks: LockManagerLike;
  private readonly createChannel: (name: string) => BroadcastChannelLike;
  private readonly openStorageFn: NonNullable<MultiTabBackendOptions["openStorage"]>;
  private readonly readEpochMetadataFn: NonNullable<MultiTabBackendOptions["readEpochMetadata"]>;
  private readonly hooks: MultiTabTestHooks;
  private readonly selfId: string = crypto.randomUUID();

  private selfLockClientId = "";
  private peerAliveLock?: HeldLock;
  private electionLock?: HeldLock;
  private aliveLock?: HeldLock;
  private attachClaimLock?: HeldLock;
  private controlChannel: BroadcastChannelLike;

  // Shared root + tab-lifetime segment reuse
  private sharedBuffer?: SharedArrayBuffer;
  private sharedMaxBytes?: number;
  private retainedSegments: SharedArrayBuffer[] = [];
  private watchCells?: Int32Array;

  // Lifecycle & role state
  private roleState: "init" | "host" | "peer" | "failover" | "waiting" | "failed" | "closed" =
    "init";
  private get role() {
    return this.roleState;
  }
  private set role(next: "init" | "host" | "peer" | "failover" | "waiting" | "failed" | "closed") {
    this.roleState = next;
    this.syncClientMode();
  }
  private phase: "opening" | "waiting-storage" | "ready" | "retiring" | "failed" | "closed" =
    "opening";
  private steppingDown = false;
  private disposing = false;
  private readonly disposeAbort = new AbortController();
  private disposeHostTerm?: bigint;
  private ownershipLost = false;
  private externalOwnershipLostNotified = false;
  private terminalFailure?: { readonly reason: unknown };
  private disposedReleaseError?: MultiTabReleaseError;
  private teardownPromise?: Promise<void>;
  private closedConfirmed = false;

  // Cohort & term state
  private cohortWorkspaceId?: string;
  private cohortLastAcceptedEpoch?: number;
  private currentAttemptId?: string;
  private hostTerm = 0n;
  private hostStorageEpoch = 0;
  private hostLastExclusiveEpoch = 0;
  private mountGeneration = 0;
  private hostMutationSeq = 0;
  private dirEpoch = 1n;

  // Host lease state (anchored before broker/storage verification)
  private leaseClosed = false;
  private leaseMonoDeadline = 0;
  private leaseWallDeadline = 0;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private leaseRenewInFlight?: Promise<boolean>;

  // Host authority state
  private persistent?: PersistentBackend;
  /** Bumped when entries are rebound, and by the outgoing backend's count plus one when the
   * persistent backend changes, so unlinkGeneration() only ever moves forward. */
  private unlinkEvents = 0;
  private watchService?: WatchService;
  private hostQueue: Promise<void> = Promise.resolve();
  private readonly barrier = new BarrierGate();
  private hostAdmittedCount = 0;
  private hostAdmittedZeroWaiters: (() => void)[] = [];
  private hostPeers = new Map<string, HostPeerSession>();
  private hostCreditSlots = new Map<string, PeerCreditSlot>();
  private hostAvailableFrames = MAX_HOST_FRAMES;
  private hostAvailableWireBytes = MAX_HOST_WIRE_BYTES;
  private hostUsedUploadBytes = 0;
  private hostUsedDownloadBytes = 0;
  private nextHostPeerOwner = 0x10000;
  private nextPinToken = 1;
  private nextWatchAckId = 1;
  private nextDownloadId = 1;
  private hostIdleTimer?: ReturnType<typeof setInterval>;

  // Peer authority state
  private peerHostAttemptId?: string;
  private peerHostClientId?: string;
  private peerHostTerm?: bigint;
  private peerSessionId?: string;
  private peerChannel?: BroadcastChannelLike;
  private peerHostAliveAbort?: AbortController;
  private peerAttached = false;
  private peerGrantedFrames = 0;
  private peerGrantedBytes = 0;
  private peerAvailableFrames = 0;
  private peerAvailableBytes = 0;
  private peerCreditWaiters: (() => void)[] = [];
  private peerNextReqId = 1;
  private peerNextPingId = 1;
  private peerNextUploadId = 1;
  private peerLastHostActivityAt = 0;
  private peerHeartbeatTimer?: ReturnType<typeof setInterval>;
  private peerLatestSeenWakeSeq = 0;
  private peerInFlightRpcs = new Map<number, PendingRpc>();
  private peerRetryQueue: QueuedPeerOp[] = [];
  private peerFailoverQueue: QueuedPeerOp[] = [];
  private readonly failoverReadyWaiters = new Set<() => void>();
  private peerPendingUnpins = new Set<number>();
  private peerPendingWatchAcks = new Map<number, boolean>();
  private peerPendingWatchCloses = new Set<number>();
  private peerPendingUploadAborts = new Set<string>();
  readonly supportsSockets = false;
  readonly asyncErrorsAreClientResults = true;
  private peerFailoverInFlight?: Promise<void>;
  private pendingDirectHostReady?: Extract<ControlMessage, { kind: "host-ready" }>;
  private peerRebinding = false;
  private peerObservedHostFailed?: string;
  private activeBackgroundTasks = new Set<Promise<void>>();
  private recoverContentionStartedAt?: number;
  private recoverContentionHolder?: string;

  // Startup / control waiters
  private controlListeners = new Set<(message: ControlMessage) => void>();
  private waitingLoopAbort?: AbortController;

  // Local canonical handle & watch tables
  private nextLocalHandle = 1;
  private byLocalHandle = new Map<number, LocalHandleEntry>();
  private byFileId = new Map<bigint, LocalHandleEntry>();
  private nextLocalWatchId = 1;
  private localWatches = new Map<number, LocalWatchEntry>();
  private hostWatchToLocal = new Map<number, LocalWatchEntry>();

  private constructor(private readonly options: MultiTabBackendOptions) {
    this.scope = multitabScope(options.implementation, options.name);
    this.storageLockName = storageLockNameFor(options.implementation, options.name);
    this.maintLockName = maintenanceLockNameFor(options.name);
    this.timings = resolveMultiTabTimings(options.timings);
    this.locks = options.locks ?? (navigator.locks as LockManagerLike);
    this.createChannel = options.createChannel ?? ((name) => new BroadcastChannel(name));
    this.openStorageFn = options.openStorage ?? defaultOpenStorage;
    this.readEpochMetadataFn =
      options.readEpochMetadata ?? ((name, signal) => readIndexedDBEpochMetadata(name, { signal }));
    this.hooks = options.hooks ?? {};

    if (options.sharedRoot) {
      this.sharedBuffer = options.sharedRoot.shared;
      this.sharedMaxBytes = options.sharedRoot.maxBytes;
      if (options.sharedRoot.segments) this.retainedSegments = options.sharedRoot.segments.slice();
      this.configureSharedBuffer(options.sharedRoot.shared);
    }

    this.controlChannel = this.createChannel(controlChannelName(this.scope));
    this.controlChannel.onmessage = (event) => {
      if (isControlMessage(event.data)) this.onControlMessage(event.data);
    };
    this.controlChannel.onmessageerror = () => {
      // Malformed control frame; peer recovery/heartbeats handle missing control messages.
    };
  }

  static async open(options: MultiTabBackendOptions): Promise<MultiTabBackend> {
    const backend = new MultiTabBackend(options);
    try {
      await backend.start(options.signal);
      return backend;
    } catch (error) {
      if (backend.terminalFailure) {
        // Retain attempt locks & surface explicit released:false!
        throw wrapReleaseError(backend.terminalFailure.reason, false);
      }
      const released = await backend.cleanupStartupFailure();
      if (!released) throw wrapReleaseError(error, false);
      if (error instanceof Error && "released" in error) throw error;
      throw wrapReleaseError(error, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostics & inspection helpers (useful for tests & resources())
  // ---------------------------------------------------------------------------

  get currentRole(): string {
    return this.role;
  }
  get currentPhase(): string {
    return this.phase;
  }
  get currentHostTerm(): bigint {
    return this.hostTerm;
  }
  get workspaceId(): string | undefined {
    return this.cohortWorkspaceId;
  }
  get lockClientId(): string {
    return this.selfLockClientId;
  }
  get attemptId(): string | undefined {
    return this.currentAttemptId;
  }
  get isTerminallyFailed(): boolean {
    return this.terminalFailure !== undefined;
  }
  private currentTerminalFailure(): { readonly reason: unknown } | undefined {
    return this.terminalFailure;
  }
  get peerId(): string {
    return this.selfId;
  }
  get sessionId(): string | undefined {
    return this.peerSessionId;
  }

  /** Expose internal lease validity for tests/diagnostics. */
  isLeaseValid(): boolean {
    if (this.leaseClosed || this.ownershipLost || this.terminalFailure) return false;
    if (this.leaseMonoDeadline <= 0 || this.leaseWallDeadline <= 0) return false;
    return performance.now() < this.leaseMonoDeadline && Date.now() < this.leaseWallDeadline;
  }

  resources(): Record<string, number> {
    const base = this.persistent?.resources() ?? {};
    return {
      ...base,
      multitabRole: this.role === "host" ? 1 : this.role === "peer" ? 2 : 0,
      multitabLocalHandles: this.byLocalHandle.size,
      multitabLocalWatches: this.localWatches.size,
      multitabHostPeers: this.hostPeers.size,
      multitabHostCreditSlots: this.hostCreditSlots.size,
      multitabHostAvailableFrames: this.hostAvailableFrames,
      multitabHostAvailableWireBytes: this.hostAvailableWireBytes,
      multitabHostUsedUploadBytes: this.hostUsedUploadBytes,
      multitabHostUsedDownloadBytes: this.hostUsedDownloadBytes,
      multitabPeerPendingSettlements: this.totalPendingSettlements(),
    };
  }

  // ---------------------------------------------------------------------------
  // FilesystemBackend interface
  // ---------------------------------------------------------------------------

  attachShared(buffer: SharedArrayBuffer): void {
    this.sharedBuffer = buffer;
    this.configureSharedBuffer(buffer);
    if (this.persistent) {
      this.persistent.attachShared(buffer, this.sharedMaxBytes, this.retainedSegments);
    }
    this.syncClientMode();
  }

  private configureSharedBuffer(buffer: SharedArrayBuffer): void {
    const ring = new WatchRing(buffer, WATCH_OFFSET);
    this.watchCells = ring.cells;
    this.syncClientMode();
  }

  private syncClientMode(): void {
    const mode =
      CLIENT_MODE_NO_DIRECT_IO |
      CLIENT_MODE_NO_CLIENT_CACHE |
      (this.roleState === "host" ? 0 : CLIENT_MODE_NO_WATCH_DRAIN);
    if (this.persistent) {
      this.persistent.shared.setClientMode(mode);
    } else if (this.sharedBuffer) {
      const header = new Int32Array(this.sharedBuffer, 0, HEADER_WORDS);
      Atomics.store(header, CLIENT_MODE, mode);
    }
  }

  private wakeWatchWord(): void {
    if (!this.watchCells) return;
    Atomics.add(this.watchCells, 3, 1);
    Atomics.notify(this.watchCells, 3);
  }

  readVersion(): string {
    return `${this.mountGeneration}:${formatTerm(this.hostTerm)}:${this.hostMutationSeq}`;
  }

  dirtyChange(): number | undefined {
    if (this.role === "host" && this.persistent) {
      return this.persistent.shared.dirtyAdmission.change;
    }
    return undefined;
  }

  waitForDirtyCapacity(changed: number, cancelled: () => boolean): Promise<void> {
    if (this.role === "host" && this.persistent) {
      return this.persistent.waitForDirtyCapacity(changed, cancelled);
    }
    return Promise.resolve();
  }

  private setPersistent(next: PersistentBackend | undefined): void {
    if (next === this.persistent) return;
    this.unlinkEvents += (this.persistent?.unlinkGeneration() ?? 0) + 1;
    this.persistent = next;
  }

  /** Exact for the host, whose unlinks all go through its persistent backend. Any other role
   * learns unlinks from the wire, so it reports NaN and every capability trim rescans. */
  unlinkGeneration(): number {
    if (this.role !== "host" || !this.persistent) return NaN;
    return this.unlinkEvents + this.persistent.unlinkGeneration();
  }

  isUnlinked(handle: FileHandle): boolean {
    const entry = this.byLocalHandle.get(handle);
    if (!entry) return false;
    if (this.role === "host" && this.persistent && entry.remoteHandle !== undefined) {
      return this.persistent.shared.isUnlinked(entry.remoteHandle);
    }
    return entry.unlinked;
  }

  retain(handle: FileHandle): void {
    const entry = this.byLocalHandle.get(handle);
    if (!entry) throw new FilesystemError(8);
    entry.serviceRefs++;
  }

  release(handle: FileHandle): void {
    const entry = this.byLocalHandle.get(handle);
    if (!entry) return;
    if (entry.serviceRefs > 0) entry.serviceRefs--;
    this.maybeReleaseLocalHandle(entry);
  }

  settleResult(operation: string, value: unknown): void {
    const handles = this.extractReturnedLocalHandles(operation, value);
    for (const handle of handles) {
      const entry = this.byLocalHandle.get(handle);
      if (!entry) continue;
      if (entry.provisional > 0) entry.provisional--;
      this.maybeReleaseLocalHandle(entry);
    }
  }

  isPreparedReadValid(): boolean {
    if (this.terminalFailure || this.ownershipLost) return false;
    if (this.role !== "host" || !this.persistent || this.persistent.isTerminallyFailed()) {
      return false;
    }
    if (this.steppingDown && (!this.disposing || this.hostTerm !== this.disposeHostTerm)) {
      return false;
    }
    return this.isLeaseValid();
  }

  prepareDescriptorRead(
    handle: FileHandle,
    offset: number,
    length: number,
    cancelled: () => boolean,
  ): Promise<Uint8Array> | undefined {
    if (!this.isPreparedReadValid()) return undefined;
    const admittedTerm = this.hostTerm;
    const entry = this.byLocalHandle.get(handle);
    if (!entry || entry.stale || entry.remoteHandle === undefined) return undefined;
    // A lease that lapsed only because renewal ran late keeps the read going; execute() renews
    // it before the bytes are used.
    return this.persistent!.prepareDescriptorRead(
      entry.remoteHandle,
      offset,
      length,
      () =>
        cancelled() ||
        this.hostTerm !== admittedTerm ||
        (!this.isPreparedReadValid() && !this.leaseOnlyLapsed(admittedTerm)),
    );
  }

  prepare(operation: string, args: any[], _data: Uint8Array): void | Promise<void> {
    if (this.role !== "host" || !this.persistent || !this.isLeaseValid()) return;
    if (UNSUPPORTED_ATTACH_OPS.has(operation)) return;
    // Mutations hydrate inside execute() under the barrier gate so flush/sync cannot bypass them.
    if (operation === "flush" || operation === "sync" || MUTATION_OPS.has(operation)) return;
    const translated = this.translateArgsToHost(operation, args);
    if (!translated) return;
    return this.persistent.prepare(operation, translated);
  }

  execute(
    operation: string,
    args: any[],
    data: Uint8Array,
    cancelled?: () => boolean,
  ): unknown | Promise<unknown> {
    if (UNSUPPORTED_ATTACH_OPS.has(operation)) {
      throw new FilesystemError(58, `${operation} is not supported in whenBusy: "attach"`);
    }
    if (this.terminalFailure)
      throw new FilesystemError(29, describeReason(this.terminalFailure.reason));
    const awaitingFenceLoss =
      !!this.fenceLossInFlight && !this.disposing && !this.externalOwnershipLostNotified;
    if (!awaitingFenceLoss) {
      this.assertLocalExecuteAdmissible();
    }
    if (operation === "flush" || operation === "sync") {
      return this.barrier.runBarrier(() => this.runLocalExecute(operation, args, data, cancelled));
    }
    if (MUTATION_OPS.has(operation)) {
      return this.barrier.runMutation(() => this.runLocalExecute(operation, args, data, cancelled));
    }
    if (awaitingFenceLoss) {
      return this.runLocalExecute(operation, args, data, cancelled);
    }
    return this.dispatchLocalRead(operation, args, data, cancelled);
  }

  private assertLocalExecuteAdmissible(): void {
    if (this.ownershipLost) throw new FilesystemError(11, "filesystem ownership lost");
    if (this.disposing) {
      // Allow queued local Host work on disposeHostTerm ONLY while lease is valid.
      if (
        this.role !== "host" ||
        this.hostTerm !== this.disposeHostTerm ||
        !this.isLeaseValid() ||
        !this.persistent ||
        this.persistent.isTerminallyFailed()
      ) {
        throw new FilesystemError(11, "filesystem is disposing");
      }
    }
    if (
      this.role !== "host" &&
      this.role !== "peer" &&
      this.role !== "failover" &&
      this.role !== "waiting"
    ) {
      throw new FilesystemError(11, "filesystem backend is closed");
    }
  }

  private dispatchLocalRead(
    operation: string,
    args: any[],
    data: Uint8Array,
    cancelled?: () => boolean,
  ): unknown | Promise<unknown> {
    // Validate & strip directory cookies at the receiving boundary BEFORE dispatch!
    let effectiveArgs = args;
    let responseCookieTag: bigint | undefined;
    if (operation === "readdirPage") {
      if (this.dirEpoch >= DIR_EPOCH_MAX) {
        throw new FilesystemError(61, "directory epoch exhausted");
      }
      const rawCookie = validateAndStripDirCookie(args[1] as bigint, this.dirEpoch);
      effectiveArgs = [args[0], rawCookie, args[2]];
      responseCookieTag = this.dirEpoch;
    }

    if (this.role === "host") {
      return this.executeLocalOnHost(operation, effectiveArgs, data, responseCookieTag, cancelled);
    }
    return this.executeOnPeer(operation, effectiveArgs, data, responseCookieTag, cancelled);
  }

  private async runLocalExecute(
    operation: string,
    args: any[],
    data: Uint8Array,
    cancelled?: () => boolean,
  ): Promise<unknown> {
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    if (this.fenceLossInFlight && !this.disposing && !this.externalOwnershipLostNotified) {
      await this.awaitPendingFenceLoss(cancelled);
    }
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    if (this.terminalFailure)
      throw new FilesystemError(29, describeReason(this.terminalFailure.reason));
    this.assertLocalExecuteAdmissible();
    return this.dispatchLocalRead(operation, args, data, cancelled);
  }

  private async awaitPendingFenceLoss(cancelled?: () => boolean): Promise<void> {
    const signal = this.disposeAbort.signal;
    while (
      this.fenceLossInFlight &&
      !this.disposing &&
      !signal.aborted &&
      !cancelled?.() &&
      !this.externalOwnershipLostNotified &&
      !this.terminalFailure
    ) {
      await raceWithAbort(this.fenceLossInFlight, signal, cancelled);
    }
  }

  private needsFailoverWait(): boolean {
    return (
      this.role === "failover" ||
      this.role === "waiting" ||
      (this.role === "peer" && (!this.peerAttached || this.peerRebinding))
    );
  }

  private notifyFailoverReadyWaiters(): void {
    for (const wake of Array.from(this.failoverReadyWaiters)) wake();
  }

  private awaitNextFailoverWake(signal: AbortSignal, cancelled: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        signal.removeEventListener("abort", done);
        this.failoverReadyWaiters.delete(done);
        resolve();
      };
      this.failoverReadyWaiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      const poll = setInterval(() => {
        if (cancelled()) done();
      }, 20);
    });
  }

  private async waitForFailoverReady(cancelled: () => boolean): Promise<void> {
    const signal = this.disposeAbort.signal;
    while (
      this.needsFailoverWait() &&
      !cancelled() &&
      !this.disposing &&
      !signal.aborted &&
      !this.ownershipLost &&
      !this.terminalFailure &&
      !this.peerObservedHostFailed
    ) {
      await this.awaitNextFailoverWake(signal, cancelled);
    }
  }

  flush(target?: FileHandle | string): Promise<void> {
    return this.barrier.runBarrier(() => this.runLocalFlush(target));
  }

  private async runLocalFlush(target?: FileHandle | string): Promise<void> {
    if (this.fenceLossInFlight && !this.disposing && !this.externalOwnershipLostNotified) {
      await this.awaitPendingFenceLoss();
    }
    if (this.terminalFailure)
      throw new FilesystemError(29, describeReason(this.terminalFailure.reason));
    if (this.ownershipLost) throw new FilesystemError(11, "filesystem ownership lost");
    if (this.disposing) {
      if (
        this.role !== "host" ||
        this.hostTerm !== this.disposeHostTerm ||
        !this.isLeaseValid() ||
        !this.persistent
      )
        throw new FilesystemError(11);
    }
    if (this.role === "host") {
      const admittedTerm = this.hostTerm;
      const budget: LeaseRenewalBudget = {};
      await this.assertHostAfterRenewal(admittedTerm, undefined, budget);
      let resolvedTarget: FileHandle | string | undefined = target;
      if (typeof target === "number") {
        const entry = this.byLocalHandle.get(target);
        if (!entry || entry.stale || entry.remoteHandle === undefined) throw new FilesystemError(8);
        resolvedTarget = entry.remoteHandle;
      }
      this.enterHostAdmitted();
      try {
        await this.hostQueue;
        await this.assertHostAfterRenewal(admittedTerm, undefined, budget);
        await this.persistent!.flush(resolvedTarget);
      } finally {
        this.leaveHostAdmitted();
      }
      return;
    }
    if (this.role === "peer" || this.role === "failover" || this.role === "waiting") {
      if (typeof target === "number") {
        await this.executeOnPeer("sync", [target], new Uint8Array());
      } else {
        await this.executeOnPeer("flush", target === undefined ? [] : [target], new Uint8Array());
      }
      return;
    }
    throw new FilesystemError(11);
  }

  // ---------------------------------------------------------------------------
  // Watch Hooks (FilesystemBackend)
  // ---------------------------------------------------------------------------

  watchOpen(
    owner: number,
    handle: FileHandle,
    recursive: boolean,
    cancelled: () => boolean,
  ): number | Promise<number> {
    if (this.terminalFailure || this.peerObservedHostFailed) {
      throw new FilesystemError(
        29,
        this.peerObservedHostFailed ?? describeReason(this.terminalFailure?.reason),
      );
    }
    if (this.fenceLossInFlight && !this.disposing && !this.externalOwnershipLostNotified) {
      return this.watchOpenAfterFenceLoss(owner, handle, recursive, cancelled);
    }
    if (this.ownershipLost || this.disposing) throw new FilesystemError(11);
    const entry = this.byLocalHandle.get(handle);
    if (!entry || entry.stale) throw new FilesystemError(8);
    if (this.role === "host") {
      const admittedTerm = this.hostTerm;
      if (!this.hostReadyForLocal(admittedTerm)) {
        return this.watchOpenAfterRenewal(owner, handle, recursive, cancelled, admittedTerm);
      }
      if (entry.remoteHandle === undefined) throw new FilesystemError(8);
      this.watchService ??= new WatchService(this.persistent!);
      const hostWatchId = this.watchService.open(owner, entry.remoteHandle, recursive, cancelled);
      const localWatchId = this.nextLocalWatchId++;
      const localEntry: LocalWatchEntry = {
        localWatchId,
        localOwner: owner,
        fileId: entry.fileId,
        recursive,
        hostTerm: admittedTerm,
        hostWatchId,
        overflowed: false,
        closed: false,
      };
      this.localWatches.set(localWatchId, localEntry);
      this.hostWatchToLocal.set(hostWatchId, localEntry);
      return localWatchId;
    }
    if (this.needsFailoverWait()) {
      return this.watchOpenAfterFenceLoss(owner, handle, recursive, cancelled);
    }
    if (this.role === "peer") {
      return this.openPeerWatch(owner, entry, recursive, cancelled);
    }
    throw new FilesystemError(11);
  }

  private async watchOpenAfterFenceLoss(
    owner: number,
    handle: FileHandle,
    recursive: boolean,
    cancelled: () => boolean,
  ): Promise<number> {
    await this.awaitPendingFenceLoss(cancelled);
    if (cancelled()) throw new FilesystemError(11);
    await this.waitForFailoverReady(cancelled);
    if (cancelled()) throw new FilesystemError(11);
    return this.watchOpen(owner, handle, recursive, cancelled);
  }

  watchRead(
    owner: number,
    localWatchId: number,
    cancelled: () => boolean,
  ): HeldWatchBatch | Promise<HeldWatchBatch> {
    const watch = this.localWatches.get(localWatchId);
    if (!watch || watch.closed || watch.localOwner !== owner) throw new FilesystemError(8);
    if (watch.overflowed) {
      return {
        batch: { kind: "overflow", events: [] },
        release() {},
        rollback() {},
      };
    }
    if (this.terminalFailure) {
      watch.overflowed = true;
      return {
        batch: { kind: "overflow", events: [] },
        release() {},
        rollback() {},
      };
    }
    if (this.role === "host") {
      if (
        watch.hostTerm !== this.hostTerm ||
        watch.hostWatchId === undefined ||
        !this.watchService
      ) {
        watch.overflowed = true;
        return {
          batch: { kind: "overflow", events: [] },
          release() {},
          rollback() {},
        };
      }
      if (!this.isLeaseValid()) {
        return this.watchReadHostAfterRenew(owner, watch, cancelled);
      }
      return this.watchService.readHeld(owner, watch.hostWatchId);
    }
    if (this.role === "peer" || this.role === "failover" || this.role === "waiting") {
      return this.readPeerWatch(watch, cancelled);
    }
    throw new FilesystemError(11);
  }

  /** A watch opened while the lease lapsed only late: renew, then open it as usual. */
  private async watchOpenAfterRenewal(
    owner: number,
    handle: FileHandle,
    recursive: boolean,
    cancelled: () => boolean,
    admittedTerm: bigint,
  ): Promise<number> {
    await this.renewLapsedLease(admittedTerm, cancelled);
    return this.watchOpen(owner, handle, recursive, cancelled);
  }

  private async watchReadHostAfterRenew(
    owner: number,
    watch: LocalWatchEntry,
    cancelled: () => boolean,
  ): Promise<HeldWatchBatch> {
    if (this.disposing || cancelled()) throw new FilesystemError(11);
    if (this.leaseOnlyLapsed(watch.hostTerm)) {
      // A renewal that cannot finish in time reports one overflow below, not a failure.
      await this.renewLapsedLease(watch.hostTerm, cancelled).catch(() => {});
    } else {
      await raceWithAbort(this.renewLeaseNow(), this.disposeAbort.signal, cancelled);
    }
    if (this.disposing || cancelled()) throw new FilesystemError(11);
    const overflow: HeldWatchBatch = {
      batch: { kind: "overflow", events: [] },
      release() {},
      rollback() {},
    };
    // Only a term that really ended makes the overflow permanent for this watch.
    const termEnded =
      watch.hostTerm !== this.hostTerm ||
      this.role !== "host" ||
      this.ownershipLost ||
      this.leaseClosed;
    if (watch.overflowed || termEnded || !this.watchService) {
      watch.overflowed = true;
      return overflow;
    }
    if (!this.isLeaseValid()) return overflow;
    return this.watchService.readHeld(owner, watch.hostWatchId!);
  }

  watchDrain(
    owner: number,
    cancelled: () => boolean,
  ):
    | import("./watch-service.js").HeldWatchDrain
    | Promise<import("./watch-service.js").HeldWatchDrain> {
    if (this.role === "host") {
      const admittedTerm = this.hostTerm;
      if (!this.isLeaseValid()) {
        return this.watchDrainHostAfterRenew(owner, admittedTerm, cancelled);
      }
      return this.drainHostWatches(owner);
    }
    throw new FilesystemError(58);
  }

  private overflowOwnerWatches(
    owner: number,
    permanent: boolean,
  ): import("./watch-service.js").HeldWatchDrain {
    const entries: import("../core/filesystem.js").WatchDrainEntry[] = [];
    for (const watch of this.localWatches.values()) {
      if (watch.closed || watch.localOwner !== owner) continue;
      if (permanent || watch.hostTerm !== this.hostTerm) watch.overflowed = true;
      entries.push({ id: watch.localWatchId, batch: { kind: "overflow", events: [] } });
    }
    return { entries, more: false, hasEvents: false, release() {}, rollback() {} };
  }

  private async watchDrainHostAfterRenew(
    owner: number,
    admittedTerm: bigint,
    cancelled: () => boolean,
  ): Promise<import("./watch-service.js").HeldWatchDrain> {
    if (this.disposing || cancelled()) throw new FilesystemError(11);
    if (this.leaseOnlyLapsed(admittedTerm)) {
      // A renewal that cannot finish in time reports one overflow below, not a failure.
      await this.renewLapsedLease(admittedTerm, cancelled).catch(() => {});
    } else {
      await raceWithAbort(this.renewLeaseNow(), this.disposeAbort.signal, cancelled);
    }
    if (this.disposing || cancelled()) throw new FilesystemError(11);
    const termEnded =
      admittedTerm !== this.hostTerm ||
      this.role !== "host" ||
      this.ownershipLost ||
      this.leaseClosed ||
      !!this.terminalFailure ||
      !this.watchService;
    if (termEnded) return this.overflowOwnerWatches(owner, true);
    if (!this.isLeaseValid()) return this.overflowOwnerWatches(owner, false);
    return this.drainHostWatches(owner);
  }

  private drainHostWatches(owner: number): import("./watch-service.js").HeldWatchDrain {
    if (this.terminalFailure || !this.watchService) {
      return this.overflowOwnerWatches(owner, true);
    }
    const entries: import("../core/filesystem.js").WatchDrainEntry[] = [];
    const seen = new Set<number>();
    const held = this.watchService.drainHeld(owner);
    for (const entry of held.entries) {
      const local = this.hostWatchToLocal.get(entry.id);
      if (!local || local.closed || local.localOwner !== owner) continue;
      if (local.overflowed || local.hostTerm !== this.hostTerm) {
        local.overflowed = true;
        seen.add(local.localWatchId);
        entries.push({ id: local.localWatchId, batch: { kind: "overflow", events: [] } });
        continue;
      }
      seen.add(local.localWatchId);
      entries.push(
        "batch" in entry
          ? { id: local.localWatchId, batch: entry.batch }
          : { id: local.localWatchId, errno: entry.errno },
      );
    }
    // Only scan localWatches when a term change or explicit overflow may exist outside WatchService.
    if (this.hostWatchToLocal.size !== this.localWatches.size) {
      for (const watch of this.localWatches.values()) {
        if (watch.closed || watch.localOwner !== owner || seen.has(watch.localWatchId)) continue;
        if (
          watch.overflowed ||
          watch.hostTerm !== this.hostTerm ||
          watch.hostWatchId === undefined
        ) {
          watch.overflowed = true;
          entries.push({ id: watch.localWatchId, batch: { kind: "overflow", events: [] } });
        }
      }
    }
    return {
      entries,
      more: held.more,
      hasEvents: held.hasEvents,
      release: held.release,
      rollback: held.rollback,
    };
  }

  watchClose(owner: number, localWatchId: number): void {
    const watch = this.localWatches.get(localWatchId);
    if (!watch || watch.localOwner !== owner) return;
    watch.closed = true;
    this.localWatches.delete(localWatchId);
    if (watch.hostWatchId !== undefined && this.hostWatchToLocal.get(watch.hostWatchId) === watch) {
      this.hostWatchToLocal.delete(watch.hostWatchId);
    }
    if (
      this.role === "host" &&
      watch.hostTerm === this.hostTerm &&
      watch.hostWatchId !== undefined
    ) {
      this.watchService?.close(owner, watch.hostWatchId);
    } else if (
      this.role === "peer" &&
      watch.hostTerm === this.peerHostTerm &&
      watch.hostWatchId !== undefined &&
      this.peerSessionId
    ) {
      this.enqueueSettlement(this.peerSessionId, {
        kind: "watch-close",
        hostWatchId: watch.hostWatchId,
      });
    }
  }

  closeWatchOwner(owner: number): void {
    for (const [id, watch] of Array.from(this.localWatches)) {
      if (watch.localOwner !== owner) continue;
      this.watchClose(owner, id);
    }
    if (this.role === "host") {
      this.watchService?.closeOwner(owner);
    }
  }

  // ---------------------------------------------------------------------------
  // Latched Disposal & Shutdown (Rev 24 §5.3 & §7.5)
  // ---------------------------------------------------------------------------

  beginDispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    this.disposeAbort.abort();
    this.waitingLoopAbort?.abort();

    // Terminal failure precedence (§7.5): preserve terminal state!
    if (this.terminalFailure) {
      this.wakeWatchWord();
      return;
    }

    if (this.role === "host" && !this.ownershipLost) {
      // Liveness advertisement depends ONLY on storage ownership (regardless of lease validity!)
      this.steppingDown = true;
      this.phase = "retiring";
      this.disposeHostTerm = this.hostTerm;
      return;
    }

    // Not owning healthy storage (peer, failover, waiting, opening, or ownershipLost):
    // immediately abort all queued/in-flight remote RPCs & failover waits with ECANCELED!
    this.failAllPeerWork(new FilesystemError(11, "filesystem is disposing"));
  }

  beginShutdown(): void {
    this.beginDispose();
    // Once FilesystemService.shutdown() begins, no new local work may be admitted either.
    this.disposeHostTerm = undefined;
  }

  close(): Promise<void> {
    this.beginShutdown();
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = this.runTerminalDispose();
    return this.teardownPromise;
  }

  private trackBackgroundTask(task: Promise<void>): Promise<void> {
    this.activeBackgroundTasks.add(task);
    const cleanup = () => {
      this.activeBackgroundTasks.delete(task);
    };
    task.then(cleanup, cleanup);
    return task;
  }

  private async runTerminalDispose(): Promise<void> {
    this.stopHostTimers();
    this.stopPeerTimers();
    this.failAllPeerWork(new FilesystemError(11, "filesystem closed"));

    // Join any in-flight failover / promotion / session-reset / fence-loss / step-down work
    // BEFORE releasing attempt locks or reporting released:true!
    while (this.activeBackgroundTasks.size > 0) {
      await Promise.allSettled(Array.from(this.activeBackgroundTasks));
    }

    // Terminal failure already latched (including from a joined promotion rollback):
    // retain attach-claim + aliveLock + controlChannel and reject with released:false!
    if (this.terminalFailure) {
      throw wrapReleaseError(this.terminalFailure.reason, false);
    }

    // Preserve recoverable checkpoint error from a joined step-down that confirmed release!
    if (this.disposedReleaseError) {
      throw this.disposedReleaseError;
    }

    if (this.closedConfirmed) {
      return;
    }

    if (this.role === "host" && this.persistent) {
      await this.runHostStepDown("dispose");
      return;
    }

    if (this.persistent) {
      const residual = this.persistent;
      this.setPersistent(undefined);
      this.watchService = undefined;
      await this.retireFailedMountBackend(residual);
    }

    if (await this.isStorageLockHeldBySelf()) {
      const reason = new Error("Storage lock remained held during disposal");
      this.enterTerminalStorageFailure(reason);
      throw wrapReleaseError(reason, false);
    }

    // Peer / waiting / failed / already-retired cleanup:
    await this.cleanupPeerAndControlChannels(true);
    await this.releaseAttemptAndElectionLocks();
    await this.releasePeerAliveLock();
    this.role = "closed";
    this.phase = "closed";
    this.closedConfirmed = true;
  }

  // ---------------------------------------------------------------------------
  // Startup & Ordinary Election (Rev 24 §5.2)
  // ---------------------------------------------------------------------------

  private async start(startupSignal?: AbortSignal): Promise<void> {
    const linked = linkAbortSignals(startupSignal, this.disposeAbort.signal);
    try {
      // 1. Acquire peerAliveLock(selfId) and capture selfLockClientId from broker.
      this.peerAliveLock = await acquireHeldLock(
        this.locks,
        peerAliveLockName(this.scope, this.selfId),
        { mode: "exclusive", signal: linked.signal },
      );
      const snap = await this.locks.query();
      this.selfLockClientId =
        snap.held?.find((l) => l.name === peerAliveLockName(this.scope, this.selfId))?.clientId ??
        this.selfId;

      if (linked.signal.aborted) throw abortError();

      // 2. Try advisory electionLock (ifAvailable ONLY — NEVER steal: true!).
      this.electionLock = await acquireHeldLock(this.locks, electionLockName(this.scope), {
        mode: "exclusive",
        ifAvailable: true,
      });

      if (this.electionLock) {
        await this.runCandidateStartup(linked.signal);
      } else {
        await this.runPeerOrObserverStartup(linked.signal);
      }
    } finally {
      linked.cleanup();
    }
  }

  private async runCandidateStartup(signal: AbortSignal): Promise<void> {
    const attemptId = this.beginFreshAttempt();
    await this.acquireAttemptLocks(attemptId, "open", signal);
    this.phase = "opening";
    this.broadcastControl({
      kind: "host-status",
      attemptId,
      clientId: this.selfLockClientId,
      phase: "opening",
    });

    if (this.options.implementation === "indexeddb") {
      await this.runIndexedDBNonQueuingOpen(attemptId, signal);
    } else {
      await this.openOpfsWithHostReadyCancel(attemptId, signal);
    }
  }

  private async runIndexedDBNonQueuingOpen(attemptId: string, signal: AbortSignal): Promise<void> {
    let storage: StorageBackend | undefined;
    try {
      storage = await this.openStorageFn("indexeddb", this.options.name, {
        whenBusy: "ifAvailable",
        epochOwner: "attach",
        signal,
        onStartupStage: this.options.onStartupStage,
        onOwnershipLost: () => this.onStorageOwnershipLost(attemptId),
      });
    } catch (error) {
      if (this.isBusyError(error)) {
        // Storage is held — immediately release attempt & advisory locks (NEVER queue on storageLock!)
        await this.releaseAttemptAndElectionLocks();
        await this.inspectBrokerAfterBusy(signal);
        return;
      }
      throw error;
    }

    await this.activateMountedHost(attemptId, storage, signal);
  }

  /** Shared OPFS open helper used by BOTH §5.2 startup and §5.4 Case 1 recovery. */
  private async openOpfsWithHostReadyCancel(attemptId: string, signal: AbortSignal): Promise<void> {
    let discoveredHostReady: Extract<ControlMessage, { kind: "host-ready" }> | undefined;
    const opfsAbort = new AbortController();
    const linked = linkAbortSignals(signal, opfsAbort.signal);

    // 1. Arm host-ready listener BEFORE requesting storage!
    const onControl = (msg: ControlMessage) => {
      if (msg.kind === "host-ready" && msg.clientId !== this.selfLockClientId) {
        discoveredHostReady = msg;
        if (!opfsAbort.signal.aborted) opfsAbort.abort();
      }
    };
    this.controlListeners.add(onControl);

    let discoverTimer: ReturnType<typeof setInterval> | undefined;
    const startDiscoverPolling = () => {
      if (discoverTimer) return;
      this.broadcastControl({ kind: "discover", fromPeerId: this.selfId });
      discoverTimer = setInterval(() => {
        if (linked.signal.aborted) return;
        this.broadcastControl({ kind: "discover", fromPeerId: this.selfId });
      }, this.timings.waitPollMs);
    };

    let storage: StorageBackend | undefined;
    let openError: { failed: true; reason: unknown } | undefined;
    try {
      startDiscoverPolling();
      storage = await this.openStorageFn("opfs-memory", this.options.name, {
        whenBusy: "wait",
        signal: linked.signal,
        onStartupStage: this.options.onStartupStage,
        onWaiting: () => {
          this.phase = "waiting-storage";
          this.broadcastControl({
            kind: "host-status",
            attemptId,
            clientId: this.selfLockClientId,
            phase: "waiting-storage",
          });
          this.notifyState("waiting");
          this.broadcastControl({ kind: "discover", fromPeerId: this.selfId });
        },
      });
    } catch (error) {
      openError = { failed: true, reason: error };
    } finally {
      if (discoverTimer) clearInterval(discoverTimer);
      this.controlListeners.delete(onControl);
      linked.cleanup();
    }

    // If storage actually opened right as host-ready or abort raced: close it cleanly first!
    if (storage && (discoveredHostReady || signal.aborted)) {
      let closeErr: { failed: true; reason: unknown } | undefined;
      try {
        await storage.close();
      } catch (error) {
        closeErr = { failed: true, reason: error };
      }
      if (closeErr || storage.isTerminallyFailed?.() || (await this.isStorageLockHeldBySelf())) {
        // Pre-ready native handle close failure: RETAIN attempt locks & propagate released:false!
        const reason = closeErr ? closeErr.reason : storage.terminalFailureReason?.();
        this.terminalFailure = { reason };
        this.phase = "failed";
        this.role = "failed";
        throw wrapReleaseError(reason, false);
      }
      storage = undefined;
      await this.releaseAttemptAndElectionLocks();
      if (signal.aborted) throw wrapReleaseError(abortError(), true);
      if (discoveredHostReady) {
        await this.attachToHostReady(discoveredHostReady, signal);
        return;
      }
      await this.inspectBrokerAfterBusy(signal);
      return;
    }

    if (openError) {
      const reason = openError.reason;
      // Distinguish terminal native handle close failure vs clean abort!
      if (!isAbortLike(reason)) {
        const heldStill = await this.isStorageLockHeldBySelf();
        if (heldStill) {
          this.terminalFailure = { reason };
          this.phase = "failed";
          this.role = "failed";
          throw wrapReleaseError(reason, false);
        }
        if (!discoveredHostReady) throw reason;
      }

      // Clean abort: verify broker has cleared any transient grant/request for selfClientId!
      const cleared = await this.waitForStorageLockBrokerClear();
      if (!cleared) {
        const failReason = new Error("OPFS storage lock remained held after startup abort");
        this.terminalFailure = { reason: failReason };
        this.phase = "failed";
        this.role = "failed";
        throw wrapReleaseError(failReason, false);
      }

      await this.releaseAttemptAndElectionLocks();
      if (signal.aborted) throw wrapReleaseError(abortError(), true);
      if (discoveredHostReady) {
        await this.attachToHostReady(discoveredHostReady, signal);
        return;
      }
      await this.inspectBrokerAfterBusy(signal);
      return;
    }

    // Storage acquired cleanly!
    await this.activateMountedHost(
      attemptId,
      storage!,
      signal,
      this.cohortWorkspaceId !== undefined,
    );
  }

  private async waitForStorageLockBrokerClear(): Promise<boolean> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const snap = await this.locks.query();
      const stillHeld = snap.held?.some(
        (l) => l.name === this.storageLockName && l.clientId === this.selfLockClientId,
      );
      const stillPending = snap.pending?.some(
        (l) => l.name === this.storageLockName && l.clientId === this.selfLockClientId,
      );
      await this.hooks.afterOpfsAbortBrokerCheck?.(attempt);
      if (!stillHeld && !stillPending) return true;
      // Do NOT abort this wait on dispose() — we must confirm broker release before reporting released:true!
      await delay(10);
    }
    return false;
  }

  private async isStorageLockHeldBySelf(): Promise<boolean> {
    try {
      const snap = await this.locks.query();
      return !!snap.held?.some(
        (l) => l.name === this.storageLockName && l.clientId === this.selfLockClientId,
      );
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // Unified Host Activation Sequence (Rev 24 §4, §5.1, §5.2, §5.4)
  // ---------------------------------------------------------------------------

  private activateMountedHost(
    attemptId: string,
    storage: StorageBackend,
    signal: AbortSignal,
    isPromotion = false,
  ): Promise<void> {
    return this.trackBackgroundTask(
      this.executeActivateMountedHost(attemptId, storage, signal, isPromotion),
    );
  }

  private async executeActivateMountedHost(
    attemptId: string,
    storage: StorageBackend,
    signal: AbortSignal,
    isPromotion = false,
  ): Promise<void> {
    let backend: PersistentBackend | undefined;
    try {
      backend = await PersistentBackend.open(storage, {
        startupRoot: this.options.startupRoot,
        sharedRoot: this.sharedBuffer
          ? {
              shared: this.sharedBuffer,
              maxBytes: this.sharedMaxBytes ?? DEFAULT_SHARED_MAX_BYTES,
              segments: this.retainedSegments,
            }
          : undefined,
        signal,
      });

      // Install synchronous terminal storage failure hook BEFORE any flush/work!
      backend.setTerminalFailureListener((reason) => {
        if (this.persistent === backend) {
          this.enterTerminalStorageFailure(reason);
        }
      });

      if (this.sharedBuffer) {
        backend.shared.setClientMode(
          CLIENT_MODE_NO_DIRECT_IO | CLIENT_MODE_NO_CLIENT_CACHE | CLIENT_MODE_NO_WATCH_DRAIN,
        );
      }

      // Brand-new workspace: flush initial root BEFORE first host-ready so workspaceId + root FileIdentity are durable.
      if (!backend.hasLoadedIndex) {
        await backend.flush();
      }

      if (signal.aborted || this.disposing) throw abortError();
      if (this.ownershipLost) throw new FilesystemError(11, "ownership lost before activation");
      if (backend.isTerminallyFailed()) {
        this.enterTerminalStorageFailure(backend.terminalFailureReason());
        throw wrapReleaseError(backend.terminalFailureReason(), false);
      }

      const storageEpoch =
        "currentEpoch" in storage && typeof storage.currentEpoch === "number"
          ? storage.currentEpoch
          : 0;
      const lastExclusiveEpoch =
        "lastExclusiveEpoch" in storage && typeof storage.lastExclusiveEpoch === "number"
          ? storage.lastExclusiveEpoch
          : 0;

      // Pure cohort validation BEFORE mutating cohort state!
      const validation = this.validateCohortEpoch(backend.workspaceId, lastExclusiveEpoch);
      if (validation === "workspace-replaced") {
        this.broadcastControl({
          kind: "workspace-replaced",
          workspaceId: backend.workspaceId,
          expectedWorkspaceId: this.cohortWorkspaceId!,
        });
        await backend.retireFenced({ throwOnStorageCloseError: true });
        await this.releaseAttemptAndElectionLocks();
        const err = new FilesystemError(11, "workspace was deleted and replaced");
        this.failTabWithFatal(err, true);
        throw err;
      }
      if (validation === "external-takeover") {
        this.broadcastControl({
          kind: "external-takeover",
          attemptId,
          hostTerm: formatTerm(backend.initialReservationEra),
          workspaceId: this.cohortWorkspaceId!,
          lastExclusiveEpoch,
          affectedEpoch: this.cohortLastAcceptedEpoch ?? 0,
        });
        await backend.retireFenced({ throwOnStorageCloseError: true });
        await this.releaseAttemptAndElectionLocks();
        this.triggerExternalOwnershipLost();
        throw new FilesystemError(11, "workspace taken over by exclusive owner");
      }

      // Mount fixed hostTerm & bind PersistentBackend
      this.setPersistent(backend);
      this.watchService = new WatchService(backend);
      this.hostTerm = backend.initialReservationEra;
      this.hostStorageEpoch = storageEpoch;
      this.hostLastExclusiveEpoch = lastExclusiveEpoch;
      this.mountGeneration++;
      this.advanceDirEpoch();

      // Rebind own handles on promotion BEFORE activating
      if (isPromotion) {
        this.rebindLocalHandlesOnHost(this.hostTerm);
      }

      // Broker-Level Cutover Barrier (exclusive-only alive:* check!)
      await this.runCutoverBarrier(attemptId, signal);

      // Initial broker-anchored lease renewal (retry while same attempt owns healthy storage!)
      await this.ensureInitialHostLease(attemptId, backend, signal);

      // ONE synchronous final readiness step (ZERO awaits in between!):
      if (
        !this.isLeaseValid() ||
        this.ownershipLost ||
        this.disposing ||
        signal.aborted ||
        backend.isTerminallyFailed()
      ) {
        throw abortError();
      }
      this.commitCohortEpoch(backend.workspaceId, storageEpoch);
      this.peerObservedHostFailed = undefined;
      this.role = "host";
      this.phase = "ready";
      this.steppingDown = false;
      if (isPromotion) this.markLocalWatchesOverflow();
      this.startHostTimers();
      this.broadcastControl({
        kind: "host-ready",
        attemptId,
        clientId: this.selfLockClientId,
        hostTerm: formatTerm(this.hostTerm),
        workspaceId: backend.workspaceId,
        storageEpoch,
        lastExclusiveEpoch,
      });
      this.notifyState("ready");

      // Drain any ops that were queued during failover onto ourselves now that we're Host!
      if (isPromotion) this.drainQueuedPeerOpsOnNewHost();
    } catch (error) {
      await this.rollbackFailedHostMount(backend, storage);
      throw error;
    }
  }

  private async ensureInitialHostLease(
    attemptId: string,
    backend: PersistentBackend,
    signal: AbortSignal,
  ): Promise<void> {
    while (!this.isLeaseValid()) {
      if (signal.aborted || this.disposing || this.ownershipLost || this.leaseClosed)
        throw abortError();
      if (backend.isTerminallyFailed()) {
        this.enterTerminalStorageFailure(backend.terminalFailureReason());
        throw wrapReleaseError(backend.terminalFailureReason(), false);
      }
      const ok = await this.renewLeaseNow(attemptId);
      if (ok && this.isLeaseValid()) break;
      if (this.ownershipLost || this.terminalFailure || this.disposing || signal.aborted)
        throw abortError();
    }
  }

  private async rollbackFailedHostMount(
    backend: PersistentBackend | undefined,
    storage: StorageBackend,
  ): Promise<void> {
    if (this.terminalFailure) throw wrapReleaseError(this.terminalFailure.reason, false);
    if (backend) {
      this.setPersistent(undefined);
      this.watchService = undefined;
      await this.retireFailedMountBackend(backend);
    } else {
      await this.closeFailedMountStorage(storage);
    }
    await this.releaseAttemptAndElectionLocks();
  }

  private async retireFailedMountBackend(backend: PersistentBackend): Promise<void> {
    try {
      await backend.retireFenced({ throwOnStorageCloseError: true });
    } catch (closeErr) {
      if (backend.isTerminallyFailed() || (await this.isStorageLockHeldBySelf())) {
        this.terminalFailure = { reason: closeErr };
        this.phase = "failed";
        this.role = "failed";
        throw wrapReleaseError(closeErr, false);
      }
    }
    if (this.sharedBuffer) {
      this.captureRetainedSegments(backend);
      backend.shared.resetForRemount(this.retainedSegments);
    }
  }

  private async closeFailedMountStorage(storage: StorageBackend): Promise<void> {
    try {
      await storage.close();
    } catch (closeErr) {
      if (storage.isTerminallyFailed?.() || (await this.isStorageLockHeldBySelf())) {
        this.terminalFailure = { reason: closeErr };
        this.phase = "failed";
        this.role = "failed";
        throw wrapReleaseError(closeErr, false);
      }
    }
  }

  /** Exclusive-only broker cutover barrier (Rev 24 §5.1.2). */
  private async runCutoverBarrier(attemptId: string, signal: AbortSignal): Promise<void> {
    await this.hooks.beforeCutoverBarrier?.(attemptId);
    const snap = await this.locks.query();
    const prefix = aliveLockPrefix(this.scope);
    const selfAlive = aliveLockName(this.scope, attemptId);
    const otherExclusiveAlive = (snap.held ?? []).filter(
      (l): l is LockInfo & { name: string } =>
        l.mode === "exclusive" &&
        typeof l.name === "string" &&
        l.name.startsWith(prefix) &&
        l.name !== selfAlive,
    );
    if (!otherExclusiveAlive.length) return; // 0 ms wait when no other exclusive alive:* exists!

    const waitMs = this.timings.leaseDurationMs + this.timings.leaseClockSafetyMs;
    const barrierAbort = new AbortController();
    const linked = linkAbortSignals(signal, this.disposeAbort.signal, barrierAbort.signal);
    try {
      const remaining = new Set(otherExclusiveAlive.map((l) => l.name));
      const allReleased = Promise.withResolvers<void>();
      for (const lockName of remaining) {
        watchLockRelease(this.locks, lockName, linked.signal, () => {
          remaining.delete(lockName);
          if (!remaining.size) allReleased.resolve();
        });
      }
      await Promise.race([allReleased.promise, delay(waitMs, linked.signal)]);
    } finally {
      barrierAbort.abort();
      linked.cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // Broker-Anchored Host Lease Renewal (Rev 24 §5.1.1)
  // ---------------------------------------------------------------------------

  private async confirmBrokerAndStorage(attemptId: string): Promise<boolean> {
    if (this.ownershipLost || this.leaseClosed || this.currentAttemptId !== attemptId) return false;
    if (!this.persistent || this.persistent.isTerminallyFailed()) return false;
    const snap = await this.locks.query();
    const hasStorage = !!snap.held?.some(
      (l) => l.name === this.storageLockName && l.clientId === this.selfLockClientId,
    );
    const claimName = this.attachClaimLock?.name;
    const hasClaim =
      !!claimName &&
      !!snap.held?.some((l) => l.name === claimName && l.clientId === this.selfLockClientId);
    if (!hasStorage || !hasClaim) return false;
    return this.persistent.verifyStorageEpoch();
  }

  async renewLeaseNow(expectedAttemptId = this.currentAttemptId): Promise<boolean> {
    if (!expectedAttemptId) return false;
    if (this.leaseRenewInFlight) return this.leaseRenewInFlight;
    const attemptId = expectedAttemptId;
    const run = this.executeLeaseRenewal(attemptId);
    this.leaseRenewInFlight = run;
    return run.finally(() => {
      if (this.leaseRenewInFlight === run) this.leaseRenewInFlight = undefined;
    });
  }

  private async executeLeaseRenewal(attemptId: string): Promise<boolean> {
    try {
      await this.hooks.beforeLeaseCheck?.(attemptId);
      const startMono = performance.now();
      const startWall = Date.now();
      const ok = await this.confirmBrokerAndStorage(attemptId);
      await this.hooks.afterLeaseCheck?.(attemptId);

      if (this.leaseClosed || this.currentAttemptId !== attemptId) {
        // Terminal Step 6 clear (or remount) already ran; NEVER restore deadlines!
        return false;
      }
      if (this.persistent?.isTerminallyFailed()) {
        this.enterTerminalStorageFailure(this.persistent.terminalFailureReason());
        return false;
      }
      if (!ok || this.ownershipLost) {
        await this.handleFenceLoss();
        return false;
      }
      const nextMono = startMono + this.timings.leaseDurationMs;
      const nextWall = startWall + this.timings.leaseDurationMs;
      if (nextMono > this.leaseMonoDeadline) {
        this.leaseMonoDeadline = nextMono;
        this.leaseWallDeadline = nextWall;
      }
      return this.isLeaseValid();
    } catch (_error) {
      if (this.persistent?.isTerminallyFailed()) {
        this.enterTerminalStorageFailure(this.persistent.terminalFailureReason());
      } else if (!this.leaseClosed && this.currentAttemptId === attemptId && this.ownershipLost) {
        await this.handleFenceLoss();
      }
      return false;
    }
  }

  private startHostTimers(): void {
    this.stopHostTimers();
    this.leaseTimer = setInterval(() => {
      if (this.role !== "host" || this.leaseClosed || this.terminalFailure) return;
      void this.renewLeaseNow();
    }, this.timings.leaseRenewMs);
    this.hostIdleTimer = setInterval(
      () => {
        if (this.role !== "host" || this.terminalFailure) return;
        const now = Date.now();
        for (const [peerId, session] of Array.from(this.hostPeers)) {
          if (now - session.lastActivityAt >= this.timings.attachIdleTimeoutMs) {
            this.detachHostPeer(peerId);
          }
        }
      },
      Math.max(50, Math.floor(this.timings.heartbeatTimeoutMs / 2)),
    );
  }

  private stopHostTimers(): void {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = undefined;
    }
    if (this.hostIdleTimer) {
      clearInterval(this.hostIdleTimer);
      this.hostIdleTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal Storage Failure Gate (Rev 24 §5.1 & §5.3)
  // ---------------------------------------------------------------------------

  private enterTerminalStorageFailure(reason: unknown): void {
    if (this.terminalFailure) return;
    this.terminalFailure = { reason };
    this.steppingDown = true;
    this.phase = "failed";
    this.role = "failed";
    this.leaseClosed = true;
    this.leaseMonoDeadline = 0;
    this.leaseWallDeadline = 0;
    this.stopHostTimers();

    const msg = describeReason(reason);
    // Broadcast host-failed to all tabs (AND keep answering discover/attach with host-failed!)
    this.broadcastControl({
      kind: "host-failed",
      attemptId: this.currentAttemptId ?? "",
      clientId: this.selfLockClientId,
      hostTerm: formatTerm(this.hostTerm),
      workspaceId: this.cohortWorkspaceId ?? this.persistent?.workspaceId ?? "",
      message: msg,
    });

    // Reject any active remote peer RPCs with EIO (never acknowledging new writes!).
    for (const session of this.hostPeers.values()) {
      for (const reqId of Array.from(session.activeReqs)) {
        this.sendPeerFrame(session.peerId, session.channel, {
          kind: "res",
          hostTerm: formatTerm(session.hostTerm),
          sessionId: session.sessionId,
          reqId,
          ok: false,
          errno: 29,
          message: msg,
        });
      }
    }

    // Wake Host-local watchers (page + guest) via watch word
    this.markLocalWatchesOverflow();

    // If NOT disposing, notify page immediately with explicit released:false.
    // If disposing, latch terminalFailure so installFilesystemWorker's { dispose: true }
    // handler posts the ONE { type: "filesystem-disposed", error, released: false }!
    if (!this.disposing) {
      this.options.onFatalError?.(wrapReleaseError(reason, false), false);
    }
  }

  // ---------------------------------------------------------------------------
  // Graceful Host Close & Cooperative OPFS Step-Down (Rev 24 §5.3)
  // ---------------------------------------------------------------------------

  private stepDownInFlight?: Promise<void>;

  private runHostStepDown(trigger: "dispose" | "cooperative"): Promise<void> {
    if (trigger === "dispose" && this.stepDownInFlight) {
      // Single teardown coordinator: join in-flight cooperative step-down which yields to dispose!
      return this.stepDownInFlight.then(async () => {
        if (!this.closedConfirmed && !this.terminalFailure) {
          await this.runHostStepDown("dispose");
        } else if (this.terminalFailure) {
          throw wrapReleaseError(this.terminalFailure.reason, false);
        }
      });
    }
    if (this.stepDownInFlight) return this.stepDownInFlight;
    const run = this.trackBackgroundTask(
      this.executeHostStepDown(trigger).finally(() => {
        if (this.stepDownInFlight === run) this.stepDownInFlight = undefined;
      }),
    );
    this.stepDownInFlight = run;
    return run;
  }

  private async executeHostStepDown(trigger: "dispose" | "cooperative"): Promise<void> {
    const attemptId = this.currentAttemptId;
    const term = this.hostTerm;
    const persistent = this.persistent;
    if (!persistent || !attemptId) return;

    this.steppingDown = true;
    this.phase = "retiring";
    await this.waitForHostAdmittedZero();
    await this.hostQueue;

    if (this.failIfHostTerminal(persistent, trigger)) return;

    const closeFailure = await this.flushHostStepDown(trigger, attemptId, persistent);
    if (this.failIfHostTerminal(persistent, trigger, closeFailure?.reason)) return;

    if (
      trigger === "cooperative" &&
      closeFailure?.failed &&
      !this.ownershipLost &&
      !this.disposing
    ) {
      const handled = await this.tryRestoreAfterCooperativeFlushFailure(attemptId, persistent);
      if (handled) return;
    }

    await this.broadcastDrainAndStepDown(attemptId, term, closeFailure);
    await this.closeHostStorageAndFinalize(trigger, persistent, closeFailure);
  }

  private failIfHostTerminal(
    persistent: PersistentBackend,
    trigger: "dispose" | "cooperative",
    fallbackReason?: unknown,
  ): boolean {
    const terminal = this.currentTerminalFailure();
    if (!terminal && !persistent.isTerminallyFailed()) return false;
    const reason = terminal?.reason ?? persistent.terminalFailureReason() ?? fallbackReason;
    this.enterTerminalStorageFailure(reason);
    if (trigger === "dispose" || this.disposing) throw wrapReleaseError(reason, false);
    return true;
  }

  private async flushHostStepDown(
    trigger: "dispose" | "cooperative",
    attemptId: string,
    persistent: PersistentBackend,
  ): Promise<{ readonly failed: true; readonly reason: unknown } | undefined> {
    if (this.ownershipLost) return undefined;
    if (trigger === "cooperative") await this.hooks.beforeCooperativeFlush?.(attemptId);
    try {
      await persistent.flush();
      return undefined;
    } catch (reason) {
      return { failed: true, reason };
    }
  }

  private async tryRestoreAfterCooperativeFlushFailure(
    attemptId: string,
    persistent: PersistentBackend,
  ): Promise<boolean> {
    let renewAttempt = 0;
    while (
      !this.disposing &&
      !this.ownershipLost &&
      !this.leaseClosed &&
      this.currentAttemptId === attemptId &&
      !persistent.isTerminallyFailed() &&
      !this.isLeaseValid()
    ) {
      renewAttempt++;
      await this.hooks.beforeCooperativeRestoreRenewal?.(attemptId, renewAttempt);
      const ok = await this.renewLeaseNow(attemptId);
      if (ok && this.isLeaseValid()) break;
      if (this.disposing || this.ownershipLost || this.leaseClosed || this.currentTerminalFailure())
        break;
    }
    const terminal = this.currentTerminalFailure();
    if (terminal || persistent.isTerminallyFailed()) {
      this.enterTerminalStorageFailure(terminal?.reason ?? persistent.terminalFailureReason());
      return true;
    }
    if (this.ownershipLost) return true;
    if (
      this.disposing ||
      this.leaseClosed ||
      this.currentAttemptId !== attemptId ||
      !this.isLeaseValid()
    )
      return false;

    this.steppingDown = false;
    this.phase = "ready";
    this.broadcastControl({
      kind: "host-ready",
      attemptId,
      clientId: this.selfLockClientId,
      hostTerm: formatTerm(this.hostTerm),
      workspaceId: persistent.workspaceId,
      storageEpoch: this.hostStorageEpoch,
      lastExclusiveEpoch: this.hostLastExclusiveEpoch,
    });
    return true;
  }

  private async broadcastDrainAndStepDown(
    attemptId: string,
    term: bigint,
    closeFailure: { readonly failed: true; readonly reason: unknown } | undefined,
  ): Promise<void> {
    if (this.currentTerminalFailure()) return;
    const anyPeerWatches = Array.from(this.hostPeers.values()).some((p) => p.watchIds.size > 0);
    this.broadcastControl({ kind: "host-draining", attemptId, hostTerm: formatTerm(term) });
    if (!closeFailure?.failed && !this.ownershipLost && this.isLeaseValid() && anyPeerWatches) {
      await delay(this.timings.drainGraceMs);
    }
    if (!this.currentTerminalFailure()) {
      this.broadcastControl({ kind: "host-stepping-down", attemptId, hostTerm: formatTerm(term) });
    }
  }

  private async closeHostStorageAndFinalize(
    trigger: "dispose" | "cooperative",
    persistent: PersistentBackend,
    initialFailure: { readonly failed: true; readonly reason: unknown } | undefined,
  ): Promise<void> {
    this.leaseClosed = true;
    this.leaseMonoDeadline = 0;
    this.leaseWallDeadline = 0;
    this.stopHostTimers();
    this.closeAllHostPeerSessions();

    let closeFailure = initialFailure;
    let storageCloseFailure: { readonly failed: true; readonly reason: unknown } | undefined;
    if (!this.ownershipLost && !closeFailure?.failed) {
      try {
        await persistent.close();
      } catch (reason) {
        closeFailure = { failed: true, reason };
      }
    }
    if (this.ownershipLost || closeFailure?.failed) {
      try {
        await persistent.retireFenced({ throwOnStorageCloseError: true });
      } catch (reason) {
        storageCloseFailure = { failed: true, reason };
      }
    }

    const storageReleased =
      !storageCloseFailure &&
      !persistent.isTerminallyFailed() &&
      !(await this.isStorageLockHeldBySelf());

    if (!storageReleased) {
      const reason =
        storageCloseFailure?.reason ??
        persistent.terminalFailureReason() ??
        closeFailure?.reason ??
        new Error("Storage lock remained held after close");
      this.enterTerminalStorageFailure(reason);
      if (trigger === "dispose" || this.disposing) throw wrapReleaseError(reason, false);
      return;
    }

    this.captureRetainedSegments(persistent);
    this.setPersistent(undefined);
    this.watchService = undefined;
    if (this.sharedBuffer) persistent.shared.resetForRemount(this.retainedSegments);
    await this.releaseAttemptAndElectionLocks();

    if (trigger === "dispose" || this.disposing) {
      await this.cleanupPeerAndControlChannels(true);
      await this.releasePeerAliveLock();
      this.role = "closed";
      this.phase = "closed";
      this.closedConfirmed = true;
      if (closeFailure?.failed) {
        const err = wrapReleaseError(closeFailure.reason, true);
        this.disposedReleaseError ??= err;
        throw err;
      }
      return;
    }

    this.advanceDirEpoch();
    this.markLocalWatchesOverflow();
    this.detachHandlesForRemount();
    this.role = "failover";
    this.phase = "opening";
    this.startTrackedFailoverLoop();
  }

  // ---------------------------------------------------------------------------
  // Thawed Former Host Demotion vs External Legacy Takeover (Rev 24 §5.5)
  // ---------------------------------------------------------------------------

  private fenceLossInFlight?: Promise<void>;

  private onStorageOwnershipLost(attemptId: string): void {
    if (this.currentAttemptId !== attemptId || this.role !== "host") return;
    void this.handleFenceLoss();
  }

  private handleFenceLoss(
    observedHostReady?: Extract<ControlMessage, { kind: "host-ready" }>,
  ): Promise<void> {
    if (this.fenceLossInFlight) return this.fenceLossInFlight;
    // 1. IMMEDIATE, SYNCHRONOUS fence!
    this.ownershipLost = true;
    this.leaseClosed = true;
    this.leaseMonoDeadline = 0;
    this.leaseWallDeadline = 0;
    this.steppingDown = true;
    this.stopHostTimers();

    const run = this.trackBackgroundTask(
      this.executeFenceLoss(observedHostReady).finally(() => {
        if (this.fenceLossInFlight === run) this.fenceLossInFlight = undefined;
      }),
    );
    this.fenceLossInFlight = run;
    return run;
  }

  private async executeFenceLoss(
    observedHostReady?: Extract<ControlMessage, { kind: "host-ready" }>,
  ): Promise<void> {
    const attemptId = this.currentAttemptId ?? "";
    const ownTerm = this.hostTerm;
    const ownEpoch = this.hostStorageEpoch;
    const workspaceId = this.cohortWorkspaceId ?? this.persistent?.workspaceId ?? "";

    // 2. If disposing is latched: fail pending work with ECANCELED, retireFenced, release locks!
    if (this.disposing) {
      this.closeAllHostPeerSessions();
      if (this.persistent) {
        const persistent = this.persistent;
        this.setPersistent(undefined);
        this.watchService = undefined;
        await persistent.retireFenced().catch(() => {});
        this.captureRetainedSegments(persistent);
        if (this.sharedBuffer) persistent.shared.resetForRemount(this.retainedSegments);
      }
      await this.releaseAttemptAndElectionLocks();
      return;
    }

    // 3. Strict Priority + Watermark Handoff Resolution (BEFORE declaring external takeover!)
    const snap = await this.locks.query();
    const storageHolder = snap.held?.find((l) => l.name === this.storageLockName)?.clientId;
    const holderAttachClaim = hasAttachClaim(snap, this.scope, storageHolder);

    // Check 1: Positively observed live non-attach storageHolder!
    if (
      storageHolder !== undefined &&
      storageHolder !== this.selfLockClientId &&
      !holderAttachClaim
    ) {
      this.broadcastControl({
        kind: "external-takeover",
        attemptId,
        hostTerm: formatTerm(ownTerm),
        workspaceId,
        lastExclusiveEpoch: 0,
        affectedEpoch: ownEpoch,
      });
      await this.retireHostAfterTakeover();
      this.triggerExternalOwnershipLost();
      return;
    }

    // Check 2: Durable monotonic lastExclusiveEpoch watermark!
    let lastExclusive = observedHostReady?.lastExclusiveEpoch ?? 0;
    if (this.options.implementation === "indexeddb" && lastExclusive <= ownEpoch) {
      try {
        const meta = await this.boundedReadEpochMetadata(this.timings.confirmGraceMs);
        if (meta) lastExclusive = Math.max(lastExclusive, meta.lastExclusiveEpoch);
      } catch {
        /* ignore timeout */
      }
    }
    if (lastExclusive > ownEpoch) {
      this.broadcastControl({
        kind: "external-takeover",
        attemptId,
        hostTerm: formatTerm(ownTerm),
        workspaceId,
        lastExclusiveEpoch: lastExclusive,
        affectedEpoch: ownEpoch,
      });
      await this.retireHostAfterTakeover();
      this.triggerExternalOwnershipLost();
      return;
    }

    // Verified multi-tab attach failover -> demote cleanly to Peer!
    this.closeAllHostPeerSessions();
    if (this.persistent) {
      const persistent = this.persistent;
      this.setPersistent(undefined);
      this.watchService = undefined;
      await persistent.retireFenced().catch(() => {});
      this.captureRetainedSegments(persistent);
      if (this.sharedBuffer) persistent.shared.resetForRemount(this.retainedSegments);
    }
    await this.releaseAttemptAndElectionLocks();

    this.ownershipLost = false;
    this.steppingDown = false;
    this.advanceDirEpoch();
    this.markLocalWatchesOverflow();
    this.detachHandlesForRemount();
    this.role = "failover";
    this.phase = "opening";

    if (!this.disposing) {
      this.startTrackedFailoverLoop(observedHostReady);
    }
  }

  private async retireHostAfterTakeover(): Promise<void> {
    this.closeAllHostPeerSessions();
    if (this.persistent) {
      const persistent = this.persistent;
      this.setPersistent(undefined);
      this.watchService = undefined;
      await persistent.retireFenced().catch(() => {});
      this.captureRetainedSegments(persistent);
      if (this.sharedBuffer) persistent.shared.resetForRemount(this.retainedSegments);
    }
    await this.releaseAttemptAndElectionLocks();
  }

  private triggerExternalOwnershipLost(): void {
    if (this.externalOwnershipLostNotified) return;
    this.externalOwnershipLostNotified = true;
    this.ownershipLost = true;
    this.role = "failed";
    this.phase = "failed";
    this.stopHostTimers();
    this.stopPeerTimers();
    this.failAllPeerWork(new FilesystemError(11, "workspace taken over"));
    this.markLocalWatchesOverflow();
    this.options.onOwnershipLost?.();
  }

  // ---------------------------------------------------------------------------
  // Peer Startup, Attach Retry Loop, & Broker Inspection (Rev 24 §5.2 & §5.4)
  // ---------------------------------------------------------------------------

  private async runPeerOrObserverStartup(signal: AbortSignal): Promise<void> {
    this.role = "waiting";
    await this.discoverOrRecover(signal);
  }

  private async tryNonStealHostOpen(signal: AbortSignal): Promise<"mounted" | "busy"> {
    const attemptId = this.beginFreshAttempt();
    await this.acquireAttemptLocks(attemptId, "open", signal);
    this.phase = "opening";
    this.broadcastControl({
      kind: "host-status",
      attemptId,
      clientId: this.selfLockClientId,
      phase: "opening",
    });
    if (this.options.implementation !== "indexeddb") {
      await this.openOpfsWithHostReadyCancel(attemptId, signal);
      return "mounted";
    }
    let storage: StorageBackend;
    try {
      storage = await this.openStorageFn("indexeddb", this.options.name, {
        whenBusy: "ifAvailable",
        epochOwner: "attach",
        signal,
        onStartupStage: this.options.onStartupStage,
        onOwnershipLost: () => this.onStorageOwnershipLost(attemptId),
      });
    } catch (error) {
      if (this.isBusyError(error)) {
        await this.releaseAttemptAndElectionLocks();
        return "busy";
      }
      throw error;
    }
    await this.activateMountedHost(
      attemptId,
      storage,
      signal,
      this.cohortWorkspaceId !== undefined,
    );
    return "mounted";
  }

  private async inspectBrokerAfterBusy(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.disposing) {
      const snap = await this.locks.query();
      const storageHolder = snap.held?.find((l) => l.name === this.storageLockName)?.clientId;
      const maintExclusive = this.hasExclusiveMaintenanceLock(snap);

      if (storageHolder === undefined && !maintExclusive) {
        // Prior owner exited right between ifAvailable and locks.query() -> retry non-steal open!
        const outcome = await this.tryNonStealHostOpen(signal);
        if (outcome === "mounted") return;
        await delay(Math.min(25, this.timings.waitPollMs), signal);
        continue;
      }

      const holderClaim = hasAttachClaim(snap, this.scope, storageHolder);
      if (storageHolder !== undefined && holderClaim && !maintExclusive) {
        await this.discoverOrRecover(signal);
        return;
      }

      // Non-attach legacy/idle owner or exclusive maintenance -> cancellable waiting loop!
      if (await this.enterRecoveryWaitingState(signal)) return;
    }
    throw abortError();
  }

  private hasExclusiveMaintenanceLock(snap: LockManagerSnapshot): boolean {
    if (this.options.implementation !== "indexeddb") return false;
    return (
      !!snap.held?.some((l) => l.name === this.maintLockName && l.mode === "exclusive") ||
      !!snap.pending?.some((l) => l.name === this.maintLockName && l.mode === "exclusive")
    );
  }

  private async enterRecoveryWaitingState(signal: AbortSignal): Promise<boolean> {
    this.role = "waiting";
    this.phase = "waiting-storage";
    this.notifyState("waiting");
    const woke = await this.waitForHostReadyOrPoll(this.timings.waitPollMs, signal);
    if (!woke) return false;
    return this.tryAttachToHostReady(woke, signal);
  }

  private waitForControlMatch<T>(
    ms: number,
    signal: AbortSignal,
    match: (msg: ControlMessage) => T | undefined,
    onStart?: () => void,
  ): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        this.controlListeners.delete(onMsg);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const onMsg = (msg: ControlMessage) => {
        const matched = match(msg);
        if (matched !== undefined) {
          cleanup();
          resolve(matched);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, ms);
      this.controlListeners.add(onMsg);
      signal.addEventListener("abort", onAbort, { once: true });
      onStart?.();
    });
  }

  private waitForHostReadyOrPoll(
    ms: number,
    signal: AbortSignal,
  ): Promise<Extract<ControlMessage, { kind: "host-ready" }> | undefined> {
    return this.waitForControlMatch(ms, signal, (msg) =>
      msg.kind === "host-ready" && msg.clientId !== this.selfLockClientId ? msg : undefined,
    );
  }

  private async discoverOrRecover(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.disposing) {
      const received = await this.waitForControlMatch(
        this.timings.confirmGraceMs,
        signal,
        (msg) => {
          if (
            msg.kind === "host-ready" ||
            msg.kind === "host-failed" ||
            msg.kind === "host-status"
          ) {
            return msg.clientId !== this.selfLockClientId ? msg : undefined;
          }
          return undefined;
        },
        () => this.broadcastControl({ kind: "discover", fromPeerId: this.selfId }),
      );

      if (received?.kind === "host-ready") {
        const attached = await this.tryAttachToHostReady(received, signal);
        if (attached) return;
        await this.runRecoveryProbeAndDispatch(signal);
        if (this.role === "host" || (this.role === "peer" && this.peerAttached)) return;
        continue;
      }

      if (received?.kind === "host-failed") {
        this.handleObservedHostFailed(received);
        await delay(this.timings.waitPollMs, signal);
        continue;
      }

      if (received?.kind === "host-status") {
        if (received.phase === "waiting-storage") this.notifyState("waiting");
        const candidateAlive = await this.monitorCandidateStatus(received, signal);
        if (candidateAlive === "attached") return;
        await this.runRecoveryProbeAndDispatch(signal);
        if (this.role === "host" || (this.role === "peer" && this.peerAttached)) return;
        continue;
      }

      await this.runRecoveryProbeAndDispatch(signal);
      if (this.role === "host" || (this.role === "peer" && this.peerAttached)) return;
    }
    throw abortError();
  }

  private async monitorCandidateStatus(
    status: Extract<ControlMessage, { kind: "host-status" }>,
    signal: AbortSignal,
  ): Promise<"attached" | "gone" | "silent"> {
    let lastHeardAt = Date.now();
    let readyMsg: Extract<ControlMessage, { kind: "host-ready" }> | undefined;
    let aliveReleased = false;
    const watchAbort = new AbortController();
    const linked = linkAbortSignals(signal, watchAbort.signal);

    watchLockRelease(this.locks, aliveLockName(this.scope, status.attemptId), linked.signal, () => {
      aliveReleased = true;
    });

    const onMsg = (msg: ControlMessage) => {
      if (msg.kind === "host-ready" && msg.clientId !== this.selfLockClientId) {
        readyMsg = msg;
      } else if (
        msg.kind === "host-status" &&
        msg.attemptId === status.attemptId &&
        msg.clientId === status.clientId
      ) {
        lastHeardAt = Date.now();
      } else if (msg.kind === "host-failed" && msg.clientId === status.clientId) {
        this.handleObservedHostFailed(msg);
      }
    };
    this.controlListeners.add(onMsg);

    try {
      while (!linked.signal.aborted) {
        if (readyMsg) {
          return (await this.tryAttachToHostReady(readyMsg, signal)) ? "attached" : "silent";
        }
        if (aliveReleased) return "gone";
        if (Date.now() - lastHeardAt >= this.timings.heartbeatTimeoutMs) return "silent";
        await delay(
          Math.min(this.timings.heartbeatIntervalMs, this.timings.confirmGraceMs),
          linked.signal,
        );
        if (readyMsg) continue;
        this.broadcastControl({ kind: "discover", fromPeerId: this.selfId });
      }
    } finally {
      watchAbort.abort();
      this.controlListeners.delete(onMsg);
      linked.cleanup();
    }
    return "silent";
  }

  private async attachToHostReady(
    ready: Extract<ControlMessage, { kind: "host-ready" }>,
    signal: AbortSignal,
  ): Promise<void> {
    const ok = await this.tryAttachToHostReady(ready, signal);
    if (!ok) {
      await this.runRecoveryProbeAndDispatch(signal);
    }
  }

  /** Idempotent attach retry loop every attachRetryMs up to heartbeatTimeoutMs (Rev 24 §4.2 & §5.2). */
  private async tryAttachToHostReady(
    ready: Extract<ControlMessage, { kind: "host-ready" }>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const term = parseTerm(ready.hostTerm);
    if (term === undefined) return false;

    // Validate cohort epoch BEFORE attaching!
    const validation = this.validateCohortEpoch(ready.workspaceId, ready.lastExclusiveEpoch);
    if (validation === "workspace-replaced") {
      const err = new FilesystemError(11, "workspace was deleted and replaced");
      this.failTabWithFatal(err, true);
      throw err;
    }
    if (validation === "external-takeover") {
      this.triggerExternalOwnershipLost();
      throw new FilesystemError(11, "workspace taken over by exclusive owner");
    }

    const sessionId = crypto.randomUUID();
    this.closePeerChannelOnly();
    const channel = this.createChannel(peerChannelName(this.scope, term, this.selfId));
    this.peerChannel = channel;
    this.peerHostAttemptId = ready.attemptId;
    this.peerHostClientId = ready.clientId;
    this.peerHostTerm = term;
    this.peerSessionId = sessionId;
    this.peerAttached = false;
    this.peerGrantedFrames = 0;
    this.peerGrantedBytes = 0;
    this.peerAvailableFrames = 0;
    this.peerAvailableBytes = 0;
    this.peerLatestSeenWakeSeq = 0;
    this.peerPendingUnpins.clear();
    this.peerPendingWatchAcks.clear();
    this.peerPendingWatchCloses.clear();
    this.peerPendingUploadAborts.clear();

    const attachedGate = Promise.withResolvers<PeerCreditLimit | "failed" | "rejected">();
    let newerHostReady = false;

    const onControl = (msg: ControlMessage) => {
      if (msg.kind === "host-ready" && msg.clientId !== this.selfLockClientId) {
        const msgTerm = parseTerm(msg.hostTerm);
        if (msgTerm !== undefined && msgTerm > term) {
          newerHostReady = true;
          attachedGate.resolve("rejected");
        }
      } else if (msg.kind === "host-failed" && msg.attemptId === ready.attemptId) {
        this.handleObservedHostFailed(msg);
        attachedGate.resolve("failed");
      }
    };
    this.controlListeners.add(onControl);

    channel.onmessage = (event) => {
      if (!isPeerMessage(event.data)) return;
      const msg = event.data;
      if (msg.sessionId !== sessionId || msg.hostTerm !== ready.hostTerm) return;
      if (!this.peerAttached) {
        if (msg.kind === "attached") {
          attachedGate.resolve(msg.creditLimit);
          return;
        }
        if (msg.kind === "attach-rejected") {
          attachedGate.resolve("rejected");
          return;
        }
        // Ignore early credit-limit frames arriving before attached (§4.2)!
        return;
      }
      this.onPeerMessage(msg);
    };
    channel.onmessageerror = () => {
      if (!this.peerAttached) attachedGate.resolve("rejected");
      else this.triggerPeerSessionReset("messageerror");
    };

    const startedAt = Date.now();
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => attachedGate.resolve("rejected");
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const sendAttach = () => {
        this.broadcastControl({
          kind: "attach",
          peerId: this.selfId,
          sessionId,
          hostTerm: ready.hostTerm,
          targetAttemptId: ready.attemptId,
        });
      };
      sendAttach();
      retryTimer = setInterval(() => {
        if (Date.now() - startedAt >= this.timings.heartbeatTimeoutMs) {
          attachedGate.resolve("rejected");
          return;
        }
        sendAttach();
      }, this.timings.attachRetryMs);

      const outcome = await attachedGate.promise;
      if (signal.aborted || this.disposing) throw abortError();
      if (outcome === "failed" || outcome === "rejected" || newerHostReady) {
        if (this.peerSessionId === sessionId) this.closePeerChannelOnly();
        return false;
      }

      // Attached! Commit cohort state, grant initial credits, install liveness + heartbeat!
      const isNewTerm = this.hostTerm !== term;
      this.hostTerm = term;
      this.commitCohortEpoch(ready.workspaceId, ready.storageEpoch);
      this.peerObservedHostFailed = undefined;
      this.peerAttached = true;
      this.applyPeerCreditLimit(outcome);
      this.peerLastHostActivityAt = Date.now();
      this.role = "peer";
      this.phase = "ready";

      if (isNewTerm) {
        this.mountGeneration++;
        this.advanceDirEpoch();
        this.markLocalWatchesOverflow();
      }

      this.installPeerHostWatchers(ready.attemptId, term);
      this.notifyState("ready");

      // Rebind live handles by fileId on the new Host/session, then drain retry & failover queues!
      try {
        await this.rebindPeerHandles(term, sessionId);
      } catch (error) {
        if (signal.aborted || this.disposing || this.ownershipLost) throw error;
        if (this.peerSessionId !== sessionId) return false;
        this.stopPeerTimers();
        this.closePeerChannelOnly();
        this.peerAttached = false;
        this.role = "failover";
        return false;
      }
      if (this.peerSessionId !== sessionId || !this.peerAttached) return false;
      this.drainPeerRetryAndFailoverQueues();
      return true;
    } finally {
      if (retryTimer) clearInterval(retryTimer);
      this.controlListeners.delete(onControl);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private installPeerHostWatchers(attemptId: string, term: bigint): void {
    this.stopPeerTimers();
    this.peerHostAliveAbort = new AbortController();
    watchLockRelease(
      this.locks,
      aliveLockName(this.scope, attemptId),
      this.peerHostAliveAbort.signal,
      () => {
        if (this.role === "peer" && this.peerHostTerm === term && !this.disposing) {
          this.beginPeerFailover("host-alive-released");
        }
      },
    );
    this.peerHeartbeatTimer = setInterval(() => {
      if (this.role !== "peer" || !this.peerAttached || this.disposing) return;
      if (Date.now() - this.peerLastHostActivityAt >= this.timings.heartbeatTimeoutMs) {
        this.beginPeerFailover("heartbeat-timeout");
        return;
      }
      this.sendPeerHeartbeat();
    }, this.timings.heartbeatIntervalMs);
  }

  private stopPeerTimers(): void {
    if (this.peerHeartbeatTimer) {
      clearInterval(this.peerHeartbeatTimer);
      this.peerHeartbeatTimer = undefined;
    }
    this.peerHostAliveAbort?.abort();
    this.peerHostAliveAbort = undefined;
  }

  // ---------------------------------------------------------------------------
  // Recovery Probe & Dispatch (Rev 24 §5.4)
  // ---------------------------------------------------------------------------

  private async runRecoveryProbeAndDispatch(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposing) throw abortError();

    // Step 1: Authoritative Broker Inspection & Targeted Confirmation Probe (ZERO locks held!)
    const initialSnap = await this.locks.query();
    const initialStorageHolder = initialSnap.held?.find(
      (l) => l.name === this.storageLockName,
    )?.clientId;
    const initialTargetClaim = hasAttachClaim(initialSnap, this.scope, initialStorageHolder);
    const initialTargetAttemptId = initialTargetClaim?.name
      ? parseAttachClaimAttemptId(this.scope, initialTargetClaim.name)
      : undefined;

    const probe = this.createRecoveryProbeMonitor(initialStorageHolder, initialTargetAttemptId);
    this.controlListeners.add(probe.onControl);

    try {
      if (await this.runInitialRecoveryProbe(probe, signal)) return;

      // Step 2: Re-read broker snapshot (keeping targetResponded active!)
      const snap = await this.locks.query();
      if (probe.responded()) {
        if (probe.failed()) {
          this.handleObservedHostFailed(probe.failed()!);
          return;
        }
        await this.inspectBrokerAfterBusy(signal);
        return;
      }

      const storageHolder = snap.held?.find((l) => l.name === this.storageLockName)?.clientId;
      const targetClaim = hasAttachClaim(snap, this.scope, storageHolder);
      const targetAttemptId = targetClaim?.name
        ? parseAttachClaimAttemptId(this.scope, targetClaim.name)
        : undefined;
      const maintExclusive = this.hasExclusiveMaintenanceLock(snap);
      const externalPending = !!snap.pending?.some((l) => l.name === this.storageLockName);

      // Case 1: Storage is FREE! NEVER steal electionLock or storageLock!
      if (storageHolder === undefined && !maintExclusive) {
        const outcome = await this.tryNonStealHostOpen(signal);
        if (outcome === "busy") await this.inspectBrokerAfterBusy(signal);
        return;
      }

      // Case 2: maintExclusive OR !storageIsAttach (healthy legacy/idle writer) -> DO NOT STEAL!
      if (
        maintExclusive ||
        !storageHolder ||
        !targetClaim ||
        !targetAttemptId ||
        storageHolder === this.selfLockClientId
      ) {
        await this.enterRecoveryWaitingState(signal);
        return;
      }

      // Case 3: storageHolder changed (or appeared after being absent/non-attach) between
      // Step 1 probe and Step 2 -> re-probe the new holder first!
      if (
        !initialTargetClaim ||
        storageHolder !== initialStorageHolder ||
        targetClaim.name !== initialTargetClaim.name
      ) {
        return;
      }

      // Case 3a: OPFS -> cooperative-step-down, then cancellable wait if hard-frozen!
      if (this.options.implementation === "opfs-memory") {
        await this.runRecoveryOpfsStepDown(targetAttemptId, signal);
        return;
      }

      // Case 3b: IndexedDB verified steal!
      if (externalPending) {
        await this.enterRecoveryWaitingState(signal);
        return;
      }

      await this.runRecoveryIndexedDBSteal(
        storageHolder,
        targetClaim,
        targetAttemptId,
        probe,
        signal,
      );
    } finally {
      this.controlListeners.delete(probe.onControl);
    }
  }

  private createRecoveryProbeMonitor(
    initialStorageHolder: string | undefined,
    initialTargetAttemptId: string | undefined,
  ): {
    readonly preStealAbort: AbortController;
    readonly onControl: (msg: ControlMessage) => void;
    responded: () => boolean;
    ready: () => Extract<ControlMessage, { kind: "host-ready" }> | undefined;
    failed: () => Extract<ControlMessage, { kind: "host-failed" }> | undefined;
  } {
    let targetResponded = false;
    let discoveredReady: Extract<ControlMessage, { kind: "host-ready" }> | undefined;
    let discoveredFailed: Extract<ControlMessage, { kind: "host-failed" }> | undefined;
    const preStealAbort = new AbortController();

    const markTargetAlive = () => {
      targetResponded = true;
      if (!preStealAbort.signal.aborted) preStealAbort.abort();
    };

    const onControl = (msg: ControlMessage) => {
      if (msg.kind === "host-ready" && msg.clientId !== this.selfLockClientId) {
        discoveredReady = msg;
        markTargetAlive();
      } else if (
        msg.kind === "host-status" &&
        msg.clientId !== this.selfLockClientId &&
        initialStorageHolder !== undefined &&
        msg.clientId === initialStorageHolder &&
        (initialTargetAttemptId === undefined || msg.attemptId === initialTargetAttemptId)
      ) {
        markTargetAlive();
      } else if (
        msg.kind === "host-failed" &&
        msg.clientId !== this.selfLockClientId &&
        (initialStorageHolder === undefined ||
          msg.clientId === initialStorageHolder ||
          (this.peerHostTerm !== undefined && msg.hostTerm === formatTerm(this.peerHostTerm)))
      ) {
        discoveredFailed = msg;
        markTargetAlive();
      }
    };

    return {
      preStealAbort,
      onControl,
      responded: () => targetResponded,
      ready: () => discoveredReady,
      failed: () => discoveredFailed,
    };
  }

  private async runInitialRecoveryProbe(
    probe: ReturnType<MultiTabBackend["createRecoveryProbeMonitor"]>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.peerChannel && this.peerAttached && this.peerSessionId && this.peerHostTerm) {
      this.sendPeerHeartbeat();
    }
    this.broadcastControl({ kind: "discover", fromPeerId: this.selfId });

    const probeWait = linkAbortSignals(signal, probe.preStealAbort.signal);
    try {
      await delay(this.timings.confirmGraceMs, probeWait.signal);
    } catch {
      if (signal.aborted || this.disposing) throw abortError();
    } finally {
      probeWait.cleanup();
    }

    const failed = probe.failed();
    if (failed) {
      this.handleObservedHostFailed(failed);
      await delay(this.timings.waitPollMs, signal);
      return true;
    }

    const ready = probe.ready();
    if (ready) {
      if (
        this.role === "peer" &&
        this.peerAttached &&
        this.peerHostTerm !== undefined &&
        formatTerm(this.peerHostTerm) === ready.hostTerm
      ) {
        this.peerLastHostActivityAt = Date.now();
        return true;
      }
      await this.tryAttachToHostReady(ready, signal);
      return true;
    }

    if (probe.responded()) {
      await delay(this.timings.waitPollMs, signal);
      return true;
    }
    return false;
  }

  private async runRecoveryOpfsStepDown(
    targetAttemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.broadcastControl({
      kind: "cooperative-step-down",
      targetAttemptId,
      targetTerm: formatTerm(this.peerHostTerm ?? this.hostTerm),
    });
    const releaseGate = Promise.withResolvers<boolean>();
    const watchAbort = new AbortController();
    const linked = linkAbortSignals(signal, watchAbort.signal);
    watchLockRelease(this.locks, aliveLockName(this.scope, targetAttemptId), linked.signal, () =>
      releaseGate.resolve(true),
    );
    const timer = setTimeout(() => releaseGate.resolve(false), this.timings.confirmGraceMs);
    let released = false;
    try {
      released = await releaseGate.promise;
    } finally {
      clearTimeout(timer);
      watchAbort.abort();
      linked.cleanup();
    }
    if (signal.aborted || this.disposing) throw abortError();
    if (released) {
      await this.inspectBrokerAfterBusy(signal);
      return;
    }
    await this.enterRecoveryWaitingState(signal);
  }

  private async runRecoveryIndexedDBSteal(
    storageHolder: string,
    targetClaim: LockInfo,
    targetAttemptId: string,
    probe: ReturnType<MultiTabBackend["createRecoveryProbeMonitor"]>,
    signal: AbortSignal,
  ): Promise<void> {
    const meta = await this.readRecoveryEpochMetadata(probe, signal);
    if (!meta) return;

    const observedEpoch = meta.epoch;
    const observedLastExclusive = meta.lastExclusiveEpoch;

    if (
      this.cohortWorkspaceId !== undefined &&
      this.cohortLastAcceptedEpoch !== undefined &&
      observedLastExclusive > this.cohortLastAcceptedEpoch
    ) {
      this.broadcastControl({
        kind: "external-takeover",
        attemptId: targetAttemptId,
        hostTerm: formatTerm(this.hostTerm),
        workspaceId: this.cohortWorkspaceId,
        lastExclusiveEpoch: observedLastExclusive,
        affectedEpoch: this.cohortLastAcceptedEpoch,
      });
      this.triggerExternalOwnershipLost();
      throw new FilesystemError(11, "workspace taken over by exclusive owner");
    }

    let recoverLock = await this.acquireRecoveryCoordinationLock(signal);
    if (!recoverLock) {
      await delay(this.timings.waitPollMs, signal);
      return;
    }

    const releaseRecoverLock = async () => {
      const lock = recoverLock;
      recoverLock = undefined;
      if (lock) await lock.release();
    };
    const recoverTimer = setTimeout(() => {
      void releaseRecoverLock();
      if (!signal.aborted && !this.disposing && !this.ownershipLost && this.role !== "host") {
        this.role = "waiting";
        this.phase = "waiting-storage";
        this.notifyState("waiting");
      }
    }, this.timings.recoverTimeoutMs);

    const attemptId = this.beginFreshAttempt();
    const stealMode = `steal:${encodeURIComponent(storageHolder)}:${observedEpoch}`;
    const preStealLinked = linkAbortSignals(signal, probe.preStealAbort.signal);

    try {
      await this.hooks.beforeRecoverySteal?.();
      if (probe.responded()) {
        await releaseRecoverLock();
        await this.inspectBrokerAfterBusy(signal);
        return;
      }

      await this.acquireAttemptLocks(attemptId, stealMode, preStealLinked.signal);
      this.phase = "opening";
      this.broadcastControl({
        kind: "host-status",
        attemptId,
        clientId: this.selfLockClientId,
        phase: "opening",
      });

      const storage = await this.openIndexedDBStealTarget(
        attemptId,
        observedEpoch,
        storageHolder,
        targetClaim,
        probe,
        preStealLinked.signal,
        signal,
        releaseRecoverLock,
      );
      if (!storage) return;

      clearTimeout(recoverTimer);
      await releaseRecoverLock();
      await this.activateMountedHost(attemptId, storage, signal, true);
    } finally {
      clearTimeout(recoverTimer);
      preStealLinked.cleanup();
      await releaseRecoverLock();
    }
  }

  private async acquireRecoveryCoordinationLock(
    signal: AbortSignal,
  ): Promise<HeldLock | undefined> {
    const lockName = recoverLockName(this.scope);
    const immediate = await acquireHeldLock(this.locks, lockName, {
      mode: "exclusive",
      ifAvailable: true,
    });
    if (immediate) {
      this.recoverContentionStartedAt = undefined;
      this.recoverContentionHolder = undefined;
      return immediate;
    }

    const snap = await this.locks.query();
    const holder = snap.held?.find((l) => l.name === lockName)?.clientId;
    if (!holder || holder === this.selfLockClientId) {
      this.recoverContentionStartedAt = undefined;
      this.recoverContentionHolder = undefined;
      return undefined;
    }

    const now = performance.now();
    if (this.recoverContentionHolder !== holder || this.recoverContentionStartedAt === undefined) {
      this.recoverContentionHolder = holder;
      this.recoverContentionStartedAt = now;
      return undefined;
    }

    if (now - this.recoverContentionStartedAt < this.timings.recoverTimeoutMs) {
      return undefined;
    }

    // Frozen contender held recoverLock past recoverTimeoutMs -> steal recoverLock (Rev 24 §5.4)!
    if (signal.aborted || this.disposing) throw abortError();
    this.recoverContentionStartedAt = undefined;
    this.recoverContentionHolder = undefined;
    return acquireHeldLock(this.locks, lockName, {
      mode: "exclusive",
      steal: true,
    });
  }

  private async readRecoveryEpochMetadata(
    probe: ReturnType<MultiTabBackend["createRecoveryProbeMonitor"]>,
    signal: AbortSignal,
  ): Promise<{ epoch: number; lastExclusiveEpoch: number } | undefined> {
    await this.hooks.beforeRecoveryReadonlyCheck?.();
    if (probe.responded()) {
      await this.inspectBrokerAfterBusy(signal);
      return undefined;
    }
    const readonlyLinked = linkAbortSignals(signal, probe.preStealAbort.signal);
    try {
      const meta = await this.boundedReadEpochMetadata(
        this.timings.confirmGraceMs,
        readonlyLinked.signal,
      );
      if (probe.responded()) {
        await this.inspectBrokerAfterBusy(signal);
        return undefined;
      }
      return meta ?? { epoch: 0, lastExclusiveEpoch: 0 };
    } catch (_error) {
      if (signal.aborted || this.disposing) throw abortError();
      if (probe.responded()) {
        await this.inspectBrokerAfterBusy(signal);
        return undefined;
      }
      this.role = "waiting";
      this.phase = "waiting-storage";
      this.notifyState("waiting");
      await delay(this.timings.waitPollMs, signal);
      return undefined;
    } finally {
      readonlyLinked.cleanup();
    }
  }

  private async openIndexedDBStealTarget(
    attemptId: string,
    observedEpoch: number,
    storageHolder: string,
    targetClaim: LockInfo,
    probe: ReturnType<MultiTabBackend["createRecoveryProbeMonitor"]>,
    preStealSignal: AbortSignal,
    signal: AbortSignal,
    releaseRecoverLock: () => Promise<void>,
  ): Promise<StorageBackend | undefined> {
    try {
      return await this.openStorageFn("indexeddb", this.options.name, {
        whenBusy: "takeover",
        expectedEpoch: observedEpoch,
        epochOwner: "attach",
        preStealSignal,
        signal,
        onStartupStage: this.options.onStartupStage,
        onOwnershipLost: () => this.onStorageOwnershipLost(attemptId),
        verifyStealTarget: (arbSnap) =>
          this.verifyIndexedDBStealTarget(arbSnap, storageHolder, targetClaim, probe, signal),
      });
    } catch (error) {
      await this.releaseAttemptAndElectionLocks();
      await releaseRecoverLock();
      if (signal.aborted || this.disposing) throw abortError();
      const errName = error && typeof error === "object" ? Reflect.get(error, "name") : "";
      if (
        probe.responded() ||
        errName === "StealTargetMismatchError" ||
        errName === "ExpectedEpochMismatchError" ||
        isAbortLike(error)
      ) {
        await this.inspectBrokerAfterBusy(signal);
        return undefined;
      }
      throw error;
    }
  }

  private verifyIndexedDBStealTarget(
    arbSnap: LockManagerSnapshot,
    storageHolder: string,
    targetClaim: LockInfo,
    probe: ReturnType<MultiTabBackend["createRecoveryProbeMonitor"]>,
    signal: AbortSignal,
  ): boolean {
    if (probe.responded() || signal.aborted || this.disposing) return false;
    const currentHolder = arbSnap.held?.find((l) => l.name === this.storageLockName)?.clientId;
    if (currentHolder !== storageHolder) return false;
    const exactClaim = arbSnap.held?.some(
      (l) => l.name === targetClaim.name && l.clientId === storageHolder,
    );
    if (!exactClaim) return false;
    if (this.hasExclusiveMaintenanceLock(arbSnap)) return false;
    if (arbSnap.pending?.some((l) => l.name === this.storageLockName)) return false;
    return true;
  }

  private async boundedReadEpochMetadata(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ epoch: number; lastExclusiveEpoch: number } | undefined> {
    const controller = new AbortController();
    const linked = linkAbortSignals(signal, controller.signal);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.readEpochMetadataFn(this.options.name, linked.signal);
    } finally {
      clearTimeout(timer);
      linked.cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // Cohort Validation (Rev 24 §4)
  // ---------------------------------------------------------------------------

  private validateCohortEpoch(
    workspaceId: string,
    lastExclusiveEpoch: number,
  ): "ok" | "workspace-replaced" | "external-takeover" {
    if (this.cohortWorkspaceId === undefined) return "ok";
    if (workspaceId !== this.cohortWorkspaceId) return "workspace-replaced";
    if (
      this.cohortLastAcceptedEpoch !== undefined &&
      lastExclusiveEpoch > this.cohortLastAcceptedEpoch
    )
      return "external-takeover";
    return "ok";
  }

  private commitCohortEpoch(workspaceId: string, storageEpoch: number): void {
    this.cohortWorkspaceId = workspaceId;
    this.cohortLastAcceptedEpoch = Math.max(this.cohortLastAcceptedEpoch ?? 0, storageEpoch);
  }

  // ---------------------------------------------------------------------------
  // Control Channel Message Handling
  // ---------------------------------------------------------------------------

  private broadcastControl(message: ControlMessage): void {
    if (this.hooks.onControlSend?.(message) === false) return;
    try {
      this.controlChannel.postMessage(message);
    } catch {
      /* channel closed */
    }
  }

  private onControlMessage(msg: ControlMessage): void {
    for (const listener of Array.from(this.controlListeners)) {
      listener(msg);
    }

    if (this.terminalFailure && this.currentAttemptId) {
      if (msg.kind === "discover" || msg.kind === "attach") {
        this.broadcastControl({
          kind: "host-failed",
          attemptId: this.currentAttemptId,
          clientId: this.selfLockClientId,
          hostTerm: formatTerm(this.hostTerm),
          workspaceId: this.cohortWorkspaceId ?? "",
          message: describeReason(this.terminalFailure.reason),
        });
      }
      return;
    }

    switch (msg.kind) {
      case "discover":
        this.onControlDiscover();
        return;
      case "attach":
        this.onControlAttach(msg);
        return;
      case "host-ready":
        this.onControlHostReady(msg);
        return;
      case "host-draining":
        if (this.isCurrentPeerHostTerm(msg.hostTerm)) this.peerLastHostActivityAt = Date.now();
        return;
      case "host-stepping-down":
        if (this.isCurrentPeerHostTerm(msg.hostTerm) && !this.disposing) {
          this.beginPeerFailover("host-stepping-down");
        }
        return;
      case "host-failed":
        if (msg.clientId === this.selfLockClientId) return;
        if (
          this.role === "peer" &&
          ((this.peerHostAttemptId && msg.attemptId === this.peerHostAttemptId) ||
            this.isCurrentPeerHostTerm(msg.hostTerm))
        ) {
          this.handleObservedHostFailed(msg);
        }
        return;
      case "cooperative-step-down":
        this.onControlCooperativeStepDown(msg);
        return;
      case "external-takeover":
        this.onControlExternalTakeover(msg);
        return;
      case "workspace-replaced":
        if (
          !this.disposing &&
          this.cohortWorkspaceId &&
          this.cohortWorkspaceId === msg.expectedWorkspaceId
        ) {
          this.failTabWithFatal(
            new FilesystemError(11, "workspace was deleted and replaced"),
            true,
          );
        }
        return;
    }
  }

  private isCurrentPeerHostTerm(hostTerm: string): boolean {
    return (
      this.role === "peer" &&
      this.peerHostTerm !== undefined &&
      hostTerm === formatTerm(this.peerHostTerm)
    );
  }

  private onControlDiscover(): void {
    if (this.role === "host" && !this.ownershipLost) {
      if (this.steppingDown || this.disposing || this.phase === "retiring") {
        this.broadcastControl({
          kind: "host-status",
          attemptId: this.currentAttemptId!,
          clientId: this.selfLockClientId,
          phase: "retiring",
          hostTerm: formatTerm(this.hostTerm),
        });
      } else if (this.phase === "ready" && this.persistent) {
        this.broadcastControl({
          kind: "host-ready",
          attemptId: this.currentAttemptId!,
          clientId: this.selfLockClientId,
          hostTerm: formatTerm(this.hostTerm),
          workspaceId: this.persistent.workspaceId,
          storageEpoch: this.hostStorageEpoch,
          lastExclusiveEpoch: this.hostLastExclusiveEpoch,
        });
      }
      return;
    }
    if (
      (this.phase === "opening" || this.phase === "waiting-storage") &&
      this.currentAttemptId &&
      !this.disposing
    ) {
      this.broadcastControl({
        kind: "host-status",
        attemptId: this.currentAttemptId,
        clientId: this.selfLockClientId,
        phase: this.phase,
      });
    }
  }

  private onControlAttach(msg: Extract<ControlMessage, { kind: "attach" }>): void {
    if (this.role !== "host" || this.ownershipLost || this.disposing) return;
    if (msg.peerId === this.selfId) return;
    if (this.steppingDown || this.phase === "retiring") {
      this.broadcastControl({
        kind: "host-status",
        attemptId: this.currentAttemptId!,
        clientId: this.selfLockClientId,
        phase: "retiring",
        hostTerm: formatTerm(this.hostTerm),
      });
      return;
    }
    if (this.phase !== "ready" || msg.hostTerm !== formatTerm(this.hostTerm)) return;
    if (msg.targetAttemptId && msg.targetAttemptId !== this.currentAttemptId) return;
    this.handleHostAttachRequest(msg.peerId, msg.sessionId);
  }

  private onControlHostReady(msg: Extract<ControlMessage, { kind: "host-ready" }>): void {
    if (msg.clientId === this.selfLockClientId) return;
    const msgTerm = parseTerm(msg.hostTerm);
    if (msgTerm === undefined) return;
    if (
      this.role === "peer" &&
      this.peerAttached &&
      this.peerHostTerm === msgTerm &&
      this.peerHostAttemptId === msg.attemptId
    ) {
      this.peerLastHostActivityAt = Date.now();
      this.drainPeerRetryQueue();
      return;
    }
    if (
      this.role === "host" &&
      this.cohortWorkspaceId === msg.workspaceId &&
      msgTerm > this.hostTerm
    ) {
      void this.handleFenceLoss(msg);
      return;
    }
    if (
      this.role === "peer" &&
      this.peerHostTerm !== undefined &&
      msgTerm > this.peerHostTerm &&
      !this.disposing
    ) {
      this.beginPeerFailover("newer-host-ready", msg);
    }
  }

  private onControlCooperativeStepDown(
    msg: Extract<ControlMessage, { kind: "cooperative-step-down" }>,
  ): void {
    if (
      this.role === "host" &&
      this.options.implementation === "opfs-memory" &&
      !this.ownershipLost &&
      !this.disposing &&
      !this.terminalFailure &&
      msg.targetAttemptId === this.currentAttemptId
    ) {
      void this.runHostStepDown("cooperative");
    }
  }

  private onControlExternalTakeover(
    msg: Extract<ControlMessage, { kind: "external-takeover" }>,
  ): void {
    if (this.disposing || this.ownershipLost) return;
    if (this.cohortWorkspaceId !== msg.workspaceId) return;
    if (this.cohortLastAcceptedEpoch === undefined) return;
    const applies =
      (msg.lastExclusiveEpoch > 0 && this.cohortLastAcceptedEpoch < msg.lastExclusiveEpoch) ||
      (msg.lastExclusiveEpoch === 0 && this.cohortLastAcceptedEpoch <= msg.affectedEpoch);
    if (!applies) return;
    if (this.role === "host") {
      void this.trackBackgroundTask(
        this.retireHostAfterTakeover().then(() => this.triggerExternalOwnershipLost()),
      );
    } else {
      this.triggerExternalOwnershipLost();
    }
  }

  private markWatchOverflowById(localWatchId: number | undefined): void {
    if (localWatchId === undefined) return;
    const watch = this.localWatches.get(localWatchId);
    if (watch) watch.overflowed = true;
  }

  private resolveWatchOverflow(
    localWatchId: number | undefined,
    resolve: (value: any) => void,
  ): void {
    this.markWatchOverflowById(localWatchId);
    resolve({ batch: { kind: "overflow", events: [] }, release() {}, rollback() {} });
  }

  private handleObservedHostFailed(
    msg: Extract<ControlMessage, { kind: "host-failed" }> | { message?: string },
  ): void {
    const reason = msg.message || "host storage terminally failed";
    this.peerObservedHostFailed = reason;
    for (const [reqId, rpc] of Array.from(this.peerInFlightRpcs)) {
      this.peerInFlightRpcs.delete(reqId);
      if (rpc.isWatchRead) {
        this.resolveWatchOverflow(rpc.localWatchId, rpc.resolve);
      } else {
        rpc.reject(new FilesystemError(29, reason));
      }
    }
    const drainQueue = (queue: QueuedPeerOp[]) => {
      for (const op of queue.splice(0)) {
        if (op.isWatchRead) {
          this.resolveWatchOverflow(op.localWatchId, op.resolve);
        } else {
          op.reject(new FilesystemError(29, reason));
        }
      }
    };
    drainQueue(this.peerRetryQueue);
    drainQueue(this.peerFailoverQueue);
    this.wakePeerCreditWaiters();
    this.notifyFailoverReadyWaiters();
    this.markLocalWatchesOverflow();
  }

  // ---------------------------------------------------------------------------
  // Host-Side Peer Management, Credits, & RPC Execution
  // ---------------------------------------------------------------------------

  private slotCreditLimit(slot: PeerCreditSlot): PeerCreditLimit {
    return {
      frames: Math.max(0, slot.reservedFrames - slot.retiredInFlightFrames),
      bytes: Math.max(0, slot.reservedBytes - slot.retiredInFlightBytes),
    };
  }

  private sendPeerFrame(
    peerId: string,
    channel: BroadcastChannelLike,
    message: PeerMessage,
  ): boolean {
    if (this.hooks.onPeerSend?.(peerId, message) === false) return true;
    try {
      channel.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  private handleHostAttachRequest(peerId: string, sessionId: string): void {
    const termStr = formatTerm(this.hostTerm);
    const existing = this.hostPeers.get(peerId);

    // Idempotent retry for exact same active sessionId!
    if (existing && !existing.revoked && existing.sessionId === sessionId) {
      existing.lastActivityAt = Date.now();
      const slot = this.hostCreditSlots.get(peerId);
      if (!slot || slot.deferredAttach?.sessionId === sessionId) return;
      this.sendPeerFrame(peerId, existing.channel, {
        kind: "attached",
        hostTerm: termStr,
        sessionId,
        creditLimit: this.slotCreditLimit(slot),
      });
      return;
    }

    // Revoke any previous session synchronously (moving activeInFlight -> retiredInFlight)!
    if (existing) {
      this.revokeHostPeerSessionForReset(existing);
    }

    let slot = this.hostCreditSlots.get(peerId);
    const channel = this.createChannel(peerChannelName(this.scope, this.hostTerm, peerId));

    if (!slot) {
      // Brand-new peer: must be able to grant at least (MIN_PEER_FRAMES, MIN_PEER_BYTES)
      if (
        this.hostAvailableFrames < MIN_PEER_FRAMES ||
        this.hostAvailableWireBytes < MIN_PEER_BYTES
      ) {
        this.sendPeerFrame(peerId, channel, {
          kind: "attach-rejected",
          hostTerm: termStr,
          sessionId,
          errno: 6,
          message: "host peer capacity exhausted",
        });
        channel.close();
        return;
      }
      const frames = Math.min(DEFAULT_PEER_FRAMES, this.hostAvailableFrames);
      const bytes = Math.min(DEFAULT_PEER_BYTES, this.hostAvailableWireBytes);
      this.hostAvailableFrames -= frames;
      this.hostAvailableWireBytes -= bytes;
      slot = {
        peerId,
        reservedFrames: frames,
        reservedBytes: bytes,
        activeInFlightFrames: 0,
        activeInFlightBytes: 0,
        retiredInFlightFrames: 0,
        retiredInFlightBytes: 0,
        pendingDetach: false,
      };
      this.hostCreditSlots.set(peerId, slot);
    } else if (slot.pendingDetach) {
      // Reattach while pendingDetach === true (§4.2)!
      const limit = this.slotCreditLimit(slot);
      const needFrames = Math.max(0, MIN_PEER_FRAMES - limit.frames);
      const needBytes = Math.max(0, MIN_PEER_BYTES - limit.bytes);
      if (this.hostAvailableFrames >= needFrames && this.hostAvailableWireBytes >= needBytes) {
        slot.pendingDetach = false;
        this.hostAvailableFrames -= needFrames;
        this.hostAvailableWireBytes -= needBytes;
        slot.reservedFrames += needFrames;
        slot.reservedBytes += needBytes;
      } else if (slot.reservedFrames >= MIN_PEER_FRAMES && slot.reservedBytes >= MIN_PEER_BYTES) {
        slot.pendingDetach = false;
        slot.deferredAttach = { sessionId, hostTerm: this.hostTerm };
      } else {
        // Leave pendingDetach = true so S1's bytes return to global pool on settlement!
        this.sendPeerFrame(peerId, channel, {
          kind: "attach-rejected",
          hostTerm: termStr,
          sessionId,
          errno: 6,
          message: "host peer capacity exhausted",
        });
        channel.close();
        return;
      }
    } else {
      // Session reset while !pendingDetach: keep reserved* pinned; defer if temporarily below minimum!
      const limit = this.slotCreditLimit(slot);
      if (limit.frames < MIN_PEER_FRAMES || limit.bytes < MIN_PEER_BYTES) {
        slot.deferredAttach = { sessionId, hostTerm: this.hostTerm };
      }
    }

    const session: HostPeerSession = {
      peerId,
      sessionId,
      hostTerm: this.hostTerm,
      ownerId: this.nextHostPeerOwner++,
      channel,
      pins: new Map(),
      activeReqs: new Set(),
      uploads: new Map(),
      downloads: new Map(),
      heldWatches: new Map(),
      watchIds: new Set(),
      pendingSettledUnpins: [],
      pendingSettledWatchAcks: [],
      pendingSettledWatchCloses: [],
      pendingSettledUploadAborts: [],
      latestWakeSeq: 0,
      wakeDirty: false,
      lastActivityAt: Date.now(),
      peerAliveAbort: new AbortController(),
      revoked: false,
    };

    this.hostPeers.set(peerId, session);

    channel.onmessage = (event) => {
      if (!isPeerMessage(event.data)) return;
      this.onHostReceivePeerMessage(session, event.data);
    };
    channel.onmessageerror = () => {
      this.detachHostPeer(peerId);
    };

    watchLockRelease(
      this.locks,
      peerAliveLockName(this.scope, peerId),
      session.peerAliveAbort.signal,
      () => {
        if (this.hostPeers.get(peerId) === session) {
          this.detachHostPeer(peerId);
        }
      },
    );

    if (!slot.deferredAttach) {
      this.sendPeerFrame(peerId, channel, {
        kind: "attached",
        hostTerm: termStr,
        sessionId,
        creditLimit: this.slotCreditLimit(slot),
      });
    }
  }

  private revokeHostPeerSessionForReset(session: HostPeerSession): void {
    session.revoked = true;
    session.peerAliveAbort.abort();
    if (session.settledFlushTimer) {
      clearTimeout(session.settledFlushTimer);
      session.settledFlushTimer = undefined;
    }
    const slot = this.hostCreditSlots.get(session.peerId);
    if (slot) {
      slot.retiredInFlightFrames += slot.activeInFlightFrames;
      slot.retiredInFlightBytes += slot.activeInFlightBytes;
      slot.activeInFlightFrames = 0;
      slot.activeInFlightBytes = 0;
      slot.deferredAttach = undefined;
    }
    this.reclaimHostPeerSessionResources(session);
    session.channel.close();
  }

  private detachHostPeer(peerId: string): void {
    const session = this.hostPeers.get(peerId);
    if (session) {
      this.hostPeers.delete(peerId);
      session.revoked = true;
      session.peerAliveAbort.abort();
      if (session.settledFlushTimer) {
        clearTimeout(session.settledFlushTimer);
        session.settledFlushTimer = undefined;
      }
      this.reclaimHostPeerSessionResources(session);
      session.channel.close();
    }
    const slot = this.hostCreditSlots.get(peerId);
    if (!slot) return;
    slot.retiredInFlightFrames += slot.activeInFlightFrames;
    slot.retiredInFlightBytes += slot.activeInFlightBytes;
    slot.activeInFlightFrames = 0;
    slot.activeInFlightBytes = 0;
    slot.pendingDetach = true;
    slot.deferredAttach = undefined;

    const availFrames = Math.max(0, slot.reservedFrames - slot.retiredInFlightFrames);
    const availBytes = Math.max(0, slot.reservedBytes - slot.retiredInFlightBytes);
    slot.reservedFrames -= availFrames;
    slot.reservedBytes -= availBytes;
    this.hostAvailableFrames += availFrames;
    this.hostAvailableWireBytes += availBytes;

    if (
      slot.reservedFrames === 0 &&
      slot.reservedBytes === 0 &&
      slot.retiredInFlightFrames === 0 &&
      slot.retiredInFlightBytes === 0
    ) {
      this.hostCreditSlots.delete(peerId);
    }
  }

  private closeAllHostPeerSessions(): void {
    for (const peerId of Array.from(this.hostPeers.keys())) {
      this.detachHostPeer(peerId);
    }
  }

  private reclaimHostPeerSessionResources(session: HostPeerSession): void {
    for (const [, handle] of session.pins) {
      this.persistent?.release(handle);
    }
    session.pins.clear();

    for (const upload of session.uploads.values()) {
      this.hostUsedUploadBytes = Math.max(0, this.hostUsedUploadBytes - upload.totalBytes);
    }
    session.uploads.clear();

    for (const dl of session.downloads.values()) {
      this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - dl.reservedBytes);
    }
    session.downloads.clear();

    for (const { held } of session.heldWatches.values()) {
      held.rollback();
    }
    session.heldWatches.clear();

    if (session.watchIds.size) {
      this.watchService?.closeOwner(session.ownerId);
      session.watchIds.clear();
    }
  }

  private settleHostInFlightCredit(session: HostPeerSession, frames: number, bytes: number): void {
    const slot = this.hostCreditSlots.get(session.peerId);
    if (!slot) return;
    if (session.revoked) {
      slot.retiredInFlightFrames = Math.max(0, slot.retiredInFlightFrames - frames);
      slot.retiredInFlightBytes = Math.max(0, slot.retiredInFlightBytes - bytes);
      if (slot.pendingDetach) {
        slot.reservedFrames = Math.max(0, slot.reservedFrames - frames);
        slot.reservedBytes = Math.max(0, slot.reservedBytes - bytes);
        this.hostAvailableFrames += frames;
        this.hostAvailableWireBytes += bytes;
        if (
          slot.reservedFrames === 0 &&
          slot.reservedBytes === 0 &&
          slot.activeInFlightFrames === 0 &&
          slot.retiredInFlightFrames === 0
        ) {
          this.hostCreditSlots.delete(session.peerId);
        }
        return;
      }
      const active = this.hostPeers.get(session.peerId);
      if (!active || active.revoked) return;
      const limit = this.slotCreditLimit(slot);
      if (slot.deferredAttach && slot.deferredAttach.sessionId === active.sessionId) {
        if (limit.frames >= MIN_PEER_FRAMES && limit.bytes >= MIN_PEER_BYTES) {
          slot.deferredAttach = undefined;
          this.sendPeerFrame(active.peerId, active.channel, {
            kind: "attached",
            hostTerm: formatTerm(active.hostTerm),
            sessionId: active.sessionId,
            creditLimit: limit,
          });
        }
      } else {
        this.sendPeerFrame(active.peerId, active.channel, {
          kind: "credit-limit",
          hostTerm: formatTerm(active.hostTerm),
          sessionId: active.sessionId,
          creditLimit: limit,
        });
      }
      return;
    }
    slot.activeInFlightFrames = Math.max(0, slot.activeInFlightFrames - frames);
    slot.activeInFlightBytes = Math.max(0, slot.activeInFlightBytes - bytes);
  }

  private hostHealthState(): HostHealthState {
    if (this.terminalFailure || this.phase === "failed" || this.persistent?.isTerminallyFailed())
      return "failed";
    if (this.steppingDown || this.disposing || this.phase === "retiring") return "draining";
    return "ready";
  }

  private onHostReceivePeerMessage(session: HostPeerSession, msg: PeerMessage): void {
    if (session.revoked) return;
    if (msg.sessionId !== session.sessionId || msg.hostTerm !== formatTerm(session.hostTerm))
      return;
    session.lastActivityAt = Date.now();

    switch (msg.kind) {
      case "detach":
        this.detachHostPeer(session.peerId);
        return;

      case "unpin":
        this.hostProcessUnpin(session, msg.pinToken);
        return;

      case "watch-ack":
        this.hostProcessWatchAck(session, msg.ackId, msg.accepted);
        return;

      case "watch-close":
        this.hostProcessWatchClose(session, msg.hostWatchId);
        return;

      case "watch-wake-ack":
        if (session.wakeInFlightSeq !== undefined && msg.wakeSeq >= session.wakeInFlightSeq) {
          session.wakeInFlightSeq = undefined;
          if (session.wakeDirty) this.scheduleHostWatchWake(session);
        }
        return;

      case "ping": {
        // Reconcile watch-wake acks
        if (
          session.wakeInFlightSeq !== undefined &&
          msg.latestAckedWakeSeq >= session.wakeInFlightSeq
        ) {
          session.wakeInFlightSeq = undefined;
          if (session.wakeDirty) this.scheduleHostWatchWake(session);
        }
        // Idempotently process piggybacked pending settlements & confirm in pong
        const settledUnpins: number[] = [];
        const settledWatchAcks: number[] = [];
        const settledWatchCloses: number[] = [];
        const settledUploadAborts: string[] = [];
        for (const token of msg.pendingUnpins ?? []) {
          this.hostProcessUnpin(session, token, false);
          settledUnpins.push(token);
        }
        for (const [ackId, accepted] of msg.pendingWatchAcks ?? []) {
          this.hostProcessWatchAck(session, ackId, accepted, false);
          settledWatchAcks.push(ackId);
        }
        for (const watchId of msg.pendingWatchCloses ?? []) {
          this.hostProcessWatchClose(session, watchId, false);
          settledWatchCloses.push(watchId);
        }
        for (const uploadId of msg.pendingUploadAborts ?? []) {
          this.hostProcessUploadAbort(session, uploadId, false);
          settledUploadAborts.push(uploadId);
        }
        const slot = this.hostCreditSlots.get(session.peerId);
        const creditLimit = slot
          ? this.slotCreditLimit(slot)
          : { frames: MIN_PEER_FRAMES, bytes: MIN_PEER_BYTES };
        this.sendPeerFrame(session.peerId, session.channel, {
          kind: "pong",
          hostTerm: formatTerm(session.hostTerm),
          sessionId: session.sessionId,
          pingId: msg.pingId,
          activeReqIds: Array.from(session.activeReqs),
          latestWakeSeq: session.latestWakeSeq,
          ...(settledUnpins.length ? { settledUnpins } : {}),
          ...(settledWatchAcks.length ? { settledWatchAcks } : {}),
          ...(settledWatchCloses.length ? { settledWatchCloses } : {}),
          ...(settledUploadAborts.length ? { settledUploadAborts } : {}),
          creditLimit,
          hostState: this.hostHealthState(),
        });
        return;
      }

      case "chunk-put": {
        this.handleHostChunkPut(session, msg);
        return;
      }

      case "chunk-abort": {
        this.hostProcessUploadAbort(session, msg.uploadId, true);
        return;
      }

      case "chunk-get": {
        void this.handleHostChunkGet(session, msg);
        return;
      }

      case "req": {
        void this.handleHostPeerReq(session, msg);
        return;
      }
    }
  }

  private hostProcessUnpin(session: HostPeerSession, pinToken: number, batch = true): void {
    const handle = session.pins.get(pinToken);
    if (handle !== undefined) {
      session.pins.delete(pinToken);
      this.persistent?.release(handle);
    }
    if (batch) {
      session.pendingSettledUnpins.push(pinToken);
      this.maybeScheduleHostSettledFlush(session);
    }
  }

  private hostProcessWatchAck(
    session: HostPeerSession,
    ackId: number,
    accepted: boolean,
    batch = true,
  ): void {
    const entry = session.heldWatches.get(ackId);
    if (entry) {
      session.heldWatches.delete(ackId);
      if (accepted) {
        entry.held.release();
      } else {
        entry.held.rollback();
        // Wake re-arm on rollback (§8.3.3)!
        this.scheduleHostWatchWake(session);
      }
    }
    if (batch) {
      session.pendingSettledWatchAcks.push(ackId);
      this.maybeScheduleHostSettledFlush(session);
    }
  }

  private hostProcessWatchClose(session: HostPeerSession, hostWatchId: number, batch = true): void {
    if (session.watchIds.delete(hostWatchId)) {
      this.watchService?.close(session.ownerId, hostWatchId);
    }
    if (batch) {
      session.pendingSettledWatchCloses.push(hostWatchId);
      this.maybeScheduleHostSettledFlush(session);
    }
  }

  private hostProcessUploadAbort(session: HostPeerSession, uploadId: string, batch = true): void {
    this.discardHostStagedUpload(session, uploadId);
    if (batch) {
      session.pendingSettledUploadAborts.push(uploadId);
      this.maybeScheduleHostSettledFlush(session);
    }
  }

  private maybeScheduleHostSettledFlush(session: HostPeerSession): void {
    const total =
      session.pendingSettledUnpins.length +
      session.pendingSettledWatchAcks.length +
      session.pendingSettledWatchCloses.length +
      session.pendingSettledUploadAborts.length;
    if (total >= SETTLEMENT_BATCH_SIZE) {
      this.flushHostSettled(session);
      return;
    }
    if (!session.settledFlushTimer) {
      session.settledFlushTimer = setTimeout(() => {
        session.settledFlushTimer = undefined;
        this.flushHostSettled(session);
      }, 0);
    }
  }

  private flushHostSettled(session: HostPeerSession): void {
    if (session.settledFlushTimer) {
      clearTimeout(session.settledFlushTimer);
      session.settledFlushTimer = undefined;
    }
    if (session.revoked) return;
    if (
      !session.pendingSettledUnpins.length &&
      !session.pendingSettledWatchAcks.length &&
      !session.pendingSettledWatchCloses.length &&
      !session.pendingSettledUploadAborts.length
    )
      return;
    const unpins = session.pendingSettledUnpins.splice(0);
    const watchAcks = session.pendingSettledWatchAcks.splice(0);
    const watchCloses = session.pendingSettledWatchCloses.splice(0);
    const uploadAborts = session.pendingSettledUploadAborts.splice(0);
    this.sendPeerFrame(session.peerId, session.channel, {
      kind: "settled",
      hostTerm: formatTerm(session.hostTerm),
      sessionId: session.sessionId,
      ...(unpins.length ? { unpins } : {}),
      ...(watchAcks.length ? { watchAcks } : {}),
      ...(watchCloses.length ? { watchCloses } : {}),
      ...(uploadAborts.length ? { uploadAborts } : {}),
    });
  }

  private scheduleHostWatchWake(session: HostPeerSession): void {
    if (session.revoked || !session.watchIds.size) return;
    if (session.wakeInFlightSeq !== undefined) {
      session.wakeDirty = true;
      return;
    }
    session.latestWakeSeq++;
    session.wakeInFlightSeq = session.latestWakeSeq;
    session.wakeDirty = false;
    this.sendPeerFrame(session.peerId, session.channel, {
      kind: "watch-wake",
      hostTerm: formatTerm(session.hostTerm),
      sessionId: session.sessionId,
      wakeSeq: session.latestWakeSeq,
    });
  }

  private notifyAllPeerWatchers(): void {
    for (const session of this.hostPeers.values()) {
      if (!session.revoked && session.watchIds.size) {
        this.scheduleHostWatchWake(session);
      }
    }
  }

  private handleHostChunkPut(
    session: HostPeerSession,
    msg: Extract<PeerMessage, { kind: "chunk-put" }>,
  ): void {
    const payloadBytes = msg.chunk.byteLength;
    const slot = this.hostCreditSlots.get(session.peerId);
    if (slot) {
      slot.activeInFlightFrames += 1;
      slot.activeInFlightBytes += payloadBytes;
    }
    session.activeReqs.add(msg.reqId);
    let ok = true;
    let errNo: number | undefined;
    let errMsg: string | undefined;
    let retry: true | undefined;

    try {
      const outcome = this.applyHostChunkPut(session, msg);
      ok = outcome.ok;
      errNo = outcome.errNo;
      errMsg = outcome.errMsg;
      retry = outcome.retry;
    } finally {
      session.activeReqs.delete(msg.reqId);
      this.settleHostInFlightCredit(session, 1, payloadBytes);
      if (!session.revoked) {
        this.sendPeerFrame(session.peerId, session.channel, {
          kind: "res",
          hostTerm: formatTerm(session.hostTerm),
          sessionId: session.sessionId,
          reqId: msg.reqId,
          ok,
          ...(retry ? { retry } : {}),
          ...(errNo !== undefined ? { errno: errNo, message: errMsg } : {}),
          creditFrames: 1,
          creditBytes: payloadBytes,
        });
      }
    }
  }

  private discardHostStagedUpload(session: HostPeerSession, uploadId: string): void {
    const existing = session.uploads.get(uploadId);
    if (!existing) return;
    session.uploads.delete(uploadId);
    this.hostUsedUploadBytes = Math.max(0, this.hostUsedUploadBytes - existing.totalBytes);
  }

  private applyHostChunkPut(
    session: HostPeerSession,
    msg: Extract<PeerMessage, { kind: "chunk-put" }>,
  ): { ok: boolean; errNo?: number; errMsg?: string; retry?: true } {
    if (this.terminalFailure || this.persistent?.isTerminallyFailed()) {
      this.discardHostStagedUpload(session, msg.uploadId);
      return { ok: false, errNo: 29, errMsg: "host terminally failed" };
    }
    if (this.steppingDown) {
      this.discardHostStagedUpload(session, msg.uploadId);
      return { ok: false, retry: true };
    }
    if (msg.totalBytes > MAX_STAGED_UPLOAD_BYTES || msg.totalBytes < 0) {
      this.discardHostStagedUpload(session, msg.uploadId);
      return { ok: false, errNo: 22, errMsg: "upload exceeds 32 MiB cap" };
    }
    let upload = session.uploads.get(msg.uploadId);
    if (!upload) {
      if (
        session.uploads.size >= MAX_CONCURRENT_UPLOADS_PER_PEER ||
        this.hostUsedUploadBytes + msg.totalBytes > MAX_STAGED_UPLOAD_BYTES
      ) {
        return { ok: false, errNo: 6, errMsg: "staged upload pool exhausted" };
      }
      this.hostUsedUploadBytes += msg.totalBytes;
      upload = {
        uploadId: msg.uploadId,
        totalBytes: msg.totalBytes,
        buffer: new Uint8Array(msg.totalBytes),
        receivedBytes: 0,
      };
      session.uploads.set(msg.uploadId, upload);
    }
    if (
      msg.totalBytes !== upload.totalBytes ||
      msg.offset !== upload.receivedBytes ||
      msg.offset + msg.chunk.byteLength > upload.totalBytes
    ) {
      this.discardHostStagedUpload(session, msg.uploadId);
      return { ok: false, errNo: 28, errMsg: "invalid upload chunk bounds" };
    }
    upload.buffer.set(msg.chunk, msg.offset);
    upload.receivedBytes += msg.chunk.byteLength;
    return { ok: true };
  }

  private validateChunkGetState(
    session: HostPeerSession,
    admittedTerm: bigint,
    replyErr: (errno: number, message?: string) => void,
    requireLease: boolean,
  ): boolean {
    if (session.revoked) return false;
    if (this.terminalFailure || this.persistent?.isTerminallyFailed()) {
      replyErr(29, "host storage terminally failed");
      return false;
    }
    if (this.ownershipLost || this.role !== "host" || this.hostTerm !== admittedTerm) {
      replyErr(11, "host term ended");
      return false;
    }
    if (requireLease && !this.isLeaseValid()) {
      replyErr(11, "host lease expired");
      return false;
    }
    return true;
  }

  private async handleHostChunkGet(
    session: HostPeerSession,
    msg: Extract<PeerMessage, { kind: "chunk-get" }>,
  ): Promise<void> {
    const slot = this.hostCreditSlots.get(session.peerId);
    if (slot) {
      slot.activeInFlightFrames += 1;
    }
    session.activeReqs.add(msg.reqId);
    const admittedTerm = session.hostTerm;
    const reclaimDownload = () => {
      const existing = session.downloads.get(msg.downloadId);
      if (existing && session.downloads.delete(msg.downloadId)) {
        this.hostUsedDownloadBytes = Math.max(
          0,
          this.hostUsedDownloadBytes - existing.reservedBytes,
        );
      }
    };
    const replyErr = (errno: number, message?: string) => {
      reclaimDownload();
      if (session.revoked) return;
      this.sendPeerFrame(session.peerId, session.channel, {
        kind: "res",
        hostTerm: formatTerm(admittedTerm),
        sessionId: session.sessionId,
        reqId: msg.reqId,
        ok: false,
        errno,
        ...(message ? { message } : {}),
        creditFrames: 1,
        creditBytes: 0,
      });
    };
    try {
      if (!this.validateChunkGetState(session, admittedTerm, replyErr, false)) return;
      if (!this.isLeaseValid()) {
        await this.renewLeaseNow(this.currentAttemptId);
        if (!this.validateChunkGetState(session, admittedTerm, replyErr, true)) return;
      }

      this.enterHostAdmitted();
      try {
        const dl = session.downloads.get(msg.downloadId);
        if (!dl) {
          replyErr(11);
          return;
        }
        if (msg.offset < 0 || msg.offset >= dl.bytes.byteLength || msg.length <= 0) {
          replyErr(28);
          return;
        }
        const end = Math.min(
          dl.bytes.byteLength,
          msg.offset + Math.min(msg.length, MAX_FRAME_BYTES),
        );
        const slice = unsharedBytes(dl.bytes.subarray(msg.offset, end));
        await this.hooks.beforeHostReplyPublish?.("chunk-get", msg.reqId);
        // Revalidate lease, term, and terminal state immediately before settling & publishing!
        if (!this.validateChunkGetState(session, admittedTerm, replyErr, true)) return;
        if (end >= dl.bytes.byteLength) {
          reclaimDownload();
        }
        this.sendPeerFrame(session.peerId, session.channel, {
          kind: "res",
          hostTerm: formatTerm(admittedTerm),
          sessionId: session.sessionId,
          reqId: msg.reqId,
          ok: true,
          data: slice,
          binary: true,
          creditFrames: 1,
          creditBytes: 0,
        });
      } finally {
        this.leaveHostAdmitted();
      }
    } finally {
      session.activeReqs.delete(msg.reqId);
      this.settleHostInFlightCredit(session, 1, 0);
    }
  }

  private async handleHostPeerReq(
    session: HostPeerSession,
    msg: Extract<PeerMessage, { kind: "req" }>,
  ): Promise<void> {
    const payloadBytes = msg.data?.byteLength ?? 0;
    const slot = this.hostCreditSlots.get(session.peerId);
    if (slot) {
      slot.activeInFlightFrames += 1;
      slot.activeInFlightBytes += payloadBytes;
    }
    session.activeReqs.add(msg.reqId);
    const admittedTerm = session.hostTerm;

    const reply = (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => {
      if (session.revoked) return;
      this.sendPeerFrame(session.peerId, session.channel, {
        kind: "res",
        hostTerm: formatTerm(admittedTerm),
        sessionId: session.sessionId,
        reqId: msg.reqId,
        ...partial,
        creditFrames: 1,
        creditBytes: payloadBytes,
      });
    };

    try {
      // Terminal failure gate FIRST!
      if (this.terminalFailure || this.persistent?.isTerminallyFailed()) {
        reply({ ok: false, errno: 29, message: "host storage terminally failed" });
        return;
      }
      if (this.ownershipLost || this.role !== "host" || this.hostTerm !== admittedTerm) {
        reply({ ok: false, errno: 11, message: "host term ended" });
        return;
      }

      // Stepping-down gate: side-effect-free { retry: true } for non-watchRead ops (allowed even if lease expired!).
      if (this.steppingDown && msg.op !== "watchRead") {
        reply({ ok: false, retry: true });
        return;
      }

      // Lease check at admission!
      if (!this.isLeaseValid()) {
        const renewed = await this.renewLeaseNow(this.currentAttemptId);
        if (session.revoked) return;
        if (this.terminalFailure || this.persistent?.isTerminallyFailed()) {
          reply({ ok: false, errno: 29, message: "host storage terminally failed" });
          return;
        }
        if (this.steppingDown && msg.op !== "watchRead") {
          reply({ ok: false, retry: true });
          return;
        }
        if (!renewed || !this.isLeaseValid() || this.hostTerm !== admittedTerm) {
          reply({ ok: false, errno: 11, message: "host lease expired" });
          return;
        }
      }

      this.enterHostAdmitted();
      try {
        await this.executePeerRpcOnHost(session, admittedTerm, msg, reply);
      } finally {
        this.leaveHostAdmitted();
      }
    } catch (error) {
      if (!session.revoked) {
        reply({
          ok: false,
          errno: errorToErrno(error),
          message: describeReason(error),
        });
      }
    } finally {
      if (msg.uploadId) this.discardHostStagedUpload(session, msg.uploadId);
      session.activeReqs.delete(msg.reqId);
      this.settleHostInFlightCredit(session, 1, payloadBytes);
    }
  }

  private assertHostOpStillValid(session: HostPeerSession, admittedTerm: bigint): void {
    if (session.revoked) throw new FilesystemError(11, "peer session revoked");
    if (this.terminalFailure || this.persistent?.isTerminallyFailed())
      throw new FilesystemError(29, "host storage terminally failed");
    if (
      this.ownershipLost ||
      this.role !== "host" ||
      this.hostTerm !== admittedTerm ||
      !this.isLeaseValid() ||
      !this.persistent
    )
      throw new FilesystemError(11, "host lease invalid");
  }

  private async executePeerRpcOnHost(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    if (msg.op === "__rebind") {
      await this.handleHostPeerRebind(session, admittedTerm, msg, reply);
      return;
    }
    if (msg.op === "watchOpen") {
      await this.handleHostPeerWatchOpen(session, admittedTerm, msg, reply);
      return;
    }
    if (msg.op === "watchRead") {
      await this.handleHostPeerWatchRead(session, admittedTerm, msg, reply);
      return;
    }

    const { data, reservedUploadBytes } = this.consumeHostStagedUpload(session, msg);
    try {
      if (msg.op === "readFile") {
        await this.handleHostPeerReadFile(
          session,
          admittedTerm,
          msg.args[0] as string,
          msg.reqId,
          reply,
        );
        return;
      }
      if (msg.op === "readdir" || msg.op === "lookup" || msg.op === "listFiles") {
        await this.handleHostPeerBoundedWireRead(
          session,
          admittedTerm,
          msg.op,
          msg.args,
          msg.reqId,
          reply,
        );
        return;
      }
      if (msg.op === "readdirPage") {
        await this.handleHostPeerReaddirPage(session, admittedTerm, msg, reply);
        return;
      }
      if (msg.op === "flush" || msg.op === "sync") {
        const target =
          msg.op === "sync" ? (msg.args[0] as number) : (msg.args[0] as string | undefined);
        await this.barrier.runBarrier(async () => {
          await this.hostQueue;
          this.assertHostOpStillValid(session, admittedTerm);
          await this.persistent!.flush(target);
        });
        await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
        this.assertHostOpStillValid(session, admittedTerm);
        reply({ ok: true, value: msg.op === "sync" ? 0 : undefined });
        return;
      }
      if (msg.op === "read") {
        await this.handleHostPeerRead(session, admittedTerm, msg, reply);
        return;
      }

      await this.handleHostPeerGeneral(session, admittedTerm, msg, data, reply);
    } finally {
      if (reservedUploadBytes > 0) {
        this.hostUsedUploadBytes = Math.max(0, this.hostUsedUploadBytes - reservedUploadBytes);
      }
    }
  }

  private consumeHostStagedUpload(
    session: HostPeerSession,
    msg: Extract<PeerMessage, { kind: "req" }>,
  ): { data: Uint8Array; reservedUploadBytes: number } {
    if (!msg.uploadId) return { data: msg.data ?? new Uint8Array(), reservedUploadBytes: 0 };
    const upload = session.uploads.get(msg.uploadId);
    if (!upload || upload.receivedBytes !== upload.totalBytes) {
      this.discardHostStagedUpload(session, msg.uploadId);
      throw new FilesystemError(28, "incomplete staged upload");
    }
    session.uploads.delete(msg.uploadId);
    return { data: upload.buffer, reservedUploadBytes: upload.totalBytes };
  }

  private async handleHostPeerRebind(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    const fileIds = msg.args[0] as bigint[];
    const bound: (WirePinnedHandle | null)[] = [];
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      for (const fileId of fileIds) {
        const node = persistent.nodeByFileId(fileId);
        if (!node) {
          bound.push(null);
          continue;
        }
        const remoteHandle = persistent.fs.handleForNode(node);
        bound.push(this.mintHostPeerPin(session, remoteHandle, fileId));
      }
    });
    await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
    this.assertHostOpStillValid(session, admittedTerm);
    reply({ ok: true, value: bound });
  }

  private async handleHostPeerWatchOpen(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    const [remoteHandle, recursive] = msg.args as [number, boolean];
    let hostWatchId = 0;
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      this.watchService ??= new WatchService(persistent);
      hostWatchId = this.watchService.open(
        session.ownerId,
        remoteHandle,
        recursive,
        () => session.revoked || this.hostTerm !== admittedTerm || !this.isLeaseValid(),
      );
      session.watchIds.add(hostWatchId);
    });
    await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
    if (
      session.revoked ||
      this.terminalFailure ||
      !this.isLeaseValid() ||
      this.hostTerm !== admittedTerm
    ) {
      if (session.watchIds.delete(hostWatchId)) {
        this.watchService?.close(session.ownerId, hostWatchId);
      }
      this.assertHostOpStillValid(session, admittedTerm);
    }
    reply({ ok: true, value: hostWatchId });
  }

  private rollbackHeldWatchAck(session: HostPeerSession, ackId: number | undefined): void {
    if (ackId === undefined) return;
    const entry = session.heldWatches.get(ackId);
    if (!entry) return;
    session.heldWatches.delete(ackId);
    entry.held.rollback();
    this.scheduleHostWatchWake(session);
  }

  private async handleHostPeerWatchRead(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const [hostWatchId] = msg.args as [number];
    let held: HeldWatchBatch | undefined;
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      if (!this.watchService || !session.watchIds.has(hostWatchId)) throw new FilesystemError(8);
      held = this.watchService.readHeld(session.ownerId, hostWatchId);
    });
    await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
    if (
      !held ||
      session.revoked ||
      this.terminalFailure ||
      !this.isLeaseValid() ||
      this.hostTerm !== admittedTerm
    ) {
      held?.rollback();
      this.assertHostOpStillValid(session, admittedTerm);
      return;
    }
    const batch = held.batch;
    const encoded = pack(batch);
    let ackId: number | undefined;
    if (batch.events.length > 0) {
      ackId = this.nextWatchAckId++;
      session.heldWatches.set(ackId, { held, hostWatchId });
    } else {
      held.release();
    }
    if (encoded.byteLength <= MAX_FRAME_BYTES) {
      reply({ ok: true, value: batch, ...(ackId !== undefined ? { ackId } : {}) });
      return;
    }
    const staged = this.stageHostDownload(session, encoded, 0, ackId);
    if (!staged) {
      this.rollbackHeldWatchAck(session, ackId);
      throw new FilesystemError(6, "staged download pool exhausted");
    }
    reply({
      ok: true,
      packed: true,
      ...(ackId !== undefined ? { ackId } : {}),
      chunkedId: staged.downloadId,
      totalBytes: encoded.byteLength,
      firstChunk: staged.firstChunk,
    });
  }

  private async handleHostPeerReaddirPage(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    const [remoteHandle, rawCookie, byteLength] = msg.args as [number, bigint, number];
    const tag = msg.responseCookieTag ? parseTerm(msg.responseCookieTag) : undefined;
    let bytes!: Uint8Array;
    let reserved = 0;
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      const remaining = Math.max(0, MAX_STAGED_DOWNLOAD_BYTES - this.hostUsedDownloadBytes);
      bytes = persistent.fs.readdirPage(
        remoteHandle,
        rawCookie,
        byteLength,
        tag,
        remaining,
        MAX_STAGED_DOWNLOAD_BYTES,
      );
      if (bytes.byteLength > MAX_FRAME_BYTES) {
        if (
          session.downloads.size >= MAX_CONCURRENT_DOWNLOADS_PER_PEER ||
          this.hostUsedDownloadBytes + bytes.byteLength > MAX_STAGED_DOWNLOAD_BYTES
        ) {
          throw new FilesystemError(6, "staged download pool exhausted");
        }
        reserved = bytes.byteLength;
        this.hostUsedDownloadBytes += reserved;
      }
    });
    try {
      await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
      this.assertHostOpStillValid(session, admittedTerm);
      const transferReserved = reserved;
      reserved = 0;
      this.replyWithBytes(session, bytes, transferReserved, true, false, reply);
    } catch (error) {
      if (reserved > 0) {
        this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - reserved);
      }
      throw error;
    }
  }

  private async handleHostPeerRead(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    const [remoteHandle, length, offset] = msg.args as [number, number, number];
    for (;;) {
      this.assertHostOpStillValid(session, admittedTerm);
      const startVer = this.readVersion();
      const prep = persistent.prepareDescriptorRead(
        remoteHandle,
        offset,
        length,
        () => session.revoked || this.hostTerm !== admittedTerm || !this.isLeaseValid(),
      );
      if (prep) {
        const accepted = await this.revalidateColdReadBytes(prep, startVer, () =>
          this.assertHostOpStillValid(session, admittedTerm),
        );
        if (accepted === undefined) continue;
        await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
        this.assertHostOpStillValid(session, admittedTerm);
        reply({ ok: true, data: unsharedBytes(accepted), binary: true });
        return;
      }
      let readBytes!: Uint8Array;
      await this.enqueueHostSerial(() => {
        this.assertHostOpStillValid(session, admittedTerm);
        readBytes = persistent.execute(
          "read",
          [remoteHandle, length, offset],
          new Uint8Array(),
        ) as Uint8Array;
      });
      await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
      this.assertHostOpStillValid(session, admittedTerm);
      reply({ ok: true, data: unsharedBytes(readBytes), binary: true });
      return;
    }
  }

  private async revalidateColdReadBytes(
    prep: Promise<Uint8Array>,
    startVer: string,
    assertValid: () => void,
  ): Promise<Uint8Array | undefined> {
    const coldBytes = await prep;
    let accepted: Uint8Array | undefined;
    await this.enqueueHostSerial(() => {
      assertValid();
      if (this.readVersion() === startVer) {
        accepted = coldBytes;
      }
    });
    return accepted;
  }

  private wrapHostPeerResult(
    session: HostPeerSession,
    persistent: PersistentBackend,
    op: string,
    result: unknown,
  ): { wireValue: unknown; mintedTokens: number[] } {
    const mintedTokens: number[] = [];
    if (op === "preopen" || (op === "create" && typeof result === "number")) {
      const remoteHandle = result as number;
      const node = persistent.fs.nodeForHandle(remoteHandle);
      const fileId = persistent.ensureIdentity(node).id;
      const pinned = this.mintHostPeerPin(session, remoteHandle, fileId);
      mintedTokens.push(pinned.pinToken);
      return { wireValue: pinned, mintedTokens };
    }
    if (op === "resolve" && result && typeof result === "object") {
      const res = result as ResolvedPath;
      const wire: {
        parent?: WirePinnedHandle;
        node?: WirePinnedHandle;
        name: string;
        trailingSlash: boolean;
        terminalDot: boolean;
      } = {
        name: res.name,
        trailingSlash: res.trailingSlash,
        terminalDot: res.terminalDot,
      };
      if (res.parent !== undefined) {
        const pNode = persistent.fs.nodeForHandle(res.parent);
        const pPin = this.mintHostPeerPin(session, res.parent, persistent.ensureIdentity(pNode).id);
        mintedTokens.push(pPin.pinToken);
        wire.parent = pPin;
      }
      if (res.node !== undefined) {
        const nNode = persistent.fs.nodeForHandle(res.node);
        const nPin = this.mintHostPeerPin(session, res.node, persistent.ensureIdentity(nNode).id);
        mintedTokens.push(nPin.pinToken);
        wire.node = nPin;
      }
      return { wireValue: wire, mintedTokens };
    }
    return { wireValue: result, mintedTokens };
  }

  private rollbackMintedPeerTokens(
    session: HostPeerSession,
    persistent: PersistentBackend,
    mintedTokens: readonly number[],
  ): void {
    for (const token of mintedTokens) {
      const h = session.pins.get(token);
      if (h === undefined) continue;
      session.pins.delete(token);
      persistent.release(h);
    }
  }

  private async executeHostPeerGeneralLoop(
    session: HostPeerSession,
    admittedTerm: bigint,
    persistent: PersistentBackend,
    msg: Extract<PeerMessage, { kind: "req" }>,
    data: Uint8Array,
  ): Promise<unknown> {
    for (;;) {
      this.assertHostOpStillValid(session, admittedTerm);
      const preparing = persistent.prepare(msg.op, msg.args);
      if (preparing) await preparing;
      this.assertHostOpStillValid(session, admittedTerm);

      let result: unknown;
      let dirtyRetryChange: number | undefined;
      await this.enqueueHostSerial(() => {
        this.assertHostOpStillValid(session, admittedTerm);
        const step = this.executePersistentOrDirtyRetry(persistent, msg.op, msg.args, data);
        if (step.retryChange !== undefined) {
          dirtyRetryChange = step.retryChange;
          return;
        }
        result = step.result;
      });

      if (dirtyRetryChange !== undefined) {
        await persistent.waitForDirtyCapacity(
          dirtyRetryChange,
          () => session.revoked || this.hostTerm !== admittedTerm || !this.isLeaseValid(),
        );
        continue;
      }
      return result;
    }
  }

  private async handleHostPeerGeneral(
    session: HostPeerSession,
    admittedTerm: bigint,
    msg: Extract<PeerMessage, { kind: "req" }>,
    data: Uint8Array,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    const result = MUTATION_OPS.has(msg.op)
      ? await this.barrier.runMutation(() =>
          this.executeHostPeerGeneralLoop(session, admittedTerm, persistent, msg, data),
        )
      : await this.executeHostPeerGeneralLoop(session, admittedTerm, persistent, msg, data);

    const { wireValue, mintedTokens } = this.wrapHostPeerResult(
      session,
      persistent,
      msg.op,
      result,
    );

    await this.hooks.beforeHostReplyPublish?.(msg.op, msg.reqId);
    if (
      session.revoked ||
      this.terminalFailure ||
      !this.isLeaseValid() ||
      this.hostTerm !== admittedTerm ||
      persistent.isTerminallyFailed()
    ) {
      this.rollbackMintedPeerTokens(session, persistent, mintedTokens);
      this.assertHostOpStillValid(session, admittedTerm);
    }

    if (wireValue instanceof Uint8Array) {
      reply({ ok: true, data: unsharedBytes(wireValue), binary: true });
    } else {
      reply({ ok: true, value: wireValue });
    }
  }

  private executePersistentOrDirtyRetry(
    persistent: PersistentBackend,
    op: string,
    args: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
  ): { result?: unknown; retryChange?: number } {
    try {
      const result =
        op === "readdirPage"
          ? persistent.fs.readdirPage(
              args[0] as number,
              args[1] as bigint,
              args[2] as number,
              responseCookieTag,
            )
          : persistent.execute(op, args, data);
      if (MUTATION_OPS.has(op)) {
        this.hostMutationSeq++;
        this.notifyAllPeerWatchers();
      }
      return { result };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        Reflect.get(error, "name") === "DirtyCapacityError" &&
        Reflect.get(error, "permanent") === false
      ) {
        return { retryChange: persistent.shared.dirtyAdmission.change };
      }
      throw error;
    }
  }

  private adjustPeerDownloadBudget(
    session: HostPeerSession,
    currentReserved: number,
    neededSize: number,
    shrinkIfSmall: boolean,
  ): number {
    if (neededSize > MAX_STAGED_DOWNLOAD_BYTES) {
      throw new FilesystemError(22, "readFile exceeds 32 MiB cap");
    }
    if (neededSize <= MAX_FRAME_BYTES) {
      if (shrinkIfSmall && currentReserved > 0) {
        this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - currentReserved);
        return 0;
      }
      return currentReserved;
    }
    if (neededSize <= currentReserved) return currentReserved;
    const delta = neededSize - currentReserved;
    if (
      (currentReserved === 0 && session.downloads.size >= MAX_CONCURRENT_DOWNLOADS_PER_PEER) ||
      this.hostUsedDownloadBytes + delta > MAX_STAGED_DOWNLOAD_BYTES
    ) {
      throw new FilesystemError(6, "staged download pool exhausted");
    }
    this.hostUsedDownloadBytes += delta;
    return neededSize;
  }

  /** Identity-bound pre-hydration readFile admission (Rev 24 §4.4). */
  private async handleHostPeerReadFile(
    session: HostPeerSession,
    admittedTerm: bigint,
    path: string,
    reqId: number,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    for (;;) {
      this.assertHostOpStillValid(session, admittedTerm);
      const attempt = { handle: undefined as number | undefined, reservedBytes: 0, fileId: 0n };
      const releaseAttempt = () => {
        if (attempt.reservedBytes > 0) {
          this.hostUsedDownloadBytes = Math.max(
            0,
            this.hostUsedDownloadBytes - attempt.reservedBytes,
          );
          attempt.reservedBytes = 0;
        }
        if (attempt.handle !== undefined) {
          persistent.release(attempt.handle);
          attempt.handle = undefined;
        }
      };

      try {
        const admitted = await this.admitPeerReadFile(
          persistent,
          session,
          admittedTerm,
          path,
          attempt,
        );
        if (!admitted) {
          await this.hooks.beforeHostReplyPublish?.("readFile", reqId);
          this.assertHostOpStillValid(session, admittedTerm);
          reply({ ok: true, value: undefined });
          return;
        }

        await this.hooks.beforeReadFileHydrate?.(path, attempt.fileId);
        const stillSame = await this.revalidatePeerReadFileBeforeHydrate(
          persistent,
          session,
          admittedTerm,
          path,
          attempt,
        );
        if (!stillSame) {
          releaseAttempt();
          continue;
        }

        await persistent.ensureLoadedHandle(attempt.handle!);
        await this.hooks.afterReadFilePrepare?.(path, attempt.fileId);

        const outcome = await this.readHydratedPeerFile(
          persistent,
          session,
          admittedTerm,
          path,
          attempt,
        );
        if (outcome.kind === "restart") {
          releaseAttempt();
          continue;
        }
        if (outcome.kind === "missing") {
          releaseAttempt();
          await this.hooks.beforeHostReplyPublish?.("readFile", reqId);
          this.assertHostOpStillValid(session, admittedTerm);
          reply({ ok: true, value: undefined });
          return;
        }

        persistent.release(attempt.handle!);
        attempt.handle = undefined;
        await this.hooks.beforeHostReplyPublish?.("readFile", reqId);
        this.assertHostOpStillValid(session, admittedTerm);

        const transferReserved = attempt.reservedBytes;
        attempt.reservedBytes = 0;
        this.replyWithBytes(session, outcome.bytes, transferReserved, true, false, reply);
        return;
      } catch (error) {
        releaseAttempt();
        throw error;
      }
    }
  }

  private async admitPeerReadFile(
    persistent: PersistentBackend,
    session: HostPeerSession,
    admittedTerm: bigint,
    path: string,
    attempt: { handle: number | undefined; reservedBytes: number; fileId: bigint },
  ): Promise<boolean> {
    let found = false;
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      const node = persistent.resolveNodePublic(path);
      if (!node || node.kind !== "file") return;
      const h = persistent.fs.handleForNode(node);
      persistent.retain(h);
      attempt.handle = h;
      attempt.fileId = persistent.ensureIdentity(node).id;
      const estimatedSize = persistent.shared.info(h)?.size ?? node.size ?? node.data.byteLength;
      attempt.reservedBytes = this.adjustPeerDownloadBudget(session, 0, estimatedSize, false);
      found = true;
    });
    return found;
  }

  private async revalidatePeerReadFileBeforeHydrate(
    persistent: PersistentBackend,
    session: HostPeerSession,
    admittedTerm: bigint,
    path: string,
    attempt: { handle: number | undefined; reservedBytes: number; fileId: bigint },
  ): Promise<boolean> {
    let valid = false;
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      const current = persistent.resolveNodePublic(path);
      if (!current || current.kind !== "file") return;
      if (persistent.ensureIdentity(current).id !== attempt.fileId) return;
      const currentSize =
        persistent.shared.info(attempt.handle!)?.size ?? current.size ?? current.data.byteLength;
      attempt.reservedBytes = this.adjustPeerDownloadBudget(
        session,
        attempt.reservedBytes,
        currentSize,
        false,
      );
      valid = true;
    });
    return valid;
  }

  private async readHydratedPeerFile(
    persistent: PersistentBackend,
    session: HostPeerSession,
    admittedTerm: bigint,
    path: string,
    attempt: { handle: number | undefined; reservedBytes: number; fileId: bigint },
  ): Promise<{ kind: "restart" } | { kind: "missing" } | { kind: "bytes"; bytes: Uint8Array }> {
    let outcome: { kind: "restart" } | { kind: "missing" } | { kind: "bytes"; bytes: Uint8Array } =
      {
        kind: "missing",
      };
    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      const current = persistent.resolveNodePublic(path);
      if (!current || current.kind !== "file") {
        outcome = { kind: "missing" };
        return;
      }
      if (persistent.ensureIdentity(current).id !== attempt.fileId) {
        outcome = { kind: "restart" };
        return;
      }
      const actualSize = persistent.shared.info(attempt.handle!)!.size;
      attempt.reservedBytes = this.adjustPeerDownloadBudget(
        session,
        attempt.reservedBytes,
        actualSize,
        true,
      );
      const out = new Uint8Array(actualSize);
      const bytes = out.subarray(0, persistent.shared.read(attempt.handle!, [out], 0));
      outcome = { kind: "bytes", bytes };
    });
    return outcome;
  }

  /** Bounded incremental actual wire-encoding traversal for readdir / lookup / listFiles (§4.4). */
  private async handleHostPeerBoundedWireRead(
    session: HostPeerSession,
    admittedTerm: bigint,
    op: "readdir" | "lookup" | "listFiles",
    args: unknown[],
    reqId: number,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): Promise<void> {
    const persistent = this.persistent!;
    let built!: { bytes: Uint8Array<ArrayBuffer>; reservedBytes: number };

    await this.enqueueHostSerial(() => {
      this.assertHostOpStillValid(session, admittedTerm);
      const builder = new BoundedWireBuilder(
        MAX_STAGED_DOWNLOAD_BYTES,
        (delta) => {
          if (this.hostUsedDownloadBytes + delta > MAX_STAGED_DOWNLOAD_BYTES) return false;
          this.hostUsedDownloadBytes += delta;
          return true;
        },
        (all) => {
          this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - all);
        },
      );
      try {
        this.encodeBoundedWireOp(persistent, builder, op, args);
        built = builder.finish();
      } catch (error) {
        builder.abort();
        throw error;
      }
    });

    let remainingReserved = built.reservedBytes;
    try {
      await this.hooks.beforeHostReplyPublish?.(op, reqId);
      this.assertHostOpStillValid(session, admittedTerm);

      if (built.bytes.byteLength <= MAX_FRAME_BYTES) {
        if (remainingReserved > 0) {
          this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - remainingReserved);
          remainingReserved = 0;
        }
        reply({ ok: true, data: unsharedBytes(built.bytes), packed: true });
        return;
      }

      if (session.downloads.size >= MAX_CONCURRENT_DOWNLOADS_PER_PEER) {
        throw new FilesystemError(6, "staged download pool exhausted");
      }

      const transferReserved = remainingReserved;
      remainingReserved = 0;
      this.replyWithBytes(session, built.bytes, transferReserved, false, true, reply);
    } catch (error) {
      if (remainingReserved > 0) {
        this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - remainingReserved);
      }
      throw error;
    }
  }

  private encodeBoundedWireOp(
    persistent: PersistentBackend,
    builder: BoundedWireBuilder,
    op: "readdir" | "lookup" | "listFiles",
    args: unknown[],
  ): void {
    if (op === "readdir") {
      builder.appendText("[");
      let first = true;
      persistent.fs.forEachDirEntry(args[0] as number, (entry) => {
        if (!first) builder.appendText(",");
        first = false;
        builder.appendPacked(entry);
      });
      builder.appendText("]");
      return;
    }
    if (op === "listFiles") {
      const remaining = Math.max(0, MAX_STAGED_DOWNLOAD_BYTES - this.hostUsedDownloadBytes);
      let actualWire = 2; // "[]"
      let first = true;
      const files = persistent.fs.collectBoundedFilePaths(
        (args[0] as string | undefined) ?? "/",
        (path) => {
          // Charge actual packed UTF-8 wire bytes as each path is visited (Rev 24 §4.4).
          actualWire += pack(path).byteLength + (first ? 0 : 1);
          first = false;
          if (actualWire > MAX_STAGED_DOWNLOAD_BYTES) {
            throw new FilesystemError(22, "wire response exceeds 32 MiB cap");
          }
          if (actualWire > MAX_FRAME_BYTES && actualWire > remaining) {
            throw new FilesystemError(6, "staged download pool exhausted");
          }
        },
      );
      this.appendBoundedArray(builder, files);
      return;
    }
    this.appendBoundedLookup(persistent, builder, args[0] as string);
  }

  private appendBoundedArray(builder: BoundedWireBuilder, items: readonly unknown[]): void {
    builder.appendText("[");
    for (let i = 0; i < items.length; i++) {
      if (i > 0) builder.appendText(",");
      builder.appendPacked(items[i]);
    }
    builder.appendText("]");
  }

  private appendBoundedLookup(
    persistent: PersistentBackend,
    builder: BoundedWireBuilder,
    path: string,
  ): void {
    const node = persistent.fs.lookup(path, false);
    if (!node) {
      builder.appendPacked(undefined);
      return;
    }
    const meta = (entry: Node) => {
      const times = persistent.shared.stat(persistent.fs.handleForNode(entry)) ?? entry;
      return {
        kind: entry.kind,
        ino: entry.ino,
        mtime: fileTimeMs(times.mtime),
        ctime: fileTimeMs(times.ctime),
        ...(entry.kind === "symlink" ? { target: entry.target } : {}),
      };
    };
    if (node.kind !== "dir") {
      builder.appendPacked(meta(node));
      return;
    }
    // Enforce the exact same directory read permission check as MemoryBackend.lookup!
    if (!(node.mode & 0o400)) throw new FilesystemError(2);
    const info = meta(node);
    builder.appendText(
      `{"kind":"dir","ino":${info.ino},"mtime":${info.mtime},"ctime":${info.ctime},"children":{"$map":[`,
    );
    let first = true;
    for (const [name, child] of node.children) {
      if (!first) builder.appendText(",");
      first = false;
      builder.appendText("[");
      builder.appendPacked(name);
      builder.appendText(",");
      builder.appendPacked(meta(child));
      builder.appendText("]");
    }
    builder.appendText("]}}");
  }

  private stageHostDownload(
    session: HostPeerSession,
    bytes: Uint8Array,
    reservedBytes: number,
    watchAckId?: number,
  ): { downloadId: string; firstChunk: Uint8Array<ArrayBuffer> } | undefined {
    if (session.downloads.size >= MAX_CONCURRENT_DOWNLOADS_PER_PEER) return undefined;
    if (reservedBytes === 0) {
      if (this.hostUsedDownloadBytes + bytes.byteLength > MAX_STAGED_DOWNLOAD_BYTES)
        return undefined;
      this.hostUsedDownloadBytes += bytes.byteLength;
      reservedBytes = bytes.byteLength;
    }
    const downloadId = `dl-${this.nextDownloadId++}`;
    session.downloads.set(downloadId, {
      downloadId,
      bytes,
      reservedBytes,
      watchAckId,
    });
    const firstChunk = unsharedBytes(
      bytes.subarray(0, Math.min(bytes.byteLength, MAX_FRAME_BYTES)),
    );
    return { downloadId, firstChunk };
  }

  private replyWithBytes(
    session: HostPeerSession,
    bytes: Uint8Array,
    reservedBytes: number,
    binary: boolean,
    packed: boolean,
    reply: (
      partial: Omit<
        Extract<PeerMessage, { kind: "res" }>,
        "kind" | "hostTerm" | "sessionId" | "reqId" | "creditFrames" | "creditBytes"
      >,
    ) => void,
  ): void {
    if (bytes.byteLength <= MAX_FRAME_BYTES) {
      if (reservedBytes > 0) {
        this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - reservedBytes);
      }
      reply({ ok: true, data: unsharedBytes(bytes), binary, packed });
      return;
    }
    const staged = this.stageHostDownload(session, bytes, reservedBytes);
    if (!staged) {
      if (reservedBytes > 0) {
        this.hostUsedDownloadBytes = Math.max(0, this.hostUsedDownloadBytes - reservedBytes);
      }
      throw new FilesystemError(6, "staged download pool exhausted");
    }
    reply({
      ok: true,
      binary,
      packed,
      chunkedId: staged.downloadId,
      totalBytes: bytes.byteLength,
      firstChunk: staged.firstChunk,
    });
  }

  private mintHostPeerPin(
    session: HostPeerSession,
    remoteHandle: number,
    fileId: bigint,
  ): WirePinnedHandle {
    const persistent = this.persistent!;
    persistent.retain(remoteHandle);
    const pinToken = this.nextPinToken++;
    session.pins.set(pinToken, remoteHandle);
    return {
      remoteHandle,
      fileId,
      pinToken,
      unlinked: persistent.shared.isUnlinked(remoteHandle),
    };
  }

  // ---------------------------------------------------------------------------
  // Host-Local Execution (Unified Serial Queue)
  // ---------------------------------------------------------------------------

  private enqueueHostSerial<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.hostQueue.then(fn);
    this.hostQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private enterHostAdmitted(): void {
    this.hostAdmittedCount++;
  }

  private leaveHostAdmitted(): void {
    this.hostAdmittedCount = Math.max(0, this.hostAdmittedCount - 1);
    if (this.hostAdmittedCount === 0 && this.hostAdmittedZeroWaiters.length) {
      const waiters = this.hostAdmittedZeroWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private waitForHostAdmittedZero(): Promise<void> {
    if (this.hostAdmittedCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.hostAdmittedZeroWaiters.push(resolve);
    });
  }

  /**
   * Throws unless this tab is still the Host of the term and may run local work. Returns false
   * when the lease lapsed only because renewal ran late, so the caller renews and checks again.
   * It samples the lease once: a second sample could see a lapse the first did not and fail a
   * call that a renewal would have kept.
   */
  private hostReadyForLocal(admittedTerm: bigint): boolean {
    if (this.terminalFailure || this.persistent?.isTerminallyFailed()) {
      throw new FilesystemError(29, describeReason(this.terminalFailure?.reason));
    }
    if (
      this.ownershipLost ||
      this.role !== "host" ||
      this.hostTerm !== admittedTerm ||
      !this.persistent
    ) {
      throw new FilesystemError(11, "host term ended");
    }
    if (this.steppingDown && (!this.disposing || this.disposeHostTerm !== admittedTerm)) {
      throw new FilesystemError(11, "host is stepping down");
    }
    if (this.isLeaseValid()) return true;
    if (this.lapseIsRenewable(admittedTerm)) return false;
    throw new FilesystemError(11, "host lease expired");
  }

  /**
   * The lease lapsed only because renewal ran late, for example behind a long task on this
   * worker. This tab is still the Host of this term, so a local operation renews and retries.
   */
  private leaseOnlyLapsed(admittedTerm: bigint): boolean {
    return !this.isLeaseValid() && this.lapseIsRenewable(admittedTerm);
  }

  /** Whether a lapse of the lease would be renewable: everything leaseOnlyLapsed checks but time. */
  private lapseIsRenewable(admittedTerm: bigint): boolean {
    return (
      !this.leaseClosed &&
      !this.ownershipLost &&
      !this.terminalFailure &&
      !this.persistent?.isTerminallyFailed() &&
      !!this.persistent &&
      this.role === "host" &&
      this.hostTerm === admittedTerm &&
      !this.steppingDown &&
      !this.disposing
    );
  }

  private assertLocalAttempt(admittedTerm: bigint, cancelled?: () => boolean): void {
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    if (!this.hostReadyForLocal(admittedTerm)) throw LEASE_LAPSED;
  }

  /** Abandon a local attempt's wait: cancelled, a new term, or a lease renewal cannot restore. */
  private localAttemptStale(admittedTerm: bigint, cancelled?: () => boolean): boolean {
    if (cancelled?.() || this.hostTerm !== admittedTerm) return true;
    return !this.isLeaseValid() && !this.leaseOnlyLapsed(admittedTerm);
  }

  /** Runs a local attempt; a lapsed lease is renewed, then the whole attempt runs again. */
  private async retryAfterLeaseRenewal<T>(
    admittedTerm: bigint,
    cancelled: (() => boolean) | undefined,
    budget: LeaseRenewalBudget,
    attempt: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (error !== LEASE_LAPSED) throw error;
      }
      // A lost term or a step-down fails in the next attempt's hostReadyForLocal.
      await this.renewLapsedLease(admittedTerm, cancelled, budget);
    }
  }

  /**
   * Renews a lapsed lease until this tab holds it, then returns; throws once this tab is no
   * longer the Host of the term or the call's renewal budget runs out.
   */
  private async assertHostAfterRenewal(
    admittedTerm: bigint,
    cancelled: (() => boolean) | undefined,
    budget: LeaseRenewalBudget,
  ): Promise<void> {
    while (!this.hostReadyForLocal(admittedTerm)) {
      await this.renewLapsedLease(admittedTerm, cancelled, budget);
    }
  }

  /**
   * Renews until the lease holds or this tab stops being the Host of the term. On a loaded
   * worker a renewal can confirm the locks yet finish past its own deadline, which proves
   * nothing about now, so it tries again one poll interval later. A renewal that keeps failing
   * that way, or keeps throwing, gives up once the call's budget passes.
   */
  private async renewLapsedLease(
    admittedTerm: bigint,
    cancelled?: () => boolean,
    budget: LeaseRenewalBudget = {},
  ): Promise<void> {
    const fresh = budget.deadline === undefined;
    const deadline = (budget.deadline ??=
      performance.now() + this.timings.leaseDurationMs * LEASE_RENEWAL_BUDGET_LEASES);
    for (let attempt = 0; this.leaseOnlyLapsed(admittedTerm); attempt++) {
      if ((attempt > 0 || !fresh) && performance.now() >= deadline) {
        throw new FilesystemError(11, "host lease could not be renewed");
      }
      if (attempt > 0) await this.pauseBeforeRenewal(cancelled);
      await raceWithAbort(
        this.renewLeaseNow(this.currentAttemptId),
        this.disposeAbort.signal,
        cancelled,
      );
      if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    }
  }

  private async pauseBeforeRenewal(cancelled?: () => boolean): Promise<void> {
    await raceWithAbort(delay(this.timings.waitPollMs), this.disposeAbort.signal, cancelled);
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
  }

  /**
   * The lease was not held when a local Host call started: renew it, or forward the call when
   * this tab has become a Peer. Returns the forwarded result, or undefined to run the call here.
   */
  private async renewBeforeLocalHostCall(
    admittedTerm: bigint,
    budget: LeaseRenewalBudget,
    operation: string,
    args: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
    cancelled?: () => boolean,
  ): Promise<{ result: unknown } | undefined> {
    if (this.disposing) throw new FilesystemError(11, "host lease expired during dispose");
    if (this.leaseOnlyLapsed(admittedTerm)) {
      await this.renewLapsedLease(admittedTerm, cancelled, budget);
    } else {
      await raceWithAbort(
        this.renewLeaseNow(this.currentAttemptId),
        this.disposeAbort.signal,
        cancelled,
      );
    }
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    if (this.disposing) throw new FilesystemError(11, "filesystem is disposing");
    // A lease renewed with little time left can lapse again before this check; that lapse is
    // renewed below like any other, not treated as a lost term.
    if (!this.isLeaseValid() && !this.leaseOnlyLapsed(admittedTerm)) {
      await this.awaitPendingFenceLoss(cancelled);
      if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
      if (this.disposing) throw new FilesystemError(11, "filesystem is disposing");
      if (this.terminalFailure) {
        throw new FilesystemError(29, describeReason(this.terminalFailure.reason));
      }
      if (this.ownershipLost) throw new FilesystemError(11, "filesystem ownership lost");
      if (this.role === "peer" || this.role === "failover" || this.role === "waiting") {
        const nextCookieTag = this.revalidateCookieForPeerForward(
          operation,
          args,
          responseCookieTag,
        );
        return {
          result: await this.executeOnPeer(operation, args, data, nextCookieTag, cancelled),
        };
      }
      throw new FilesystemError(11, "host lease expired");
    }
    return undefined;
  }

  private async executeLocalOnHost(
    operation: string,
    args: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
    cancelled?: () => boolean,
  ): Promise<unknown> {
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    const admittedTerm = this.hostTerm;
    const budget: LeaseRenewalBudget = {};

    // If lease expired before execution: renew first (or fail ECANCELED if disposing!)
    if (!this.isLeaseValid()) {
      const forwarded = await this.renewBeforeLocalHostCall(
        admittedTerm,
        budget,
        operation,
        args,
        data,
        responseCookieTag,
        cancelled,
      );
      if (forwarded) return forwarded.result;
    }

    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    if (!this.hostReadyForLocal(admittedTerm)) {
      await this.assertHostAfterRenewal(admittedTerm, cancelled, budget);
      if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    }
    const persistent = this.persistent!;
    const translated = this.translateArgsToHost(operation, args);
    if (!translated) throw new FilesystemError(8);

    this.enterHostAdmitted();
    try {
      if (operation === "flush" || operation === "sync") {
        const target =
          operation === "sync" ? (translated[0] as number) : (translated[0] as string | undefined);
        await this.hostQueue;
        if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
        await this.assertHostAfterRenewal(admittedTerm, cancelled, budget);
        await persistent.flush(target);
        return operation === "sync" ? 0 : undefined;
      }
      if (operation === "read") {
        return await this.retryAfterLeaseRenewal(admittedTerm, cancelled, budget, () =>
          this.executeLocalHostRead(persistent, admittedTerm, translated, cancelled),
        );
      }
      const result = await this.retryAfterLeaseRenewal(admittedTerm, cancelled, budget, () =>
        this.executeLocalHostGeneral(
          persistent,
          admittedTerm,
          operation,
          translated,
          data,
          responseCookieTag,
          cancelled,
        ),
      );
      return this.mapLocalHostHandles(persistent, admittedTerm, operation, result);
    } finally {
      this.leaveHostAdmitted();
    }
  }

  private async executeLocalHostRead(
    persistent: PersistentBackend,
    admittedTerm: bigint,
    translated: any[],
    cancelled?: () => boolean,
  ): Promise<Uint8Array> {
    const [remoteHandle, length, offset] = translated as [number, number, number];
    const assertValid = () => this.assertLocalAttempt(admittedTerm, cancelled);
    for (;;) {
      assertValid();
      const startVer = this.readVersion();
      const prep = persistent.prepareDescriptorRead(remoteHandle, offset, length, () =>
        this.localAttemptStale(admittedTerm, cancelled),
      );
      if (prep) {
        const accepted = await this.revalidateColdReadBytes(prep, startVer, assertValid);
        if (accepted !== undefined) return accepted;
        continue;
      }
      let readBytes!: Uint8Array;
      await this.enqueueHostSerial(() => {
        assertValid();
        readBytes = persistent.execute(
          "read",
          [remoteHandle, length, offset],
          new Uint8Array(),
        ) as Uint8Array;
      });
      return readBytes;
    }
  }

  private async executeLocalHostGeneral(
    persistent: PersistentBackend,
    admittedTerm: bigint,
    operation: string,
    translated: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
    cancelled?: () => boolean,
  ): Promise<unknown> {
    const assertValid = () => this.assertLocalAttempt(admittedTerm, cancelled);
    for (;;) {
      assertValid();
      const preparing = persistent.prepare(operation, translated);
      if (preparing) await awaitUnlessCancelled(preparing, cancelled);
      assertValid();

      let result: unknown;
      let dirtyRetryChange: number | undefined;
      await this.enqueueHostSerial(() => {
        assertValid();
        const step = this.executePersistentOrDirtyRetry(
          persistent,
          operation,
          translated,
          data,
          responseCookieTag,
        );
        if (step.retryChange !== undefined) {
          dirtyRetryChange = step.retryChange;
          return;
        }
        result = step.result;
      });
      if (dirtyRetryChange !== undefined) {
        await persistent.waitForDirtyCapacity(dirtyRetryChange, () =>
          this.localAttemptStale(admittedTerm, cancelled),
        );
        continue;
      }
      return result;
    }
  }

  private mapLocalHostHandles(
    persistent: PersistentBackend,
    admittedTerm: bigint,
    operation: string,
    result: unknown,
  ): unknown {
    if (operation === "preopen" || (operation === "create" && typeof result === "number")) {
      const remoteHandle = result as number;
      const node = persistent.fs.nodeForHandle(remoteHandle);
      const entry = this.ensureLocalHandle(
        persistent.ensureIdentity(node).id,
        remoteHandle,
        admittedTerm,
        undefined,
        undefined,
        persistent.shared.isUnlinked(remoteHandle),
      );
      entry.provisional++;
      return entry.localHandle;
    }

    if (operation === "resolve" && result && typeof result === "object") {
      const res = result as ResolvedPath;
      const mapped: ResolvedPath = { ...res, parent: undefined, node: undefined };
      const seen = new Set<LocalHandleEntry>();
      if (res.parent !== undefined) {
        const pNode = persistent.fs.nodeForHandle(res.parent);
        const pEntry = this.ensureLocalHandle(
          persistent.ensureIdentity(pNode).id,
          res.parent,
          admittedTerm,
          undefined,
          undefined,
          persistent.shared.isUnlinked(res.parent),
        );
        mapped.parent = pEntry.localHandle;
        seen.add(pEntry);
      }
      if (res.node !== undefined) {
        const nNode = persistent.fs.nodeForHandle(res.node);
        const nEntry = this.ensureLocalHandle(
          persistent.ensureIdentity(nNode).id,
          res.node,
          admittedTerm,
          undefined,
          undefined,
          persistent.shared.isUnlinked(res.node),
        );
        mapped.node = nEntry.localHandle;
        seen.add(nEntry);
      }
      for (const entry of seen) entry.provisional++;
      return mapped;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Peer-Side RPC Sending, Credits, Chunking, Heartbeats, & Failover
  // ---------------------------------------------------------------------------

  private totalPendingSettlements(): number {
    return (
      this.peerPendingUnpins.size +
      this.peerPendingWatchAcks.size +
      this.peerPendingWatchCloses.size +
      this.peerPendingUploadAborts.size
    );
  }

  /** Single settlement insertion point enforcing retired-session discard & MAX_PENDING_SETTLEMENTS (1024) cap (§4.3). */
  private enqueueSettlement(sessionId: string, item: SettlementItem): void {
    // Retired-session discard: Host already reclaimed all pins/watches/batches of retired sessions!
    if (sessionId !== this.peerSessionId || !this.peerAttached || !this.peerHostTerm) return;

    // Already tracked? Still re-send immediately without growing size.
    const alreadyPresent =
      (item.kind === "unpin" && this.peerPendingUnpins.has(item.pinToken)) ||
      (item.kind === "watch-ack" && this.peerPendingWatchAcks.has(item.ackId)) ||
      (item.kind === "watch-close" && this.peerPendingWatchCloses.has(item.hostWatchId)) ||
      (item.kind === "chunk-abort" && this.peerPendingUploadAborts.has(item.uploadId));

    if (!alreadyPresent && this.totalPendingSettlements() >= MAX_PENDING_SETTLEMENTS) {
      // Pre-insertion cap: trigger session reset instead of exceeding 1024!
      this.triggerPeerSessionReset("settlement-cap");
      return;
    }

    const termStr = formatTerm(this.peerHostTerm);
    if (item.kind === "unpin") {
      this.peerPendingUnpins.add(item.pinToken);
      this.postToPeerChannel({
        kind: "unpin",
        hostTerm: termStr,
        sessionId,
        pinToken: item.pinToken,
      });
    } else if (item.kind === "watch-ack") {
      this.peerPendingWatchAcks.set(item.ackId, item.accepted);
      this.postToPeerChannel({
        kind: "watch-ack",
        hostTerm: termStr,
        sessionId,
        ackId: item.ackId,
        accepted: item.accepted,
      });
    } else if (item.kind === "watch-close") {
      this.peerPendingWatchCloses.add(item.hostWatchId);
      this.postToPeerChannel({
        kind: "watch-close",
        hostTerm: termStr,
        sessionId,
        hostWatchId: item.hostWatchId,
      });
    } else {
      this.peerPendingUploadAborts.add(item.uploadId);
      this.postToPeerChannel({
        kind: "chunk-abort",
        hostTerm: termStr,
        sessionId,
        uploadId: item.uploadId,
      });
    }
  }

  private postToPeerChannel(message: PeerMessage): boolean {
    if (!this.peerChannel) return false;
    if (this.hooks.onPeerSend?.(this.selfId, message) === false) return true;
    try {
      this.peerChannel.postMessage(message);
      return true;
    } catch {
      this.triggerPeerSessionReset("postMessage-error");
      return false;
    }
  }

  private applyPeerCreditLimit(limit: PeerCreditLimit): void {
    const nextFrames = Math.max(this.peerGrantedFrames, limit.frames);
    const nextBytes = Math.max(this.peerGrantedBytes, limit.bytes);
    const deltaFrames = nextFrames - this.peerGrantedFrames;
    const deltaBytes = nextBytes - this.peerGrantedBytes;
    if (deltaFrames > 0 || deltaBytes > 0) {
      this.peerGrantedFrames = nextFrames;
      this.peerGrantedBytes = nextBytes;
      this.peerAvailableFrames += deltaFrames;
      this.peerAvailableBytes += deltaBytes;
      this.wakePeerCreditWaiters();
    }
  }

  private returnPeerCredits(frames: number, bytes: number): void {
    this.peerAvailableFrames = Math.min(this.peerGrantedFrames, this.peerAvailableFrames + frames);
    this.peerAvailableBytes = Math.min(this.peerGrantedBytes, this.peerAvailableBytes + bytes);
    this.wakePeerCreditWaiters();
  }

  private wakePeerCreditWaiters(): void {
    if (!this.peerCreditWaiters.length) return;
    const waiters = this.peerCreditWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  private refundPeerCredits(sessionId: string, frames: number, bytes: number): void {
    if (this.peerSessionId !== sessionId) return;
    this.peerAvailableFrames += frames;
    this.peerAvailableBytes += bytes;
    this.wakePeerCreditWaiters();
  }

  private abortPeerUpload(sessionId: string, _term: bigint, uploadId: string): void {
    this.enqueueSettlement(sessionId, { kind: "chunk-abort", uploadId });
  }

  private async reservePeerCredits(
    sessionId: string,
    frames: number,
    bytes: number,
    cancelled?: () => boolean,
  ): Promise<void> {
    if (cancelled?.()) throw abortError();
    while (
      this.peerSessionId === sessionId &&
      this.peerAttached &&
      !this.disposing &&
      !this.ownershipLost &&
      !this.terminalFailure &&
      !this.peerObservedHostFailed &&
      !cancelled?.() &&
      (this.peerAvailableFrames < frames || this.peerAvailableBytes < bytes)
    ) {
      let waiter!: () => void;
      const ready = new Promise<void>((resolve) => {
        waiter = resolve;
        this.peerCreditWaiters.push(resolve);
      });
      try {
        await awaitUnlessCancelled(ready, cancelled);
      } finally {
        const idx = this.peerCreditWaiters.indexOf(waiter);
        if (idx >= 0) this.peerCreditWaiters.splice(idx, 1);
      }
    }
    if (cancelled?.()) throw abortError();
    if (this.disposing || this.ownershipLost) {
      throw new FilesystemError(11, "filesystem is closing");
    }
    if (this.peerObservedHostFailed || this.terminalFailure) {
      throw new FilesystemError(
        29,
        this.peerObservedHostFailed ?? describeReason(this.terminalFailure?.reason),
      );
    }
    if (this.peerSessionId !== sessionId || !this.peerAttached) {
      // Unsent operation while waiting for credits -> safe to replay after session reset/failover!
      throw new FailoverReplayError();
    }
    this.peerAvailableFrames -= frames;
    this.peerAvailableBytes -= bytes;
  }

  private sendPeerHeartbeat(): void {
    if (!this.peerChannel || !this.peerAttached || !this.peerSessionId || !this.peerHostTerm)
      return;
    const pingId = this.peerNextPingId++;
    // Tag all currently in-flight sent RPCs with sentBeforePingId (FIFO lost-frame detection!)
    for (const rpc of this.peerInFlightRpcs.values()) {
      if (rpc.sent && rpc.sentBeforePingId === undefined) {
        rpc.sentBeforePingId = pingId;
      }
    }
    const pendingUnpins = Array.from(this.peerPendingUnpins).slice(0, PONG_SETTLEMENT_LIMIT);
    const pendingWatchAcks = Array.from(this.peerPendingWatchAcks.entries()).slice(
      0,
      PONG_SETTLEMENT_LIMIT,
    );
    const pendingWatchCloses = Array.from(this.peerPendingWatchCloses).slice(
      0,
      PONG_SETTLEMENT_LIMIT,
    );
    const pendingUploadAborts = Array.from(this.peerPendingUploadAborts).slice(
      0,
      PONG_SETTLEMENT_LIMIT,
    );
    this.postToPeerChannel({
      kind: "ping",
      hostTerm: formatTerm(this.peerHostTerm),
      sessionId: this.peerSessionId,
      pingId,
      latestAckedWakeSeq: this.peerLatestSeenWakeSeq,
      ...(pendingUnpins.length ? { pendingUnpins } : {}),
      ...(pendingWatchAcks.length ? { pendingWatchAcks } : {}),
      ...(pendingWatchCloses.length ? { pendingWatchCloses } : {}),
      ...(pendingUploadAborts.length ? { pendingUploadAborts } : {}),
    });
  }

  private onPeerMessage(msg: PeerMessage): void {
    if (
      !this.peerAttached ||
      msg.sessionId !== this.peerSessionId ||
      this.peerHostTerm === undefined ||
      msg.hostTerm !== formatTerm(this.peerHostTerm)
    )
      return;

    this.peerLastHostActivityAt = Date.now();

    switch (msg.kind) {
      case "attached":
      case "credit-limit":
        this.applyPeerCreditLimit(msg.creditLimit);
        return;
      case "watch-wake":
        if (msg.wakeSeq > this.peerLatestSeenWakeSeq) {
          this.peerLatestSeenWakeSeq = msg.wakeSeq;
          this.wakeWatchWord();
        }
        this.postToPeerChannel({
          kind: "watch-wake-ack",
          hostTerm: msg.hostTerm,
          sessionId: msg.sessionId,
          wakeSeq: this.peerLatestSeenWakeSeq,
        });
        return;
      case "settled":
        this.applyPeerSettledLists(msg.unpins, msg.watchAcks, msg.watchCloses, msg.uploadAborts);
        return;
      case "pong":
        this.onPeerPong(msg);
        return;
      case "res":
        this.onPeerRes(msg);
        return;
    }
  }

  private applyPeerSettledLists(
    unpins?: readonly number[],
    watchAcks?: readonly number[],
    watchCloses?: readonly number[],
    uploadAborts?: readonly string[],
  ): void {
    for (const token of unpins ?? []) this.peerPendingUnpins.delete(token);
    for (const ackId of watchAcks ?? []) this.peerPendingWatchAcks.delete(ackId);
    for (const watchId of watchCloses ?? []) this.peerPendingWatchCloses.delete(watchId);
    for (const uploadId of uploadAborts ?? []) this.peerPendingUploadAborts.delete(uploadId);
  }

  private onPeerPong(msg: Extract<PeerMessage, { kind: "pong" }>): void {
    this.applyPeerCreditLimit(msg.creditLimit);
    this.applyPeerSettledLists(
      msg.settledUnpins,
      msg.settledWatchAcks,
      msg.settledWatchCloses,
      msg.settledUploadAborts,
    );

    if (msg.latestWakeSeq > this.peerLatestSeenWakeSeq) {
      this.peerLatestSeenWakeSeq = msg.latestWakeSeq;
      this.wakeWatchWord();
      this.postToPeerChannel({
        kind: "watch-wake-ack",
        hostTerm: msg.hostTerm,
        sessionId: msg.sessionId,
        wakeSeq: this.peerLatestSeenWakeSeq,
      });
    }

    if (msg.hostState === "failed") {
      this.handleObservedHostFailed({ message: "host storage terminally failed" });
      return;
    }
    if (msg.hostState === "ready") {
      this.drainPeerRetryQueue();
    }

    const active = new Set(msg.activeReqIds);
    for (const rpc of this.peerInFlightRpcs.values()) {
      if (
        rpc.sentBeforePingId !== undefined &&
        rpc.sentBeforePingId <= msg.pingId &&
        !active.has(rpc.reqId)
      ) {
        this.triggerPeerSessionReset("lost-frame");
        return;
      }
    }
  }

  private onPeerRes(msg: Extract<PeerMessage, { kind: "res" }>): void {
    this.returnPeerCredits(msg.creditFrames ?? 1, msg.creditBytes ?? 0);
    const rpc = this.peerInFlightRpcs.get(msg.reqId);
    if (!rpc) {
      this.cleanupLatePeerReply(msg);
      return;
    }
    this.peerInFlightRpcs.delete(msg.reqId);
    if (msg.retry) {
      rpc.reject(new RetryOnHostReadyError());
      return;
    }
    if (!msg.ok) {
      const code = msg.errno ?? 29;
      if (rpc.isWatchRead && code === 29) {
        this.wakeWatchWord();
        this.resolveWatchOverflow(rpc.localWatchId, rpc.resolve);
        return;
      }
      rpc.reject(new FilesystemError(code, msg.message));
      return;
    }
    rpc.resolve(msg);
  }

  private cleanupLatePeerReply(msg: Extract<PeerMessage, { kind: "res" }>): void {
    if (!msg.ok || !this.peerSessionId) return;
    if (msg.ackId !== undefined) {
      this.enqueueSettlement(this.peerSessionId, {
        kind: "watch-ack",
        ackId: msg.ackId,
        accepted: false,
      });
    }
    const v = msg.value as Record<string, unknown> | undefined;
    if (v && typeof v === "object") {
      if (typeof v.pinToken === "number") {
        this.enqueueSettlement(this.peerSessionId, { kind: "unpin", pinToken: v.pinToken });
      }
      const parent = v.parent as WirePinnedHandle | undefined;
      if (parent && typeof parent.pinToken === "number") {
        this.enqueueSettlement(this.peerSessionId, { kind: "unpin", pinToken: parent.pinToken });
      }
      const node = v.node as WirePinnedHandle | undefined;
      if (node && typeof node.pinToken === "number") {
        this.enqueueSettlement(this.peerSessionId, { kind: "unpin", pinToken: node.pinToken });
      }
    }
  }

  private executeOnPeer(
    operation: string,
    args: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
    cancelled?: () => boolean,
  ): Promise<unknown> {
    if (cancelled?.()) return Promise.reject(new FilesystemError(11, "operation cancelled"));
    if (this.disposing || this.ownershipLost) return Promise.reject(new FilesystemError(11));
    if (this.terminalFailure || this.peerObservedHostFailed) {
      return Promise.reject(
        new FilesystemError(
          29,
          this.peerObservedHostFailed ?? describeReason(this.terminalFailure?.reason),
        ),
      );
    }

    if (
      this.role === "failover" ||
      this.role === "waiting" ||
      !this.peerAttached ||
      this.peerRebinding
    ) {
      return this.enqueuePeerOp(
        this.peerFailoverQueue,
        operation,
        args,
        data,
        responseCookieTag,
        cancelled,
      );
    }

    let effectiveCookieTag = responseCookieTag;
    try {
      effectiveCookieTag = this.revalidateCookieForPeerForward(operation, args, responseCookieTag);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.dispatchPeerOperation(operation, args, data, effectiveCookieTag, cancelled);
  }

  private revalidateCookieForPeerForward(
    operation: string,
    args: unknown[],
    responseCookieTag?: bigint,
  ): bigint | undefined {
    if (operation !== "readdirPage" || responseCookieTag === undefined) return responseCookieTag;
    if (responseCookieTag === this.dirEpoch) return responseCookieTag;
    const cookie = args[1];
    if (typeof cookie === "bigint" && cookie >= 3n) {
      throw new FilesystemError(8, "stale directory cookie across failover");
    }
    if (this.dirEpoch >= DIR_EPOCH_MAX) {
      throw new FilesystemError(61, "directory epoch exhausted");
    }
    return this.dirEpoch;
  }

  private async dispatchPeerOperation(
    operation: string,
    args: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
    cancelled?: () => boolean,
  ): Promise<unknown> {
    if (cancelled?.()) throw new FilesystemError(11, "operation cancelled");
    const sessionId = this.peerSessionId;
    const term = this.peerHostTerm;
    if (!sessionId || term === undefined || !this.peerAttached) {
      return this.executeOnPeer(operation, args, data, responseCookieTag, cancelled);
    }

    const remoteArgs = this.translateArgsToPeer(operation, args, term, sessionId);
    if (!remoteArgs) throw new FilesystemError(8);

    let uploadId: string | undefined;
    let finalValue: unknown;
    try {
      const uploaded = await this.uploadPeerDataIfChunked(sessionId, term, data, cancelled);
      uploadId = uploaded.uploadId;
      const res = await this.sendPeerReq(
        sessionId,
        term,
        operation,
        remoteArgs,
        args,
        uploaded.inlineData,
        uploadId,
        data.byteLength > MAX_FRAME_BYTES ? data.byteLength : undefined,
        responseCookieTag,
        false,
        undefined,
        cancelled,
      );
      uploadId = undefined;
      finalValue = await this.decodePeerResponseValue(
        sessionId,
        term,
        res,
        isReplayableRead(operation, args),
      );
    } catch (error) {
      if (uploadId) this.abortPeerUpload(sessionId, term, uploadId);
      if (error instanceof RetryOnHostReadyError || error instanceof FailoverReplayError) {
        const queue =
          error instanceof RetryOnHostReadyError ? this.peerRetryQueue : this.peerFailoverQueue;
        return this.enqueuePeerOp(queue, operation, args, data, responseCookieTag, cancelled);
      }
      throw error;
    }

    return this.mapPeerReturnedHandles(operation, term, sessionId, finalValue);
  }

  private enqueuePeerOp(
    queue: QueuedPeerOp[],
    op: string,
    args: any[],
    data: Uint8Array,
    responseCookieTag?: bigint,
    cancelled?: () => boolean,
  ): Promise<unknown> {
    if (cancelled?.()) return Promise.reject(new FilesystemError(11, "operation cancelled"));
    if (this.disposing || this.ownershipLost) {
      return Promise.reject(new FilesystemError(11, "filesystem is closing"));
    }
    if (this.peerObservedHostFailed || this.terminalFailure) {
      return Promise.reject(
        new FilesystemError(
          29,
          this.peerObservedHostFailed ?? describeReason(this.terminalFailure?.reason),
        ),
      );
    }
    return new Promise((resolve, reject) => {
      queue.push({
        op,
        args,
        data: data.byteLength ? unsharedBytes(data) : undefined,
        responseCookieTag,
        cancelled,
        resolve,
        reject,
      });
    });
  }

  private async uploadPeerDataIfChunked(
    sessionId: string,
    term: bigint,
    data: Uint8Array,
    cancelled?: () => boolean,
  ): Promise<{ uploadId?: string; inlineData?: Uint8Array<ArrayBuffer> }> {
    if (cancelled?.()) throw abortError();
    if (data.byteLength <= MAX_FRAME_BYTES) {
      return data.byteLength > 0 ? { inlineData: unsharedBytes(data) } : {};
    }
    if (data.byteLength > MAX_STAGED_UPLOAD_BYTES) {
      throw new FilesystemError(22, "payload exceeds 32 MiB upload cap");
    }
    const uploadId = `up-${this.peerNextUploadId++}`;
    const totalBytes = data.byteLength;
    let staged = false;
    try {
      for (let offset = 0; offset < totalBytes; offset += MAX_FRAME_BYTES) {
        if (cancelled?.()) throw abortError();
        const end = Math.min(totalBytes, offset + MAX_FRAME_BYTES);
        staged = true;
        await this.sendPeerChunkPut(
          sessionId,
          term,
          uploadId,
          offset,
          totalBytes,
          unsharedBytes(data.subarray(offset, end)),
          cancelled,
        );
      }
      if (cancelled?.()) throw abortError();
      return { uploadId };
    } catch (error) {
      if (staged) this.abortPeerUpload(sessionId, term, uploadId);
      throw error;
    }
  }

  private async decodePeerResponseValue(
    sessionId: string,
    term: bigint,
    res: Extract<PeerMessage, { kind: "res" }>,
    replayOnSessionBreak = false,
  ): Promise<unknown> {
    if (res.chunkedId && res.totalBytes !== undefined && res.firstChunk) {
      const assembled = await this.fetchPeerChunkedDownload(
        sessionId,
        term,
        res.chunkedId,
        res.totalBytes,
        res.firstChunk,
        replayOnSessionBreak,
      );
      return res.packed ? unpack(assembled) : assembled;
    }
    if (res.packed && res.data) return unpack(res.data);
    if (res.binary && res.data) return res.data;
    return res.value;
  }

  private mapPeerReturnedHandles(
    operation: string,
    term: bigint,
    sessionId: string,
    finalValue: unknown,
  ): unknown {
    if (
      (operation === "preopen" || operation === "create") &&
      finalValue &&
      typeof finalValue === "object" &&
      "pinToken" in finalValue
    ) {
      const wire = finalValue as WirePinnedHandle;
      const entry = this.ensureLocalHandle(
        wire.fileId,
        wire.remoteHandle,
        term,
        sessionId,
        wire.pinToken,
        wire.unlinked,
      );
      entry.provisional++;
      return entry.localHandle;
    }

    if (operation === "resolve" && finalValue && typeof finalValue === "object") {
      const wire = finalValue as WireResolveResult;
      const mapped: ResolvedPath = {
        name: wire.name,
        trailingSlash: wire.trailingSlash,
        terminalDot: wire.terminalDot,
        parent: undefined,
        node: undefined,
      };
      const seen = new Set<LocalHandleEntry>();
      if (wire.parent) {
        const pEntry = this.ensureLocalHandle(
          wire.parent.fileId,
          wire.parent.remoteHandle,
          term,
          sessionId,
          wire.parent.pinToken,
          wire.parent.unlinked,
        );
        mapped.parent = pEntry.localHandle;
        seen.add(pEntry);
      }
      if (wire.node) {
        const nEntry = this.ensureLocalHandle(
          wire.node.fileId,
          wire.node.remoteHandle,
          term,
          sessionId,
          wire.node.pinToken,
          wire.node.unlinked,
        );
        mapped.node = nEntry.localHandle;
        seen.add(nEntry);
      }
      for (const entry of seen) entry.provisional++;
      return mapped;
    }

    return finalValue;
  }

  private async sendPeerChunkPut(
    sessionId: string,
    term: bigint,
    uploadId: string,
    offset: number,
    totalBytes: number,
    chunk: Uint8Array<ArrayBuffer>,
    cancelled?: () => boolean,
  ): Promise<void> {
    await this.reservePeerCredits(sessionId, 1, chunk.byteLength, cancelled);
    if (cancelled?.()) {
      this.refundPeerCredits(sessionId, 1, chunk.byteLength);
      throw abortError();
    }
    const reqId = this.peerNextReqId++;
    const ack = new Promise<void>((resolve, reject) => {
      this.peerInFlightRpcs.set(reqId, {
        reqId,
        op: "chunk-put",
        localArgs: [],
        payloadBytes: chunk.byteLength,
        sent: true,
        resolve: () => resolve(),
        reject,
      });
      this.postToPeerChannel({
        kind: "chunk-put",
        hostTerm: formatTerm(term),
        sessionId,
        reqId,
        uploadId,
        offset,
        totalBytes,
        chunk,
      });
    });
    void ack.catch(() => {});
    await awaitUnlessCancelled(ack, cancelled);
  }

  private async fetchPeerChunkedDownload(
    sessionId: string,
    term: bigint,
    downloadId: string,
    totalBytes: number,
    firstChunk: Uint8Array,
    replayOnSessionBreak = false,
  ): Promise<Uint8Array> {
    const out = new Uint8Array(totalBytes);
    out.set(firstChunk, 0);
    let offset = firstChunk.byteLength;
    while (offset < totalBytes) {
      await this.reservePeerCredits(sessionId, 1, 0);
      const reqId = this.peerNextReqId++;
      const res = await new Promise<Extract<PeerMessage, { kind: "res" }>>((resolve, reject) => {
        this.peerInFlightRpcs.set(reqId, {
          reqId,
          op: "chunk-get",
          localArgs: [],
          payloadBytes: 0,
          sent: true,
          replayOnSessionBreak,
          resolve,
          reject,
        });
        this.postToPeerChannel({
          kind: "chunk-get",
          hostTerm: formatTerm(term),
          sessionId,
          reqId,
          downloadId,
          offset,
          length: Math.min(MAX_FRAME_BYTES, totalBytes - offset),
        });
      });
      if (!res.data || !res.data.byteLength) throw new FilesystemError(29, "truncated chunk-get");
      out.set(res.data, offset);
      offset += res.data.byteLength;
    }
    return out;
  }

  private async sendPeerReq(
    sessionId: string,
    term: bigint,
    op: string,
    args: unknown[],
    localArgs: unknown[] = args,
    data?: Uint8Array<ArrayBuffer>,
    uploadId?: string,
    totalBytes?: number,
    responseCookieTag?: bigint,
    isWatchRead = false,
    localWatchId?: number,
    cancelled?: () => boolean,
  ): Promise<Extract<PeerMessage, { kind: "res" }>> {
    const payloadBytes = data?.byteLength ?? 0;
    await this.reservePeerCredits(sessionId, 1, payloadBytes, cancelled);
    if (cancelled?.()) {
      this.refundPeerCredits(sessionId, 1, payloadBytes);
      throw abortError();
    }
    const reqId = this.peerNextReqId++;
    return new Promise<Extract<PeerMessage, { kind: "res" }>>((resolve, reject) => {
      this.peerInFlightRpcs.set(reqId, {
        reqId,
        op,
        localArgs,
        data,
        payloadBytes,
        responseCookieTag,
        sent: true,
        isWatchRead,
        localWatchId,
        resolve,
        reject,
      });
      this.postToPeerChannel({
        kind: "req",
        hostTerm: formatTerm(term),
        sessionId,
        reqId,
        op,
        args,
        ...(data ? { data } : {}),
        ...(uploadId ? { uploadId, totalBytes } : {}),
        ...(responseCookieTag !== undefined
          ? { responseCookieTag: formatTerm(responseCookieTag) }
          : {}),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Peer Watch Open & Read (Rev 24 §8.3)
  // ---------------------------------------------------------------------------

  private async openPeerWatch(
    owner: number,
    entry: LocalHandleEntry,
    recursive: boolean,
    cancelled: () => boolean,
  ): Promise<number> {
    if (cancelled()) throw new FilesystemError(11);
    const sessionId = this.peerSessionId;
    const term = this.peerHostTerm;
    if (
      !sessionId ||
      term === undefined ||
      !this.peerAttached ||
      entry.remoteHandle === undefined ||
      entry.remoteTerm !== term
    ) {
      throw new FilesystemError(29, "peer not connected for watchOpen");
    }
    let res: Extract<PeerMessage, { kind: "res" }>;
    try {
      res = await this.sendPeerReq(sessionId, term, "watchOpen", [entry.remoteHandle, recursive]);
    } catch (error) {
      if (error instanceof FailoverReplayError) {
        throw new FilesystemError(29, "peer session changed during watchOpen");
      }
      throw error;
    }
    const hostWatchId = res.value as number;
    if (cancelled() || this.disposing || this.peerSessionId !== sessionId) {
      // Late watchOpen reply after local cancellation -> enqueue watchClose!
      this.enqueueSettlement(sessionId, { kind: "watch-close", hostWatchId });
      throw new FilesystemError(11);
    }
    const localWatchId = this.nextLocalWatchId++;
    this.localWatches.set(localWatchId, {
      localWatchId,
      localOwner: owner,
      fileId: entry.fileId,
      recursive,
      hostTerm: term,
      hostWatchId,
      overflowed: false,
      closed: false,
    });
    return localWatchId;
  }

  private async readPeerWatch(
    watch: LocalWatchEntry,
    cancelled: () => boolean,
  ): Promise<HeldWatchBatch> {
    if (cancelled()) throw new FilesystemError(11);
    if (watch.overflowed) {
      return { batch: { kind: "overflow", events: [] }, release() {}, rollback() {} };
    }
    const sessionId = this.peerSessionId;
    const term = this.peerHostTerm;
    if (
      !sessionId ||
      term === undefined ||
      !this.peerAttached ||
      watch.hostTerm !== term ||
      watch.hostWatchId === undefined
    ) {
      watch.overflowed = true;
      return { batch: { kind: "overflow", events: [] }, release() {}, rollback() {} };
    }

    let res: Extract<PeerMessage, { kind: "res" }> | HeldWatchBatch;
    try {
      res = await this.sendPeerReq(
        sessionId,
        term,
        "watchRead",
        [watch.hostWatchId],
        [watch.hostWatchId],
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        watch.localWatchId,
      );
    } catch (error) {
      // Never propagate EIO for an active watch when Host failed / crashed / reset (§8.3.4)!
      if (
        error instanceof FailoverReplayError ||
        (error instanceof FilesystemError && (error.errno === 29 || error.errno === 11))
      ) {
        if (!cancelled() && !this.disposing) {
          watch.overflowed = true;
          this.wakeWatchWord();
          return { batch: { kind: "overflow", events: [] }, release() {}, rollback() {} };
        }
      }
      throw error;
    }

    // If handleObservedHostFailed / onPeerMessage resolved directly with an overflow HeldWatchBatch:
    if (isHeldWatchBatch(res)) return res;

    const ackId = res.ackId;
    let settled = false;
    const sendAck = (accepted: boolean) => {
      if (settled || ackId === undefined) return;
      settled = true;
      this.enqueueSettlement(sessionId, { kind: "watch-ack", ackId, accepted });
    };

    if (cancelled() || watch.closed || this.peerSessionId !== sessionId) {
      sendAck(false);
      throw new FilesystemError(11);
    }

    let batch: WatchBatch;
    if (res.chunkedId && res.totalBytes !== undefined && res.firstChunk) {
      try {
        const assembled = await this.fetchPeerChunkedDownload(
          sessionId,
          term,
          res.chunkedId,
          res.totalBytes,
          res.firstChunk,
        );
        if (cancelled() || watch.closed || this.peerSessionId !== sessionId) {
          sendAck(false);
          throw new FilesystemError(11);
        }
        batch = unpack(assembled) as WatchBatch;
      } catch (error) {
        sendAck(false);
        if (watch.overflowed) {
          return { batch: { kind: "overflow", events: [] }, release() {}, rollback() {} };
        }
        throw error;
      }
    } else {
      batch = res.value as WatchBatch;
    }

    if (batch.kind === "overflow") {
      watch.overflowed = true;
    }

    return {
      batch,
      release: () => sendAck(true),
      rollback: () => sendAck(false),
    };
  }

  // ---------------------------------------------------------------------------
  // Peer Session Reset, Rebind, & Failover Loop (Rev 24 §4.3, §5.4, §8.1–8.3)
  // ---------------------------------------------------------------------------

  private resetPeerSessionForFailover(): void {
    this.stopPeerTimers();
    this.advanceDirEpoch();
    this.peerPendingUnpins.clear();
    this.peerPendingWatchAcks.clear();
    this.peerPendingWatchCloses.clear();
    this.peerPendingUploadAborts.clear();
    this.settleInFlightOnSessionBreak();
    this.markLocalWatchesOverflow();
    this.detachHandlesForRemount();
    this.closePeerChannelOnly();
    this.role = "failover";
  }

  private triggerPeerSessionReset(_reason: string): void {
    if (this.role !== "peer" || this.disposing || this.ownershipLost || this.terminalFailure) {
      return;
    }
    const hostReadySnapshot: Extract<ControlMessage, { kind: "host-ready" }> | undefined =
      this.peerHostAttemptId &&
      this.peerHostClientId &&
      this.peerHostTerm !== undefined &&
      this.cohortWorkspaceId
        ? {
            kind: "host-ready",
            attemptId: this.peerHostAttemptId,
            clientId: this.peerHostClientId,
            hostTerm: formatTerm(this.peerHostTerm),
            workspaceId: this.cohortWorkspaceId,
            storageEpoch: this.cohortLastAcceptedEpoch ?? 0,
            lastExclusiveEpoch: 0,
          }
        : undefined;

    this.beginPeerFailover("session-reset", hostReadySnapshot);
  }

  private startTrackedFailoverLoop(
    directHostReady?: Extract<ControlMessage, { kind: "host-ready" }>,
  ): void {
    if (this.disposing || this.ownershipLost || this.terminalFailure) return;
    if (directHostReady) this.pendingDirectHostReady = directHostReady;
    if (this.peerFailoverInFlight) return;
    const loop = this.trackBackgroundTask(
      this.runFailoverLoop().finally(() => {
        if (this.peerFailoverInFlight === loop) this.peerFailoverInFlight = undefined;
        if (
          this.pendingDirectHostReady &&
          this.role === "failover" &&
          !this.disposing &&
          !this.ownershipLost &&
          !this.terminalFailure
        ) {
          this.startTrackedFailoverLoop();
        }
      }),
    );
    this.peerFailoverInFlight = loop;
  }

  private beginPeerFailover(
    _reason: string,
    directHostReady?: Extract<ControlMessage, { kind: "host-ready" }>,
  ): void {
    if (this.disposing || this.ownershipLost || this.terminalFailure) return;

    this.resetPeerSessionForFailover();
    this.startTrackedFailoverLoop(directHostReady);
  }

  /** Enforce Rev 24 §8.2 strict replay classification on crash/freeze/session reset! */
  private settleInFlightOnSessionBreak(): void {
    for (const [reqId, rpc] of Array.from(this.peerInFlightRpcs)) {
      this.peerInFlightRpcs.delete(reqId);
      if (rpc.isWatchRead) {
        this.resolveWatchOverflow(rpc.localWatchId, rpc.resolve);
        continue;
      }
      if (rpc.op === "chunk-get" && rpc.replayOnSessionBreak) {
        rpc.reject(new FailoverReplayError());
        continue;
      }
      if (rpc.op === "chunk-put" || rpc.op === "chunk-get" || rpc.op === "__rebind") {
        rpc.reject(new FilesystemError(29, "peer session reset during transfer"));
        continue;
      }
      if (rpc.op === "readdirPage" && rpc.responseCookieTag !== undefined) {
        const cookie = rpc.localArgs[1];
        if (typeof cookie === "bigint" && cookie >= 3n) {
          rpc.reject(new FilesystemError(8, "stale directory cookie across session break"));
          continue;
        }
      }
      if (isReplayableRead(rpc.op, rpc.localArgs)) {
        rpc.reject(new FailoverReplayError());
      } else {
        // Already-sent mutation (including preopen!) -> EIO, NEVER silently replay!
        rpc.reject(new FilesystemError(29, "ambiguous mutation outcome across failover"));
      }
    }
    this.wakePeerCreditWaiters();
  }

  private isFailoverLoopDone(): boolean {
    return (
      (this.role === "host" || (this.role === "peer" && this.peerAttached)) &&
      !this.pendingDirectHostReady
    );
  }

  private async runFailoverStep(signal: AbortSignal): Promise<void> {
    const direct = this.pendingDirectHostReady;
    this.pendingDirectHostReady = undefined;
    if (direct) {
      await this.tryAttachToHostReady(direct, signal);
      return;
    }
    await this.runRecoveryProbeAndDispatch(signal);
  }

  private async runFailoverLoop(): Promise<void> {
    const signal = this.disposeAbort.signal;
    try {
      while (!signal.aborted && !this.disposing && !this.ownershipLost && !this.terminalFailure) {
        await this.runFailoverStep(signal);
        if (this.isFailoverLoopDone()) return;
      }
    } catch (error) {
      if (!this.disposing && !this.ownershipLost && !this.terminalFailure) {
        this.failAllPeerWork(error);
      }
    } finally {
      this.notifyFailoverReadyWaiters();
    }
  }

  private async rebindPeerHandles(term: bigint, sessionId: string): Promise<void> {
    const entries = Array.from(this.byLocalHandle.values()).filter((e) => !e.stale);
    if (!entries.length) return;
    this.peerRebinding = true;
    try {
      const fileIds = entries.map((e) => e.fileId);
      const res = await this.sendPeerReq(sessionId, term, "__rebind", [fileIds]);
      const bound = res.value as (WirePinnedHandle | null)[];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const wire = bound[i];
        if (!wire) {
          entry.stale = true;
          entry.remoteHandle = undefined;
          entry.pinToken = undefined;
          continue;
        }
        if (entry.releasedDuringRebind || !this.byLocalHandle.has(entry.localHandle)) {
          // Released locally during async rebind -> unpin immediately (§8.1)!
          this.enqueueSettlement(sessionId, { kind: "unpin", pinToken: wire.pinToken });
          continue;
        }
        entry.remoteHandle = wire.remoteHandle;
        entry.remoteTerm = term;
        entry.remoteSessionId = sessionId;
        entry.pinToken = wire.pinToken;
        entry.unlinked = !!wire.unlinked;
        this.unlinkEvents++;
        entry.stale = false;
      }
    } finally {
      this.peerRebinding = false;
    }
  }

  private rebindLocalHandlesOnHost(term: bigint): void {
    const persistent = this.persistent!;
    this.unlinkEvents++;
    for (const entry of this.byLocalHandle.values()) {
      const node = persistent.nodeByFileId(entry.fileId);
      if (!node) {
        entry.stale = true;
        entry.remoteHandle = undefined;
        continue;
      }
      const remoteHandle = persistent.fs.handleForNode(node);
      persistent.retain(remoteHandle);
      entry.remoteHandle = remoteHandle;
      entry.remoteTerm = term;
      entry.remoteSessionId = undefined;
      entry.pinToken = undefined;
      entry.unlinked = persistent.shared.isUnlinked(remoteHandle);
      entry.stale = false;
    }
  }

  private isStaleQueuedCookie(op: QueuedPeerOp): boolean {
    if (op.op !== "readdirPage" || op.responseCookieTag === undefined) return false;
    const cookie = op.args[1];
    return typeof cookie === "bigint" && cookie >= 3n && op.responseCookieTag !== this.dirEpoch;
  }

  private dispatchQueuedOps(
    ops: readonly QueuedPeerOp[],
    dispatchImmediate: (op: QueuedPeerOp) => Promise<unknown>,
  ): void {
    for (const op of ops) {
      if (op.cancelled?.()) {
        op.reject(new FilesystemError(11, "operation cancelled"));
        continue;
      }
      if (this.isStaleQueuedCookie(op)) {
        op.reject(new FilesystemError(8, "stale directory cookie"));
        continue;
      }
      dispatchImmediate(op).then(op.resolve, op.reject);
    }
  }

  private drainPeerQueue(queue: QueuedPeerOp[]): void {
    if (!queue.length || !this.peerAttached || this.peerRebinding) return;
    this.dispatchQueuedOps(queue.splice(0), (op) =>
      this.dispatchPeerOperation(
        op.op,
        op.args,
        op.data ?? new Uint8Array(),
        op.op === "readdirPage" ? this.dirEpoch : op.responseCookieTag,
        op.cancelled,
      ),
    );
  }

  private drainPeerRetryQueue(): void {
    this.drainPeerQueue(this.peerRetryQueue);
  }

  private drainPeerRetryAndFailoverQueues(): void {
    if (!this.peerAttached || this.peerRebinding) return;
    const all = this.peerRetryQueue.splice(0).concat(this.peerFailoverQueue.splice(0));
    if (all.length) {
      this.dispatchQueuedOps(all, (op) =>
        this.dispatchPeerOperation(
          op.op,
          op.args,
          op.data ?? new Uint8Array(),
          op.op === "readdirPage" ? this.dirEpoch : op.responseCookieTag,
          op.cancelled,
        ),
      );
    }
    this.notifyFailoverReadyWaiters();
  }

  private drainQueuedPeerOpsOnNewHost(): void {
    const all = this.peerRetryQueue.splice(0).concat(this.peerFailoverQueue.splice(0));
    this.dispatchQueuedOps(all, (op) =>
      this.executeLocalOnHost(
        op.op,
        op.args,
        op.data ?? new Uint8Array(),
        op.op === "readdirPage" ? this.dirEpoch : undefined,
        op.cancelled,
      ),
    );
    this.notifyFailoverReadyWaiters();
  }

  private failAllPeerWork(error: unknown): void {
    for (const [reqId, rpc] of Array.from(this.peerInFlightRpcs)) {
      this.peerInFlightRpcs.delete(reqId);
      rpc.reject(error);
    }
    for (const op of this.peerRetryQueue.splice(0)) op.reject(error);
    for (const op of this.peerFailoverQueue.splice(0)) op.reject(error);
    this.wakePeerCreditWaiters();
    this.notifyFailoverReadyWaiters();
  }

  // ---------------------------------------------------------------------------
  // Handle, Watch, & Lock Bookkeeping Helpers
  // ---------------------------------------------------------------------------

  private ensureLocalHandle(
    fileId: bigint,
    remoteHandle: number,
    remoteTerm: bigint,
    remoteSessionId: string | undefined,
    pinToken: number | undefined,
    unlinked?: boolean,
  ): LocalHandleEntry {
    if (unlinked) this.unlinkEvents++;
    const existing = this.byFileId.get(fileId);
    if (existing) {
      if (remoteSessionId !== undefined && pinToken !== undefined) {
        if (
          existing.remoteTerm === remoteTerm &&
          existing.remoteSessionId === remoteSessionId &&
          existing.pinToken !== undefined &&
          existing.pinToken !== pinToken
        ) {
          // Canonical handle already pinned for this (term, session) -> unpin redundant token!
          this.enqueueSettlement(remoteSessionId, { kind: "unpin", pinToken });
        } else {
          existing.remoteHandle = remoteHandle;
          existing.remoteTerm = remoteTerm;
          existing.remoteSessionId = remoteSessionId;
          existing.pinToken = pinToken;
          existing.stale = false;
        }
      } else if (this.role === "host" && this.persistent) {
        if (existing.remoteHandle === undefined || existing.remoteTerm !== remoteTerm) {
          this.persistent.retain(remoteHandle);
          existing.remoteHandle = remoteHandle;
          existing.remoteTerm = remoteTerm;
          existing.stale = false;
        }
      }
      if (unlinked !== undefined) existing.unlinked = unlinked;
      return existing;
    }

    const localHandle = this.nextLocalHandle++;
    if (remoteSessionId === undefined && this.role === "host" && this.persistent) {
      this.persistent.retain(remoteHandle);
    }
    const entry: LocalHandleEntry = {
      localHandle,
      fileId,
      remoteHandle,
      remoteTerm,
      remoteSessionId,
      pinToken,
      stale: false,
      unlinked: !!unlinked,
      serviceRefs: 0,
      provisional: 0,
    };
    this.byLocalHandle.set(localHandle, entry);
    this.byFileId.set(fileId, entry);
    return entry;
  }

  private maybeReleaseLocalHandle(entry: LocalHandleEntry): void {
    if (entry.serviceRefs > 0 || entry.provisional > 0) return;
    if (!this.byLocalHandle.delete(entry.localHandle)) return;
    this.byFileId.delete(entry.fileId);
    if (this.peerRebinding) entry.releasedDuringRebind = true;

    if (
      this.role === "host" &&
      entry.remoteHandle !== undefined &&
      entry.remoteTerm === this.hostTerm
    ) {
      this.persistent?.release(entry.remoteHandle);
    } else if (
      this.role === "peer" &&
      entry.pinToken !== undefined &&
      entry.remoteSessionId !== undefined &&
      entry.remoteSessionId === this.peerSessionId
    ) {
      this.enqueueSettlement(entry.remoteSessionId, {
        kind: "unpin",
        pinToken: entry.pinToken,
      });
    }
  }

  private detachHandlesForRemount(): void {
    this.unlinkEvents++;
    for (const entry of this.byLocalHandle.values()) {
      entry.remoteHandle = undefined;
      entry.remoteTerm = undefined;
      entry.remoteSessionId = undefined;
      entry.pinToken = undefined;
    }
  }

  private extractReturnedLocalHandles(operation: string, value: unknown): number[] {
    if (operation === "preopen" && typeof value === "number") return [value];
    if (operation === "create" && typeof value === "number") return [value];
    if (operation === "resolve" && value && typeof value === "object") {
      const res = value as ResolvedPath;
      const out: number[] = [];
      if (typeof res.parent === "number") out.push(res.parent);
      if (typeof res.node === "number" && res.node !== res.parent) out.push(res.node);
      return out;
    }
    return [];
  }

  private resolveLocalHandle(
    localHandle: number,
    expectedTerm: bigint,
    expectedSessionId?: string,
  ): number | undefined {
    const entry = this.byLocalHandle.get(localHandle);
    if (!entry || entry.stale || entry.remoteHandle === undefined) return undefined;
    if (entry.remoteTerm !== expectedTerm) return undefined;
    if (expectedSessionId !== undefined && entry.remoteSessionId !== expectedSessionId)
      return undefined;
    return entry.remoteHandle;
  }

  private translateArgsToHost(operation: string, args: any[]): any[] | undefined {
    return this.translateArgs(operation, args, this.hostTerm, undefined);
  }

  private translateArgsToPeer(
    operation: string,
    args: any[],
    term: bigint,
    sessionId: string,
  ): any[] | undefined {
    return this.translateArgs(operation, args, term, sessionId);
  }

  private translateArgs(
    operation: string,
    args: any[],
    term: bigint,
    sessionId: string | undefined,
  ): any[] | undefined {
    const mapHandle = (h: number | undefined): number | undefined => {
      if (h === undefined) return undefined;
      return this.resolveLocalHandle(h, term, sessionId);
    };
    const mapResolved = (rp: ResolvedPath): ResolvedPath | undefined => {
      const parent = rp.parent !== undefined ? mapHandle(rp.parent) : undefined;
      if (rp.parent !== undefined && parent === undefined) return undefined;
      const node = rp.node !== undefined ? mapHandle(rp.node) : undefined;
      if (rp.node !== undefined && node === undefined) return undefined;
      return { ...rp, parent, node };
    };

    switch (operation) {
      case "sync":
      case "stat":
      case "readlink":
      case "permissions":
      case "setMode":
      case "read":
      case "write":
      case "append":
      case "grow":
      case "resize":
      case "setTimes":
      case "readdir":
      case "readdirPage":
      case "resolve":
      case "realpath": {
        const remote = mapHandle(args[0]);
        if (remote === undefined) return undefined;
        return [remote, ...args.slice(1)];
      }
      case "create":
      case "symlink":
      case "removePath": {
        const rp = mapResolved(args[0]);
        if (!rp) return undefined;
        return [rp, ...args.slice(1)];
      }
      case "link":
      case "rename": {
        const from = mapResolved(args[0]);
        const to = mapResolved(args[1]);
        if (!from || !to) return undefined;
        return [from, to, ...args.slice(2)];
      }
      default:
        return args;
    }
  }

  private advanceDirEpoch(): void {
    if (this.dirEpoch < DIR_EPOCH_MAX) this.dirEpoch++;
  }

  private markLocalWatchesOverflow(): void {
    this.hostWatchToLocal.clear();
    for (const watch of this.localWatches.values()) {
      watch.overflowed = true;
    }
    this.wakeWatchWord();
  }

  private beginFreshAttempt(): string {
    const attemptId = crypto.randomUUID();
    this.currentAttemptId = attemptId;
    this.leaseClosed = false;
    this.leaseMonoDeadline = 0;
    this.leaseWallDeadline = 0;
    this.ownershipLost = false;
    this.steppingDown = false;
    return attemptId;
  }

  /** Strict Acquire Order: 1. aliveLock(attemptId), 2. attach-claim(attemptId, mode). */
  private async acquireAttemptLocks(
    attemptId: string,
    mode: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.aliveLock = await acquireHeldLock(this.locks, aliveLockName(this.scope, attemptId), {
      mode: "exclusive",
      signal,
    });
    try {
      this.attachClaimLock = await acquireHeldLock(
        this.locks,
        attachClaimLockName(this.scope, attemptId, mode),
        { mode: "exclusive", signal },
      );
    } catch (error) {
      const alive = this.aliveLock;
      this.aliveLock = undefined;
      await alive?.release();
      throw error;
    }
  }

  /** Strict Release Order: 1. storageLock (already released), 2. attach-claim, 3. aliveLock, 4. electionLock. */
  private async releaseAttemptAndElectionLocks(): Promise<void> {
    const claim = this.attachClaimLock;
    this.attachClaimLock = undefined;
    await claim?.release();

    const alive = this.aliveLock;
    this.aliveLock = undefined;
    await alive?.release();

    const election = this.electionLock;
    this.electionLock = undefined;
    await election?.release();
  }

  private async releasePeerAliveLock(): Promise<void> {
    const lock = this.peerAliveLock;
    this.peerAliveLock = undefined;
    await lock?.release();
  }

  private closePeerChannelOnly(): void {
    const ch = this.peerChannel;
    const sid = this.peerSessionId;
    const term = this.peerHostTerm;
    this.peerChannel = undefined;
    this.peerAttached = false;
    this.peerSessionId = undefined;
    if (ch) {
      if (sid && term !== undefined) {
        try {
          ch.postMessage({
            kind: "detach",
            hostTerm: formatTerm(term),
            sessionId: sid,
          } satisfies PeerMessage);
        } catch {
          /* ignore */
        }
      }
      ch.onmessage = null;
      ch.onmessageerror = null;
      ch.close();
    }
  }

  private async cleanupPeerAndControlChannels(closeControl: boolean): Promise<void> {
    this.closePeerChannelOnly();
    if (closeControl && !this.terminalFailure) {
      this.controlChannel.onmessage = null;
      this.controlChannel.onmessageerror = null;
      this.controlChannel.close();
    }
  }

  private async cleanupStartupFailure(): Promise<boolean> {
    this.stopHostTimers();
    this.stopPeerTimers();
    if (this.terminalFailure) return false;
    const heldStill = await this.isStorageLockHeldBySelf();
    if (heldStill) return false;
    await this.cleanupPeerAndControlChannels(true);
    await this.releaseAttemptAndElectionLocks();
    await this.releasePeerAliveLock();
    return true;
  }

  private captureRetainedSegments(backend: PersistentBackend): void {
    const segments = backend.sharedSegments();
    for (const seg of segments) {
      this.retainedSegments[seg.index - 1] = seg.buffer;
    }
  }

  private isBusyError(error: unknown): boolean {
    return (
      !!error &&
      typeof error === "object" &&
      Reflect.get(error, "name") === "IndexedDBStorageBusyError"
    );
  }

  private notifyState(status: "waiting" | "ready"): void {
    if (status === "waiting") this.options.onWaiting?.();
    this.options.onState?.(status);
  }

  private failTabWithFatal(error: unknown, released: boolean): void {
    this.role = "failed";
    this.phase = "failed";
    this.stopHostTimers();
    this.stopPeerTimers();
    this.failAllPeerWork(error);
    this.markLocalWatchesOverflow();
    this.options.onFatalError?.(error, released);
  }
}
