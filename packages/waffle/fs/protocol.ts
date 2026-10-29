import { wakeFilesystemWatch } from "./watch-ring.js";
import { FilesystemSection } from "./section.js";
export { FilesystemSection, isRevoked } from "./section.js";
import { workspacePublication, type WorkspaceConfiguration } from "./workspace-protocol.js";
import {
  BigIntConstructor,
  bigintToString,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  Uint8ArrayConstructor,
  objectDefineProperty,
} from "../proc/intrinsics.js";
import type { ResidentDescriptor } from "./publication-grant.js";
import {
  createPublicationBuffers,
  publicationBufferPlan,
  PublicationDomain,
  forkPublication,
} from "./publication.js";
import type { PublicationConfiguration, PublicationConnection } from "./publication-internal.js";
import { FilesystemError } from "../core/filesystem.js";
import {
  createRequestBudget,
  FilesystemRequestPool,
  REQUEST_BUDGET_BYTES,
  REQUEST_CONTROL_BYTES,
  REQUEST_HEADER,
  type FilesystemRequestMemory,
} from "./request-memory.js";
import {
  DEFAULT_SHARED_MAX_BYTES,
  SHARED_SEGMENT_BYTES,
  MAX_SHARED_SEGMENTS,
} from "./shared-capacity.js";
export {
  DEFAULT_SHARED_MAX_BYTES,
  SHARED_SEGMENT_BYTES,
  MAX_SHARED_SEGMENTS,
  PAGE,
} from "./shared-capacity.js";
export { FilesystemError } from "../core/filesystem.js";
// Original shared-memory protocol. Ports schedule work; request/response bytes and completion
// state live in the SAB. The service never waits on a guest, including a terminated one.
// Guest browser-engine polyfills replace MessageChannel; transport endpoints must stay native.
const NativeMessageChannel = globalThis.MessageChannel;
export type GrowableSharedSegment = SharedArrayBuffer & {
  readonly growable: boolean;
  readonly maxByteLength: number;
  grow(byteLength: number): void;
};
export function createSharedSegment(): GrowableSharedSegment {
  // The runtime supports growable SABs; ES2022's library declarations do not yet expose them.
  const Constructor = SharedArrayBuffer as unknown as new (
    bytes: number,
    options: { maxByteLength: number },
  ) => GrowableSharedSegment;
  return new Constructor(0, { maxByteLength: SHARED_SEGMENT_BYTES });
}
export function normalizeSharedMaxBytes(maxBytes: number): number {
  if (Number.isNaN(maxBytes)) throw new RangeError("invalid shared filesystem storage cap");
  return (
    Math.max(1, Math.min(MAX_SHARED_SEGMENTS, Math.floor(maxBytes / SHARED_SEGMENT_BYTES))) *
    SHARED_SEGMENT_BYTES
  );
}
export const HEADER = REQUEST_HEADER;
export const TRANSIENT_HANDLES = 256;
export const CAPABILITY_SLOTS = 4096;
// One candidate-count word, then reusable [handle, open-reference count, transfer count] records. A negative
// reference count revokes an entry. Handles never recycle, but these per-session entries do.
export const CAPABILITY_HEADER = 1;
export const CAPABILITY_WORDS = 3;
export const MAX_CONNECTION_OWNERS = 65536;
export const CONNECTION_SHARED_BYTES = 64 * 1024 * 1024;
export const CAPABILITY_LENGTH = CAPABILITY_HEADER + CAPABILITY_SLOTS * CAPABILITY_WORDS;
export const enum State {
  Pending,
  Complete,
  Cancelled,
  Failed,
  Overflow,
}
export interface FilesystemConnection {
  residentPublication?: ResidentDescriptor;
  publication?: PublicationConnection;
  port: MessagePort;
  requests: FilesystemRequestMemory;
  requestBudget: SharedArrayBuffer;
  epoch: SharedArrayBuffer;
  signal: SharedArrayBuffer;
  /** This connection's revocation word, then its ancestors. Never reused. */
  revocations: SharedArrayBuffer[];
  shared: SharedArrayBuffer;
  /** Extra data segments, published before guests run; only the service grows their backing. */
  segments: SharedArrayBuffer[];
  /** Private to this connection, not its descendants: capabilities and local open references. */
  capabilities: SharedArrayBuffer;
  /** Active synchronous host filesystem sections, private to this connection. Never reused. */
  sections: SharedArrayBuffer;
  /** Nonzero lock owner token; service clears it when this identity is reaped. */
  owner: number;
  maxBytes: number;
  /** Service revocation in word 0, then per-owner liveness for independent process identities. */
  ownerStates: SharedArrayBuffer;
  /** Synchronous reservations adopted when this identity reaches the service. */
  reservations: FilesystemReservation[];
}
export interface FilesystemReservation {
  handle: number;
  source: SharedArrayBuffer;
  sourceKey: number;
  target: SharedArrayBuffer;
  targetKey: number;
  targetOwner: number;
  /** Closed once; transfer state: 0 pending, 1 adopted, 2 cancelled. */
  state: SharedArrayBuffer;
}
export type FilesystemIdentity = Omit<FilesystemConnection, "port" | "requests">;
export interface FilesystemOwnerConstruction {
  readonly shared: SharedArrayBuffer;
  allocateShared(bytes: number, maximum?: number): SharedArrayBuffer;
}
export function filesystemOwnerPlan(publication: PublicationConfiguration) {
  const arena = publicationBufferPlan(publication.limits, publication.observe);
  const allocations = 9 + MAX_SHARED_SEGMENTS - 1 + arena.allocations;
  return {
    bytes:
      MAX_CONNECTION_OWNERS * 4 +
      CAPABILITY_LENGTH * 4 +
      20 +
      arena.bytes +
      REQUEST_BUDGET_BYTES +
      REQUEST_CONTROL_BYTES,
    allocations,
    references: allocations,
    leases: 0,
  };
}
function identitySegments(
  parent: FilesystemIdentity | undefined,
  maxBytes: number,
  construction: FilesystemOwnerConstruction | undefined,
): SharedArrayBuffer[] {
  return (
    parent?.segments ??
    Array.from({ length: maxBytes / SHARED_SEGMENT_BYTES - 1 }, () =>
      construction ? construction.allocateShared(0, SHARED_SEGMENT_BYTES) : createSharedSegment(),
    )
  );
}
/** Guests can allocate a child identity while blocked; its controller creates the ports.
 * Firefox does not activate guest-created channels until that guest returns to its event loop.
 */
