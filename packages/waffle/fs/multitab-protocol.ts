import { FilesystemError, pack } from "./protocol.js";

/** Maximum payload bytes in a single BroadcastChannel RPC frame. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Minimum sender-side frame credit grant per admitted peer. */
export const MIN_PEER_FRAMES = 2;
/** Minimum sender-side byte credit grant per admitted peer (guarantees any valid <= 1 MiB frame). */
export const MIN_PEER_BYTES = 1024 * 1024;
/** Global Host wire-credit frame pool across all attached peers (supports up to 16 peers). */
export const MAX_HOST_FRAMES = 64;
/** Global Host wire-credit byte pool across all attached peers (16 MiB). */
export const MAX_HOST_WIRE_BYTES = 16 * 1024 * 1024;
/** Default target grant per peer when global pool headroom allows. */
export const DEFAULT_PEER_FRAMES = 4;
/** Default target byte grant per peer when global pool headroom allows (2 MiB). */
export const DEFAULT_PEER_BYTES = 2 * MAX_FRAME_BYTES;
/** Global Host staged upload pool cap across all peers (32 MiB). */
export const MAX_STAGED_UPLOAD_BYTES = 32 * 1024 * 1024;
/** Global Host staged download pool cap across all peers (32 MiB). */
export const MAX_STAGED_DOWNLOAD_BYTES = 32 * 1024 * 1024;
/** Max concurrent staged uploads per peer. */
export const MAX_CONCURRENT_UPLOADS_PER_PEER = 4;
/** Max concurrent staged downloads per peer. */
export const MAX_CONCURRENT_DOWNLOADS_PER_PEER = 4;
/** Hard per-session cap on pending settlement items (unpins + watchAcks + watchCloses). */
export const MAX_PENDING_SETTLEMENTS = 1024;
/** Flush threshold for Host immediate batched settlement confirmations. */
export const SETTLEMENT_BATCH_SIZE = 32;
/** Maximum settlement entries piggybacked on a single heartbeat ping/pong. */
export const PONG_SETTLEMENT_LIMIT = 256;
/** Maximum 16-bit local directory cookie epoch before EOVERFLOW (never wraps). */
export const DIR_EPOCH_MAX = 0xffffn;
/** Low 48-bit mask for untagged MemFS/DirectoryPages cookies. */
const COOKIE_LOW_MASK = 0xffffffffffffn;
/** Slab granularity (64 KiB) for incremental bounded wire-encoding budget reservations. */
const WIRE_BUDGET_SLAB_BYTES = 64 * 1024;

export interface MultiTabTimings {
  readonly leaseDurationMs: number;
  readonly leaseRenewMs: number;
  readonly leaseClockSafetyMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly confirmGraceMs: number;
  readonly attachRetryMs: number;
  readonly waitPollMs: number;
  readonly recoverTimeoutMs: number;
  readonly drainGraceMs: number;
  readonly attachIdleTimeoutMs: number;
}

const DEFAULT_MULTITAB_TIMINGS: MultiTabTimings = Object.freeze({
  leaseDurationMs: 1200,
  leaseRenewMs: 400,
  leaseClockSafetyMs: 200,
  heartbeatIntervalMs: 800,
  heartbeatTimeoutMs: 2400,
  confirmGraceMs: 400,
  attachRetryMs: 300,
  waitPollMs: 150,
  recoverTimeoutMs: 2000,
  drainGraceMs: 150,
  attachIdleTimeoutMs: 2400 * 3,
});

export function resolveMultiTabTimings(overrides?: Partial<MultiTabTimings>): MultiTabTimings {
  if (!overrides) return DEFAULT_MULTITAB_TIMINGS;
  const heartbeatTimeoutMs =
    overrides.heartbeatTimeoutMs ?? DEFAULT_MULTITAB_TIMINGS.heartbeatTimeoutMs;
  return Object.freeze({
    ...DEFAULT_MULTITAB_TIMINGS,
    ...overrides,
    attachIdleTimeoutMs: overrides.attachIdleTimeoutMs ?? heartbeatTimeoutMs * 3,
  });
}

export type MultiTabImplementation = "indexeddb" | "opfs-memory";

export function multitabScope(implementation: MultiTabImplementation, name: string): string {
  return `${implementation}:${encodeURIComponent(name)}`;
}
export function controlChannelName(scope: string): string {
  return `waffle:multitab:v1:ctrl:${scope}`;
}
export function peerChannelName(scope: string, hostTerm: bigint, peerId: string): string {
  return `waffle:multitab:v1:peer:${scope}:${hostTerm.toString(16)}:${peerId}`;
}
export function electionLockName(scope: string): string {
  return `waffle:multitab:v1:host:${scope}`;
}
export function attachClaimPrefix(scope: string): string {
  return `waffle:multitab:v1:attach-claim:${scope}:`;
}
export function attachClaimLockName(scope: string, attemptId: string, mode: string): string {
  return `${attachClaimPrefix(scope)}${attemptId}:${mode}`;
}
export function parseAttachClaimAttemptId(scope: string, lockName: string): string | undefined {
  const prefix = attachClaimPrefix(scope);
  if (!lockName.startsWith(prefix)) return undefined;
  const rest = lockName.slice(prefix.length);
  const sep = rest.indexOf(":");
  return sep > 0 ? rest.slice(0, sep) : undefined;
}
export function aliveLockPrefix(scope: string): string {
  return `waffle:multitab:v1:alive:${scope}:`;
}
export function aliveLockName(scope: string, attemptId: string): string {
  return `${aliveLockPrefix(scope)}${attemptId}`;
}
export function peerAliveLockName(scope: string, peerId: string): string {
  return `waffle:multitab:v1:peer-alive:${scope}:${peerId}`;
}
export function recoverLockName(scope: string): string {
  return `waffle:multitab:v1:recover:${scope}`;
}
export function storageLockNameFor(implementation: MultiTabImplementation, name: string): string {
  return implementation === "indexeddb"
    ? `bun-wasm:filesystem:indexeddb:${name}`
    : `bun-wasm:filesystem:${name}`;
}
export function maintenanceLockNameFor(name: string): string {
  return `bun-wasm:filesystem:indexeddb-maintenance:${name}`;
}

export function formatTerm(term: bigint): string {
  return term.toString(16);
}
export function parseTerm(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]+$/i.test(value)) return undefined;
  try {
    return BigInt(`0x${value}`);
  } catch {
    return undefined;
  }
}

/** Error carrying an explicit confirmed-release outcome for worker -> page propagation. */
export class MultiTabReleaseError extends Error {
  readonly released: boolean;
  readonly errno?: number;
  constructor(message: string, released: boolean, cause?: unknown, code?: number) {
    super(message);
    this.name = "MultiTabReleaseError";
    this.released = released;
    if (cause !== undefined) this.cause = cause;
    if (code !== undefined) this.errno = code;
  }
}

export function describeReason(reason: unknown, fallback = "Filesystem storage failure"): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.length) return reason;
  try {
    const text = String(reason);
    return text.length ? text : fallback;
  } catch {
    return fallback;
  }
}

export function wrapReleaseError(
  reason: unknown,
  released: boolean,
  fallback = "Filesystem disposal failed",
): MultiTabReleaseError {
  const code = reason instanceof FilesystemError ? reason.errno : undefined;
  return new MultiTabReleaseError(describeReason(reason, fallback), released, reason, code);
}

/** Copy any SharedArrayBuffer-backed or sub-ranged Uint8Array into a plain unshared ArrayBuffer. */
export function unsharedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    !(bytes.buffer as { resizable?: boolean }).resizable &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  )
    return bytes as Uint8Array<ArrayBuffer>;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

const PURE_STATELESS_READ_OPS = new Set<string>([
  "readFile",
  "lookup",
  "listFiles",
  "resolvePath",
  "stat",
  "permissions",
  "read",
  "readdir",
  "readlink",
  "resolve",
  "realpath",
  "readdirPage",
]);

export function isReplayableRead(operation: string, args: readonly unknown[]): boolean {
  if (!PURE_STATELESS_READ_OPS.has(operation)) return false;
  if (operation === "readdirPage") {
    const cookie = args[1];
    if (typeof cookie === "bigint" && cookie >= 3n) return false;
  }
  return true;
}