export function createFilesystemIdentity(
  parent?: FilesystemIdentity,
  maxBytes = DEFAULT_SHARED_MAX_BYTES,
  publication?: PublicationConfiguration | WorkspaceConfiguration,
  construction?: FilesystemOwnerConstruction,
): FilesystemIdentity {
  if (construction && parent) throw new TypeError("owner construction cannot fork an identity");
  const allocate = (bytes: number) =>
    construction ? construction.allocateShared(bytes) : new SharedArrayBuffer(bytes);
  maxBytes = parent?.maxBytes ?? normalizeSharedMaxBytes(maxBytes);
  const shared =
    parent?.shared ?? construction?.shared ?? new SharedArrayBuffer(CONNECTION_SHARED_BYTES);
  const segments = identitySegments(parent, maxBytes, construction);
  const owner = Atomics.add(new Int32Array(shared), 5, 1) + 1;
  if (owner >= MAX_CONNECTION_OWNERS)
    throw new FilesystemError(33, "filesystem identity table exhausted");
  const ownerStates = parent?.ownerStates ?? allocate(MAX_CONNECTION_OWNERS * 4);
  const workspace = parent?.residentPublication?.kind === "workspace";
  const capabilityBytes = (CAPABILITY_LENGTH + (workspace ? 1 : 0)) * 4;
  const capabilities = construction
    ? construction.allocateShared(capabilityBytes)
    : new SharedArrayBufferConstructor(capabilityBytes);
  const entries = new Int32ArrayConstructor(capabilities, 0, CAPABILITY_LENGTH);
  entries.fill(-1);
  entries[0] = 0;
  if (workspace) new Int32ArrayConstructor(capabilities, CAPABILITY_LENGTH * 4, 1)[0] = 0;
  const domain = identityPublication(parent, publication, owner, construction);
  return {
    ...(domain ? { publication: domain } : {}),
    ...(parent?.residentPublication ? { residentPublication: parent.residentPublication } : {}),
    epoch: parent?.epoch ?? allocate(4),
    requestBudget: parent?.requestBudget ?? createRequestBudget(construction),
    // Every descendant waits here too, so root revocation can wake blocked guests after a crash.
    signal: parent?.signal ?? allocate(4),
    revocations: [allocate(4)].concat(parent?.revocations ?? []),
    shared,
    segments,
    capabilities,
    sections: allocate(8),
    owner,
    maxBytes,
    ownerStates,
    reservations: [],
  };
}
function identityPublication(
  parent: FilesystemIdentity | undefined,
  publication: PublicationConfiguration | WorkspaceConfiguration | undefined,
  owner: number,
  construction: FilesystemOwnerConstruction | undefined,
): PublicationConnection | undefined {
  let domain: PublicationConnection | undefined;
  if (parent?.publication)
    domain = forkPublication(parent.publication, parent.owner, new FilesystemSection(parent));
  else if (!parent && publication) {
    const configuration = "workspace" in publication ? workspacePublication : publication;
    const buffers = createPublicationBuffers(configuration.limits, configuration.observe, {
      checkpoint: configuration.restore,
      ...(construction ? { backing: { kind: "construction", construction } } : {}),
    });
    const session = new PublicationDomain(buffers, owner).openSession();
    domain = {
      buffers,
      session,
      ...(configuration.observe ? { observer: crypto.randomUUID() } : {}),
    };
  }
  return domain;
}
/** Processes share storage, not the lifetime of the process that spawned them. */
export function createProcessFilesystemIdentity(parent: FilesystemIdentity): FilesystemIdentity {
  const identity = createFilesystemIdentity(parent);
  identity.revocations = identity.revocations.slice(0, 1);
  return identity;
}
/** Idempotent across the controller and guest copies of a transferred description. */
export function releaseFilesystemReservation(reservation: FilesystemReservation): void {
  const state = new Int32Array(reservation.state);
  if (Atomics.exchange(state, 0, 1)) return;
  const target = new Int32ArrayConstructor(reservation.target, 0, CAPABILITY_LENGTH);
  for (;;) {
    const count = Atomics.load(target, reservation.targetKey + 1);
    if (
      count <= 0 ||
      Atomics.compareExchange(target, reservation.targetKey + 1, count, count - 1) === count
    )
      break;
  }
  if (Atomics.compareExchange(state, 1, 0, 2) === 0)
    Atomics.sub(
      new Int32ArrayConstructor(reservation.source, 0, CAPABILITY_LENGTH),
      reservation.sourceKey + 2,
      1,
    );
}
export function reserveIdentityCapability(
  source: FilesystemIdentity,
  handle: number,
  target: FilesystemIdentity,
): FilesystemReservation {
  const section = new FilesystemSection(source);
  section.enter();
  try {
    return reserveCapability(source, handle, target);
  } finally {
    section.exit();
  }
}
function reserveCapability(
  source: FilesystemIdentity,
  handle: number,
  target: FilesystemIdentity,
): FilesystemReservation {
  const entries = new Int32Array(source.capabilities, 0, CAPABILITY_LENGTH);
  const destination = new Int32Array(target.capabilities, 0, CAPABILITY_LENGTH);
  let sourceKey = CAPABILITY_HEADER;
  while (
    sourceKey < entries.length &&
    (Atomics.load(entries, sourceKey) !== handle || Atomics.load(entries, sourceKey + 1) < 0)
  )
    sourceKey += CAPABILITY_WORDS;
  if (sourceKey === entries.length) throw new FilesystemError(76);
  Atomics.add(entries, sourceKey + 2, 1);
  try {
    if (Atomics.load(entries, sourceKey) !== handle || Atomics.load(entries, sourceKey + 1) < 0)
      throw new FilesystemError(76);
    let targetKey = CAPABILITY_HEADER;
    while (targetKey < destination.length && Atomics.load(destination, targetKey + 1) >= 0)
      targetKey += CAPABILITY_WORDS;
    if (targetKey === destination.length) throw new FilesystemError(51);
    const reservation = {
      handle,
      source: source.capabilities,
      sourceKey,
      target: target.capabilities,
      targetKey,
      targetOwner: target.owner,
      state: new SharedArrayBuffer(8),
    };
    Atomics.store(destination, targetKey, handle);
    Atomics.store(destination, targetKey + 2, 0);
    Atomics.store(destination, targetKey + 1, 1);
    target.reservations.push(reservation);
    return reservation;
  } catch (error) {
    Atomics.sub(entries, sourceKey + 2, 1);
    throw error;
  }
}
export function sameFilesystemIdentity(
  expected: FilesystemIdentity,
  incoming: Pick<FilesystemIdentity, "owner" | "sections">,
): boolean {
  if (expected.owner !== incoming.owner || incoming.sections.byteLength !== 8) return false;
  const own = new Int32Array(expected.sections),
    other = new Int32Array(incoming.sections);
  const previous = Atomics.load(own, 1);
  Atomics.store(own, 1, previous ^ -1);
  const same = Atomics.load(other, 1) === (previous ^ -1);
  Atomics.store(own, 1, previous);
  return same && Atomics.load(other, 1) === previous;
}
export function connectFilesystemIdentity(
  identity: FilesystemIdentity,
  pool = new FilesystemRequestPool(identity.requestBudget),
  construction?: FilesystemOwnerConstruction,
) {
  pool.assertBudget(identity.requestBudget);
  const requests = pool.take(identity.revocations[0]!, construction);
  const channel = new NativeMessageChannel();
  const pair = {
    client: { ...identity, port: channel.port1, requests },
    server: { ...identity, port: channel.port2, requests },
    pool,
  };
  const descriptor = { __proto__: null, value: pool, enumerable: false };
  objectDefineProperty(pair, "pool", descriptor);
  return pair;
}
export function createFilesystemConnection(
  parent?: FilesystemIdentity,
  publication?: PublicationConfiguration | WorkspaceConfiguration,
  construction?: FilesystemOwnerConstruction,
) {
  const identity = createFilesystemIdentity(parent, undefined, publication, construction);
  return connectFilesystemIdentity(identity, undefined, construction);
}
/** The service lifetime is shared even by processes with independent parent lifetimes. */
export function revokeFilesystemService(connection: FilesystemIdentity): void {
  Atomics.store(new Int32Array(connection.ownerStates), 0, 1);
  wakeFilesystemWatch(connection.shared);
  wake(connection);
}
export function revokeFilesystem(connection: FilesystemIdentity): void {
  Atomics.compareExchange(new Int32Array(connection.revocations[0]!), 0, 0, 1);
  Atomics.compareExchange(new Int32Array(connection.ownerStates), connection.owner, 0, 1);
  wakeFilesystemWatch(connection.shared);
  wake(connection);
}
/** Revokes synchronously, then waits without blocking the supervisor's event loop. Resolving
 * proves this identity cannot touch filesystem storage again, even if its worker is still alive.
 * Descendants have their own sections; their controllers must quiesce each identity separately. */