/** Validate a client's directory cookie against currentDirEpoch and strip the high 16-bit tag. */
export function validateAndStripDirCookie(wireCookie: bigint, currentDirEpoch: bigint): bigint {
  if (wireCookie < 0n) throw new FilesystemError(28, "invalid directory cookie");
  if (wireCookie <= 2n) return wireCookie;
  const tag = wireCookie >> 48n;
  if (tag !== currentDirEpoch) throw new FilesystemError(8, "stale directory cookie");
  return wireCookie & COOKIE_LOW_MASK;
}

type HostPhaseAdvertisement = "opening" | "waiting-storage" | "retiring";
export type HostHealthState = "ready" | "draining" | "failed";

export interface PeerCreditLimit {
  readonly frames: number;
  readonly bytes: number;
}

export type ControlMessage =
  | { readonly kind: "discover"; readonly fromPeerId: string }
  | {
      readonly kind: "host-status";
      readonly attemptId: string;
      readonly clientId: string;
      readonly phase: HostPhaseAdvertisement;
      readonly hostTerm?: string;
    }
  | {
      readonly kind: "host-ready";
      readonly attemptId: string;
      readonly clientId: string;
      readonly hostTerm: string;
      readonly workspaceId: string;
      readonly storageEpoch: number;
      readonly lastExclusiveEpoch: number;
    }
  | {
      readonly kind: "host-draining";
      readonly attemptId: string;
      readonly hostTerm: string;
    }
  | {
      readonly kind: "host-stepping-down";
      readonly attemptId: string;
      readonly hostTerm: string;
    }
  | {
      readonly kind: "host-failed";
      readonly attemptId: string;
      readonly clientId: string;
      readonly hostTerm: string;
      readonly workspaceId: string;
      readonly message?: string;
    }
  | {
      readonly kind: "cooperative-step-down";
      readonly targetAttemptId: string;
      readonly targetTerm: string;
    }
  | {
      readonly kind: "external-takeover";
      readonly attemptId: string;
      readonly hostTerm: string;
      readonly workspaceId: string;
      readonly lastExclusiveEpoch: number;
      readonly affectedEpoch: number;
    }
  | {
      readonly kind: "workspace-replaced";
      readonly workspaceId: string;
      readonly expectedWorkspaceId: string;
    }
  | {
      readonly kind: "attach";
      readonly peerId: string;
      readonly sessionId: string;
      readonly hostTerm: string;
      readonly targetAttemptId?: string;
    };

export interface WirePinnedHandle {
  readonly remoteHandle: number;
  readonly fileId: bigint;
  readonly pinToken: number;
  readonly unlinked?: boolean;
}

export interface WireResolveResult {
  readonly parent?: WirePinnedHandle;
  readonly node?: WirePinnedHandle;
  readonly name: string;
  readonly trailingSlash: boolean;
  readonly terminalDot: boolean;
}