export async function waitForFilesystemQuiescence(connection: FilesystemIdentity): Promise<void> {
  revokeFilesystem(connection);
  const cells = new Int32Array(connection.sections);
  const revocation = new Int32Array(connection.revocations[0]!);
  const asyncAtomics = Atomics as typeof Atomics & {
    waitAsync(
      array: Int32Array,
      index: number,
      value: number,
    ): { async: boolean; value: string | Promise<string> };
  };
  for (;;) {
    const observed = Atomics.load(cells, 0);
    if (!observed || Atomics.load(revocation, 0) === 2) return;
    const waiting = asyncAtomics.waitAsync(cells, 0, observed);
    // A proven-dead reap may have notified between the check and registration without
    // changing an abandoned count. Recheck after registration and release that waiter too.
    if (Atomics.load(revocation, 0) === 2) {
      Atomics.notify(cells, 0);
      return;
    }
    if (waiting.async) await waiting.value;
  }
}
/** Call only after the guest has stopped, after waitForFilesystemQuiescence(), or from its own
 * quiescent dispose path. A stopped worker can leave an unfinished section and abandoned locks. */
export function reapFilesystem(connection: FilesystemIdentity): void {
  Atomics.store(new Int32Array(connection.revocations[0]!), 0, 2);
  Atomics.store(new Int32Array(connection.ownerStates), connection.owner, 2);
  wakeFilesystemWatch(connection.shared);
  if (connection.publication)
    new PublicationDomain(connection.publication.buffers).retireSession(
      connection.publication.session,
    );
  Atomics.notify(new Int32Array(connection.sections), 0);
  wake(connection);
}
export function wake(connection: FilesystemIdentity): void {
  const signal = new Int32Array(connection.signal);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function pack(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, storedTransportValue));
}
function storedTransportValue(_key: string, item: unknown): unknown {
  if (item === undefined) return { $undefined: true };
  if (typeof item === "bigint") return { $bigint: bigintToString(item) };
  if (item instanceof Uint8ArrayConstructor) return { $bytes: Array.from(item) };
  if (item instanceof Map) return { $map: Array.from(item) };
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  // Replacer results are not visited again. Escape literal records before their children
  // are encoded, so even bare tags and nested escape records retain their meaning.
  if (
    "$undefined" in item ||
    "$bigint" in item ||
    "$bytes" in item ||
    "$map" in item ||
    "$record" in item
  )
    return { $record: Object.entries(item) };
  return item;
}
export function unpack(bytes: Uint8Array): any {
  const value: unknown = JSON.parse(
    decoder.decode(
      Reflect.get(bytes.buffer, "resizable") ||
        Object.prototype.toString.call(bytes.buffer) === "[object SharedArrayBuffer]"
        ? new Uint8Array(bytes)
        : bytes,
    ),
  );
  return transportValue(value);
}
function transportRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new FilesystemError(28, "invalid record transport value");
  const entries: [string, unknown][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
      throw new FilesystemError(28, "invalid record transport entry");
    const decoded = transportValue(entry[1]);
    if (decoded !== undefined) entries.push([entry[0], decoded]);
  }
  return Object.fromEntries(entries);
}
function transportArray(value: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  result.length = value.length;
  for (let index = 0; index < value.length; index++) {
    const decoded = transportValue(value[index]);
    // Match JSON reviver deletion without erasing unvalidated byte positions.
    if (decoded !== undefined) result[index] = decoded;
  }
  return result;
}
function transportMap(value: unknown): Map<unknown, unknown> {
  if (!Array.isArray(value)) throw new FilesystemError(28, "invalid map transport value");
  const entries: [unknown, unknown][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw new FilesystemError(28, "invalid map transport entry");
    entries.push([transportValue(entry[0]), transportValue(entry[1])]);
  }
  return new Map(entries);
}
function transportValue(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  if (Array.isArray(item)) return transportArray(item);
  if ("$record" in item) return transportRecord(item.$record);
  if ("$undefined" in item) {
    if (item.$undefined !== true)
      throw new FilesystemError(28, "invalid undefined transport value");
    return undefined;
  }
  if ("$map" in item) return transportMap(item.$map);
  if ("$bigint" in item) {
    if (typeof item.$bigint !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(item.$bigint))
      throw new FilesystemError(28, "invalid bigint transport value");
    return BigIntConstructor(item.$bigint);
  }
  if ("$bytes" in item) return transportBytes(item.$bytes);
  return transportRecord(Object.entries(item));
}
function transportBytes(value: unknown): Uint8Array {
  if (!Array.isArray(value)) throw new FilesystemError(28, "invalid byte transport value");
  for (let index = 0; index < value.length; index++) {
    const byte: unknown = value[index];
    if (
      !Object.hasOwn(value, index) ||
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    )
      throw new FilesystemError(28, "invalid byte transport value");
  }
  return new Uint8ArrayConstructor(value);
}
export type RequestMessage =
  | { id: number; generation: number; offset: number; length: number }
  | { transportClosed: true }
  | { sweep: true }
  | { trim: true }
  | { discard: number };
export function errno(error: unknown): number {
  if (error instanceof FilesystemError) return error.errno;
  if (error instanceof RangeError) return 22; // EFBIG
  if (
    (error as { code?: unknown })?.code === "ENOSPC" ||
    (error as { name?: unknown })?.name === "QuotaExceededError"
  )
    return 51;
  return 29; // EIO, never invent ENOENT for an internal failure.
}