export type PeerMessage =
  | {
      readonly kind: "attached";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly creditLimit: PeerCreditLimit;
    }
  | {
      readonly kind: "attach-rejected";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly errno: number;
      readonly message?: string;
    }
  | {
      readonly kind: "credit-limit";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly creditLimit: PeerCreditLimit;
    }
  | {
      readonly kind: "req";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly reqId: number;
      readonly op: string;
      readonly args: unknown[];
      readonly data?: Uint8Array;
      readonly uploadId?: string;
      readonly totalBytes?: number;
      readonly responseCookieTag?: string;
    }
  | {
      readonly kind: "chunk-put";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly reqId: number;
      readonly uploadId: string;
      readonly offset: number;
      readonly totalBytes: number;
      readonly chunk: Uint8Array;
    }
  | {
      readonly kind: "chunk-abort";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly uploadId: string;
    }
  | {
      readonly kind: "chunk-get";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly reqId: number;
      readonly downloadId: string;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "res";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly reqId: number;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly data?: Uint8Array;
      readonly packed?: boolean;
      readonly binary?: boolean;
      readonly errno?: number;
      readonly message?: string;
      readonly retry?: true;
      readonly creditFrames?: number;
      readonly creditBytes?: number;
      readonly chunkedId?: string;
      readonly totalBytes?: number;
      readonly firstChunk?: Uint8Array;
      readonly ackId?: number;
    }
  | {
      readonly kind: "ping";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly pingId: number;
      readonly latestAckedWakeSeq: number;
      readonly pendingWatchAcks?: readonly (readonly [number, boolean])[];
      readonly pendingUnpins?: readonly number[];
      readonly pendingWatchCloses?: readonly number[];
      readonly pendingUploadAborts?: readonly string[];
    }
  | {
      readonly kind: "pong";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly pingId: number;
      readonly activeReqIds: readonly number[];
      readonly latestWakeSeq: number;
      readonly settledWatchAcks?: readonly number[];
      readonly settledUnpins?: readonly number[];
      readonly settledWatchCloses?: readonly number[];
      readonly settledUploadAborts?: readonly string[];
      readonly creditLimit: PeerCreditLimit;
      readonly hostState: HostHealthState;
    }
  | {
      readonly kind: "watch-wake";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly wakeSeq: number;
    }
  | {
      readonly kind: "watch-wake-ack";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly wakeSeq: number;
    }
  | {
      readonly kind: "watch-ack";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly ackId: number;
      readonly accepted: boolean;
    }
  | {
      readonly kind: "unpin";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly pinToken: number;
    }
  | {
      readonly kind: "watch-close";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly hostWatchId: number;
    }
  | {
      readonly kind: "settled";
      readonly hostTerm: string;
      readonly sessionId: string;
      readonly watchAcks?: readonly number[];
      readonly unpins?: readonly number[];
      readonly watchCloses?: readonly number[];
      readonly uploadAborts?: readonly string[];
    }
  | {
      readonly kind: "detach";
      readonly hostTerm: string;
      readonly sessionId: string;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isControlMessage(value: unknown): value is ControlMessage {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "discover":
      return typeof value.fromPeerId === "string";
    case "host-status":
      return (
        typeof value.attemptId === "string" &&
        typeof value.clientId === "string" &&
        (value.phase === "opening" ||
          value.phase === "waiting-storage" ||
          value.phase === "retiring")
      );
    case "host-ready":
      return (
        typeof value.attemptId === "string" &&
        typeof value.clientId === "string" &&
        typeof value.hostTerm === "string" &&
        typeof value.workspaceId === "string" &&
        typeof value.storageEpoch === "number" &&
        typeof value.lastExclusiveEpoch === "number"
      );
    case "host-draining":
    case "host-stepping-down":
      return typeof value.attemptId === "string" && typeof value.hostTerm === "string";
    case "host-failed":
      return (
        typeof value.attemptId === "string" &&
        typeof value.clientId === "string" &&
        typeof value.hostTerm === "string" &&
        typeof value.workspaceId === "string"
      );
    case "cooperative-step-down":
      return typeof value.targetAttemptId === "string" && typeof value.targetTerm === "string";
    case "external-takeover":
      return (
        typeof value.attemptId === "string" &&
        typeof value.hostTerm === "string" &&
        typeof value.workspaceId === "string" &&
        typeof value.lastExclusiveEpoch === "number" &&
        typeof value.affectedEpoch === "number"
      );
    case "workspace-replaced":
      return typeof value.workspaceId === "string" && typeof value.expectedWorkspaceId === "string";
    case "attach":
      return (
        typeof value.peerId === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.hostTerm === "string"
      );
    default:
      return false;
  }
}

function isValidCreditLimit(value: unknown): value is PeerCreditLimit {
  return (
    isObject(value) &&
    typeof value.frames === "number" &&
    Number.isInteger(value.frames) &&
    value.frames >= 0 &&
    typeof value.bytes === "number" &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0
  );
}

export function isPeerMessage(value: unknown): value is PeerMessage {
  if (
    !isObject(value) ||
    typeof value.kind !== "string" ||
    typeof value.hostTerm !== "string" ||
    typeof value.sessionId !== "string"
  )
    return false;
  switch (value.kind) {
    case "attached":
    case "credit-limit":
      return isValidCreditLimit(value.creditLimit);
    case "attach-rejected":
      return typeof value.errno === "number";
    case "req":
      return (
        typeof value.reqId === "number" && typeof value.op === "string" && Array.isArray(value.args)
      );
    case "chunk-put":
      return (
        typeof value.reqId === "number" &&
        typeof value.uploadId === "string" &&
        typeof value.offset === "number" &&
        typeof value.totalBytes === "number" &&
        value.chunk instanceof Uint8Array
      );
    case "chunk-abort":
      return typeof value.uploadId === "string";
    case "chunk-get":
      return (
        typeof value.reqId === "number" &&
        typeof value.downloadId === "string" &&
        typeof value.offset === "number" &&
        typeof value.length === "number"
      );
    case "res":
      return typeof value.reqId === "number" && typeof value.ok === "boolean";
    case "ping":
      return typeof value.pingId === "number" && typeof value.latestAckedWakeSeq === "number";
    case "pong":
      return (
        typeof value.pingId === "number" &&
        Array.isArray(value.activeReqIds) &&
        typeof value.latestWakeSeq === "number" &&
        isValidCreditLimit(value.creditLimit) &&
        (value.hostState === "ready" ||
          value.hostState === "draining" ||
          value.hostState === "failed")
      );
    case "watch-wake":
    case "watch-wake-ack":
      return typeof value.wakeSeq === "number";
    case "watch-ack":
      return typeof value.ackId === "number" && typeof value.accepted === "boolean";
    case "unpin":
      return typeof value.pinToken === "number";
    case "watch-close":
      return typeof value.hostWatchId === "number";
    case "settled":
    case "detach":
      return true;
    default:
      return false;
  }
}

const wireEncoder = new TextEncoder();

/** Incremental wire-byte builder that charges actual UTF-8 encoded JSON bytes in 64 KiB slabs
 * against the Host's staged download budget BEFORE allocating the final contiguous buffer. */
export class BoundedWireBuilder {
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private reservedBytes = 0;
  private finished = false;
  constructor(
    private readonly hardCapBytes: number,
    private readonly reserveSlab: (deltaBytes: number) => boolean,
    private readonly releaseAll: (bytes: number) => void,
  ) {}
  appendText(text: string): void {
    this.appendBytes(wireEncoder.encode(text));
  }
  appendPacked(value: unknown): void {
    this.appendBytes(pack(value));
  }
  appendBytes(chunk: Uint8Array): void {
    if (!chunk.byteLength) return;
    const nextTotal = this.totalBytes + chunk.byteLength;
    if (nextTotal > this.hardCapBytes) {
      this.abort();
      throw new FilesystemError(22, "wire response exceeds download cap");
    }
    if (nextTotal > this.reservedBytes) {
      const target = Math.min(
        this.hardCapBytes,
        Math.ceil(nextTotal / WIRE_BUDGET_SLAB_BYTES) * WIRE_BUDGET_SLAB_BYTES,
      );
      const delta = target - this.reservedBytes;
      if (!this.reserveSlab(delta)) {
        this.abort();
        throw new FilesystemError(6, "staged download pool exhausted");
      }
      this.reservedBytes = target;
    }
    this.chunks.push(chunk);
    this.totalBytes = nextTotal;
  }
  /** Assemble the exact wire buffer and return the currently reserved budget bytes. */
  finish(): { bytes: Uint8Array<ArrayBuffer>; reservedBytes: number } {
    this.finished = true;
    const out = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks.length = 0;
    return { bytes: out, reservedBytes: this.reservedBytes };
  }
  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.chunks.length = 0;
    if (this.reservedBytes > 0) {
      const bytes = this.reservedBytes;
      this.reservedBytes = 0;
      this.releaseAll(bytes);
    }
  }
}

export interface BroadcastChannelLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface LockManagerLike {
  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | Promise<T>),
    callback?: (lock: Lock | null) => T | Promise<T>,
  ): Promise<T>;
  query(): Promise<LockManagerSnapshot>;
}
