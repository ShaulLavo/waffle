import { FilesystemError } from "../core/filesystem.js";
import { FilesystemSection } from "./section.js";
import type { FilesystemIdentity } from "./protocol.js";
import type { ArenaSource, Headroom } from "../memory/reservations.js";
import {
  Int32ArrayConstructor,
  BigInt64ArrayConstructor,
  BigIntConstructor,
  Uint8ArrayConstructor,
  SharedArrayBufferConstructor,
  objectFreeze,
  atomicsLoad,
  atomicsStore,
  atomicsAdd,
  atomicsExchange,
  atomicsCompareExchange,
  atomicsNotify,
  atomicsWaitAsync,
  sharedArrayBufferByteLength,
  sharedArrayBufferMaxByteLength,
  sharedArrayBufferGrow,
  createGrowableSharedArrayBuffer,
  isSharedArrayBuffer,
} from "../proc/intrinsics.js";

export const REQUEST_HEADER = 32;
export const REQUEST_BUDGET_BYTES = 32;
export const REQUEST_CONTROL_BYTES = 64;
export const FALLBACK_REQUEST_CONNECTION_BYTES = 64 * 1024 * 1024;
/** @public Hard transport bounds; retained backing and live request counts are separate quotas. */
export const FILESYSTEM_REQUEST_LIMITS = objectFreeze({
  bytes: 8 * 2 ** 30,
  connectionBytes: 2 ** 31 - 4096,
  connections: 65536,
  outstanding: 1024,
  totalOutstanding: 4096,
} as const);
const PREFIX = 16;
const C = {
  generation: 0,
  closed: 1,
  used: 2,
  retired: 3,
  count: 4,
  bytes: 5,
  retirementError: 6,
  sections: 7,
} as const;
const B = { generation: 4, probe: 5, pending: 7 } as const;
export const REQUEST_CLIENT = 1,
  REQUEST_SERVICE = 2;

export interface FilesystemRequestMemory {
  readonly budget: SharedArrayBuffer;
  readonly control: SharedArrayBuffer;
  readonly data: SharedArrayBuffer;
  readonly generation: number;
}
export interface FilesystemRequestBuffer {
  readonly memory: FilesystemRequestMemory;
  readonly id: number;
  readonly offset: number;
  readonly length: number;
}
export function captureRequestMemory(memory: unknown): FilesystemRequestMemory {
  if (
    !memory ||
    typeof memory !== "object" ||
    !("generation" in memory) ||
    !("control" in memory) ||
    !("budget" in memory) ||
    !("data" in memory)
  )
    throw new FilesystemError(28, "invalid filesystem request memory");
  const generation = memory.generation,
    state = memory.control,
    budget = memory.budget,
    data = memory.data;
  if (
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation <= 0 ||
    generation > 65536 ||
    !isSharedArrayBuffer(state) ||
    sharedArrayBufferByteLength(state) !== REQUEST_CONTROL_BYTES ||
    !isSharedArrayBuffer(budget) ||
    sharedArrayBufferByteLength(budget) !== REQUEST_BUDGET_BYTES ||
    !isSharedArrayBuffer(data)
  )
    throw new FilesystemError(28, "invalid filesystem request memory");
  return objectFreeze({ budget, control: state, data, generation });
}

interface Construction {
  allocateShared(bytes: number, maximum?: number): SharedArrayBuffer;
}
export type RequestArenaAllocator = (bytes: number, maximum: number) => SharedArrayBuffer;
interface Arena {
  control: SharedArrayBuffer;
  readonly data: SharedArrayBuffer;
  revocation: SharedArrayBuffer;
  generation: number;
  stranded: boolean;
}
export class FilesystemTransportError extends FilesystemError {
  readonly code = "CLOSED";
  constructor(readonly reason: "messageerror" | "stale" | "protocol") {
    super(
      29,
      reason === "messageerror"
        ? "Filesystem connection could not deserialize a message"
        : reason === "protocol"
          ? "Filesystem connection received an invalid control message"
          : "Filesystem connection incarnation is closed",
    );
    this.name = "FilesystemTransportError";
  }
}
const MASK = 0xffffffffn;
function tagged(generation: number, value: number): bigint {
  return (BigIntConstructor(generation) << 32n) | BigIntConstructor(value);
}
function control(memory: FilesystemRequestMemory): BigInt64Array {
  return new BigInt64ArrayConstructor(memory.control);
}
function current(memory: FilesystemRequestMemory): boolean {
  return atomicsLoad(control(memory), C.generation) >> 32n === BigIntConstructor(memory.generation);
}
function get(memory: FilesystemRequestMemory, index: number): number {
  const word = atomicsLoad(control(memory), index);
  if (word >> 32n !== BigIntConstructor(memory.generation))
    throw new FilesystemTransportError("stale");
  return Number(word & MASK);
}
function update(
  memory: FilesystemRequestMemory,
  index: number,
  value: (previous: number) => number,
): void {
  const words = control(memory);
  for (;;) {
    const previous = atomicsLoad(words, index);
    if (previous >> 32n !== BigIntConstructor(memory.generation)) return;
    const next = tagged(memory.generation, value(Number(previous & MASK)));
    if (atomicsCompareExchange(words, index, previous, next) === previous) return;
  }
}
/** Connection fault admission complements, and never replaces, the identity's native-stop fence. */
export class FilesystemTransportSection extends FilesystemSection {
  private readonly signal: Int32Array;
  constructor(
    connection: FilesystemIdentity,
    private readonly memory: FilesystemRequestMemory,
    revoked: () => boolean,
  ) {
    super(connection, revoked);
    this.signal = new Int32ArrayConstructor(connection.signal);
  }
  override enter(): void {
    update(this.memory, C.sections, (value) => value + 1);
    const failure = requestTransportError(this.memory);
    if (failure) {
      this.leaveTransport();
      throw failure;
    }
    super.enter();
  }
  override exit(): void {
    super.exit();
    this.leaveTransport();
  }
  private leaveTransport(): void {
    update(this.memory, C.sections, (value) => value - 1);
    if (get(this.memory, C.sections)) return;
    atomicsAdd(this.signal, 0, 1);
    atomicsNotify(this.signal, 0);
  }
}
export async function waitForRequestQuiescence(
  connection: FilesystemIdentity,
  memory: FilesystemRequestMemory,
): Promise<void> {
  const signal = new Int32ArrayConstructor(connection.signal);
  for (;;) {
    const observed = atomicsLoad(signal, 0);
    if (
      !get(memory, C.sections) ||
      atomicsLoad(new Int32ArrayConstructor(connection.revocations[0]!), 0) === 2
    )
      return;
    const waiting = atomicsWaitAsync(signal, 0, observed);
    if (waiting.async) await waiting.value;
  }
}
export function requestTransportError(
  memory: FilesystemRequestMemory,
): FilesystemTransportError | undefined {
  if (!current(memory)) return new FilesystemTransportError("stale");
  const closed = get(memory, C.closed);
  return closed
    ? new FilesystemTransportError(
        closed === 2 ? "stale" : closed === 3 ? "protocol" : "messageerror",
      )
    : undefined;
}
export function closeRequestMemory(
  memory: FilesystemRequestMemory,
  reason: "messageerror" | "protocol" = "messageerror",
): void {
  update(memory, C.closed, (previous) => previous || (reason === "protocol" ? 3 : 1));
}
export function retireRequestMemory(memory: FilesystemRequestMemory, errno = 0): void {
  update(memory, C.retirementError, () => errno);
  update(memory, C.retired, () => 1);
}
export function createRequestBudget(
  construction?: Construction,
  maximum = FILESYSTEM_REQUEST_LIMITS.bytes,
): SharedArrayBuffer {
  const buffer =
    construction?.allocateShared(REQUEST_BUDGET_BYTES) ??
    new SharedArrayBufferConstructor(REQUEST_BUDGET_BYTES);
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < REQUEST_CONTROL_BYTES ||
    maximum > FILESYSTEM_REQUEST_LIMITS.bytes
  )
    throw new FilesystemError(28);
  atomicsStore(new BigInt64ArrayConstructor(buffer), 1, BigIntConstructor(maximum));
  return buffer;
}
function charge(budget: SharedArrayBuffer, bytes: number): void {
  const state = new BigInt64ArrayConstructor(budget);
  for (;;) {
    const before = atomicsLoad(state, 0);
    const next = before + BigIntConstructor(bytes);
    if (next > atomicsLoad(state, 1))
      throw new FilesystemError(48, "filesystem request memory quota exhausted");
    if (atomicsCompareExchange(state, 0, before, next) === before) return;
  }
}
function refund(budget: SharedArrayBuffer, bytes: number): void {
  atomicsAdd(new BigInt64ArrayConstructor(budget), 0, -BigIntConstructor(bytes));
}
export function retainResponseBytes(memory: FilesystemRequestMemory, bytes: number): () => void {
  charge(memory.budget, bytes);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    refund(memory.budget, bytes);
  };
}
function claimRequest(budget: SharedArrayBuffer): void {
  const words = new Int32ArrayConstructor(budget);
  for (;;) {
    const before = atomicsLoad(words, B.pending);
    if (before >= FILESYSTEM_REQUEST_LIMITS.totalOutstanding)
      throw new FilesystemError(6, "filesystem namespace outstanding request quota exhausted");
    if (atomicsCompareExchange(words, B.pending, before, before + 1) === before) return;
  }
}
function releaseCount(memory: FilesystemRequestMemory, bytes: number): void {
  const words = control(memory);
  for (;;) {
    const previous = atomicsLoad(words, C.count);
    if (previous >> 32n !== BigIntConstructor(memory.generation)) return;
    const count = Number(previous & MASK);
    if (
      atomicsCompareExchange(words, C.count, previous, tagged(memory.generation, count - 1)) !==
      previous
    )
      continue;
    atomicsAdd(new Int32ArrayConstructor(memory.budget), B.pending, -1);
    update(memory, C.bytes, (value) => value - bytes);
    return;
  }
}
function nextGeneration(budget: SharedArrayBuffer): number {
  const state = new Int32ArrayConstructor(budget);
  for (;;) {
    const previous = atomicsLoad(state, B.generation);
    if (previous >= 65536)
      throw new FilesystemError(33, "filesystem connection generations exhausted");
    if (atomicsCompareExchange(state, B.generation, previous, previous + 1) === previous)
      return previous + 1;
  }
}
export function assertRequestBudget(
  expected: SharedArrayBuffer,
  incoming: SharedArrayBuffer,
): void {
  if (sharedArrayBufferByteLength(incoming) !== REQUEST_BUDGET_BYTES) throw new FilesystemError(2);
  const own = new Int32ArrayConstructor(expected),
    other = new Int32ArrayConstructor(incoming);
  const previous = atomicsLoad(own, 6);
  atomicsStore(own, 6, previous ^ -1);
  const same = atomicsLoad(other, 6) === (previous ^ -1);
  atomicsStore(own, 6, previous);
  if (!same) throw new FilesystemError(2, "filesystem service request namespace mismatch");
}
export function requestBudgetBytes(budget: SharedArrayBuffer): number {
  return Number(atomicsLoad(new BigInt64ArrayConstructor(budget), 0));
}
function arenaMemory(arena: Arena, budget: SharedArrayBuffer): FilesystemRequestMemory {
  return {
    budget,
    control: arena.control,
    data: arena.data,
    generation: arena.generation,
  };
}
function validateConnectionBytes(bytes: number): number {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < REQUEST_HEADER ||
    bytes > FILESYSTEM_REQUEST_LIMITS.connectionBytes
  )
    throw new FilesystemError(28, "invalid filesystem connection request memory cap");
  return bytes;
}
export function createRequestArenaData(allocate: RequestArenaAllocator): SharedArrayBuffer {
  try {
    return allocate(0, FILESYSTEM_REQUEST_LIMITS.connectionBytes);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return allocate(0, FALLBACK_REQUEST_CONNECTION_BYTES);
  }
}
/** Trusted host owner. Retained arena backing, including idle arenas, stays charged. */
export class FilesystemRequestPool {
  private readonly arenas: Arena[] = [];
  private readonly receipts: SharedArrayBuffer[] = [];
  readonly connectionBytes: number;
  constructor(
    readonly budget: SharedArrayBuffer,
    connectionBytes = FILESYSTEM_REQUEST_LIMITS.connectionBytes,
    readonly source?: ArenaSource,
    readonly allocate?: RequestArenaAllocator,
  ) {
    this.connectionBytes = validateConnectionBytes(connectionBytes);
  }
  /** Host connector probe; only that namespace's sole host connector writes word 3. */
  assertBudget(budget: SharedArrayBuffer): void {
    if (sharedArrayBufferByteLength(budget) !== REQUEST_BUDGET_BYTES) throw new FilesystemError(2);
    const own = new Int32ArrayConstructor(this.budget);
    const incoming = new Int32ArrayConstructor(budget);
    const previous = atomicsLoad(own, B.probe);
    atomicsStore(own, B.probe, previous ^ -1);
    const same = atomicsLoad(incoming, B.probe) === (previous ^ -1);
    atomicsStore(own, B.probe, previous);
    if (!same) throw new FilesystemError(2, "filesystem connector namespace mismatch");
  }
  take(
    revocation: SharedArrayBuffer,
    construction?: Construction,
    headroom: Headroom | null = null,
  ): FilesystemRequestMemory {
    const generation = nextGeneration(this.budget);
    let arena: Arena | undefined;
    for (let i = 0; i < this.arenas.length; i++) {
      const candidate = this.arenas[i]!;
      if (atomicsLoad(new Int32ArrayConstructor(candidate.revocation), 0) !== 2) continue;
      if (!get(arenaMemory(candidate, this.budget), C.retired)) continue;
      if (get(arenaMemory(candidate, this.budget), C.retirementError)) {
        this.strand(candidate);
        continue;
      }
      arena = candidate;
      break;
    }
    if (!arena) arena = this.create(revocation, construction, headroom);
    else {
      const previous = arenaMemory(arena, this.budget);
      update(previous, C.closed, () => 2);
      const abandoned = atomicsExchange(control(previous), C.count, 0n);
      atomicsAdd(new Int32ArrayConstructor(this.budget), B.pending, -Number(abandoned & MASK));
      atomicsStore(control(previous), C.bytes, 0n);
      arena.control = this.createControl();
    }
    arena.revocation = revocation;
    arena.generation = generation;
    const state = new BigInt64ArrayConstructor(arena.control);
    for (let i = 1; i < REQUEST_CONTROL_BYTES / 8; i++)
      atomicsStore(state, i, tagged(generation, 0));
    atomicsStore(state, C.generation, tagged(generation, 0));
    return captureRequestMemory({
      budget: this.budget,
      control: arena.control,
      data: arena.data,
      generation,
    });
  }
  private strand(arena: Arena): void {
    if (arena.stranded) return;
    arena.stranded = true;
    this.source?.strand(arena.data);
  }
  private create(
    revocation: SharedArrayBuffer,
    construction?: Construction,
    headroom: Headroom | null = null,
  ): Arena {
    const allocate: RequestArenaAllocator = construction
      ? (bytes, maximum) => construction.allocateShared(bytes, maximum)
      : (this.allocate ?? ((bytes, maximum) => createGrowableSharedArrayBuffer(bytes, maximum)));
    const control = this.createControl(construction);
    const data = this.source
      ? this.source.create(headroom)
      : this.connectionBytes === FILESYSTEM_REQUEST_LIMITS.connectionBytes
        ? createRequestArenaData(allocate)
        : allocate(0, this.connectionBytes);
    const arena = { control, data, revocation, generation: 0, stranded: false };
    this.arenas[this.arenas.length] = arena;
    return arena;
  }
  private createControl(construction?: Construction): SharedArrayBuffer {
    charge(this.budget, REQUEST_CONTROL_BYTES);
    try {
      const control =
        construction?.allocateShared(REQUEST_CONTROL_BYTES) ??
        this.allocate?.(REQUEST_CONTROL_BYTES, REQUEST_CONTROL_BYTES) ??
        new SharedArrayBufferConstructor(REQUEST_CONTROL_BYTES);
      this.receipts[this.receipts.length] = control;
      return control;
    } catch (error) {
      refund(this.budget, REQUEST_CONTROL_BYTES);
      throw error;
    }
  }
}
export function requestMemoryRetired(memory: FilesystemRequestMemory): boolean {
  return get(memory, C.retired) !== 0;
}
export function requestMemoryRetirementError(memory: FilesystemRequestMemory): number {
  return get(memory, C.retirementError);
}
function prefix(buffer: FilesystemRequestBuffer): Int32Array {
  return new Int32ArrayConstructor(buffer.memory.data, buffer.offset - PREFIX, PREFIX / 4);
}
export function requestCells(buffer: FilesystemRequestBuffer): Int32Array {
  return new Int32ArrayConstructor(buffer.memory.data, buffer.offset, REQUEST_HEADER / 4);
}
export function requestBytes(buffer: FilesystemRequestBuffer): Uint8Array {
  return new Uint8ArrayConstructor(
    buffer.memory.data,
    buffer.offset + REQUEST_HEADER,
    buffer.length - REQUEST_HEADER,
  );
}
/** One client agent allocates; service agents only release their captured ownership bit. */
export class FilesystemRequestAllocator {
  private nextId = 1;
  readonly memory: FilesystemRequestMemory;
  constructor(memory: FilesystemRequestMemory) {
    this.memory = captureRequestMemory(memory);
    const failure = requestTransportError(this.memory);
    if (failure) throw failure;
    const previous = tagged(this.memory.generation, 0);
    if (
      atomicsCompareExchange(control(this.memory), C.generation, previous, previous | 1n) !==
      previous
    )
      throw new FilesystemError(28, "filesystem connection already has a client");
  }
  allocate(capacity: number): FilesystemRequestBuffer {
    const failure = requestTransportError(this.memory);
    if (failure) throw failure;
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new FilesystemError(28);
    if (this.nextId > 0x1fffffff) throw new FilesystemError(33);
    if (get(this.memory, C.count) >= FILESYSTEM_REQUEST_LIMITS.outstanding)
      throw new FilesystemError(6, "filesystem outstanding request quota exhausted");
    claimRequest(this.memory.budget);
    try {
      return this.allocateBytes(capacity);
    } catch (error) {
      atomicsAdd(new Int32ArrayConstructor(this.memory.budget), B.pending, -1);
      throw error;
    }
  }
  private allocateBytes(capacity: number): FilesystemRequestBuffer {
    const needed = Math.ceil((PREFIX + REQUEST_HEADER + capacity) / 16) * 16;
    const used = get(this.memory, C.used);
    let at = 0;
    while (at < used) {
      const block = new Int32ArrayConstructor(this.memory.data, at, PREFIX / 4);
      const length = atomicsLoad(block, 1);
      if (!Number(atomicsLoad(new BigInt64ArrayConstructor(this.memory.data, at + 8, 1), 0) & 3n)) {
        const available = this.coalesce(at, length, used);
        if (available >= needed) return this.bind(at, needed, available, capacity);
      }
      at += atomicsLoad(block, 1);
    }
    const maximum = sharedArrayBufferMaxByteLength(this.memory.data);
    if (needed > maximum - used)
      throw new FilesystemError(48, "filesystem connection request memory exhausted");
    this.grow(used + needed);
    update(this.memory, C.used, () => used + needed);
    return this.bind(used, needed, needed, capacity);
  }
  private coalesce(at: number, length: number, used: number): number {
    let total = length;
    while (at + total < used) {
      const next = new Int32ArrayConstructor(this.memory.data, at + total, PREFIX / 4);
      if (atomicsLoad(new BigInt64ArrayConstructor(this.memory.data, at + total + 8, 1), 0) & 3n)
        break;
      total += atomicsLoad(next, 1);
    }
    atomicsStore(new Int32ArrayConstructor(this.memory.data, at, PREFIX / 4), 1, total);
    return total;
  }
  private grow(needed: number): void {
    const before = sharedArrayBufferByteLength(this.memory.data);
    if (needed <= before) return;
    const delta = needed - before;
    charge(this.memory.budget, delta);
    try {
      sharedArrayBufferGrow(this.memory.data, needed);
    } catch (error) {
      refund(this.memory.budget, delta);
      throw error;
    }
  }
  private bind(
    at: number,
    needed: number,
    available: number,
    capacity: number,
  ): FilesystemRequestBuffer {
    const id = this.nextId++;
    const block = new Int32ArrayConstructor(this.memory.data, at, PREFIX / 4);
    if (available > needed) {
      const rest = new Int32ArrayConstructor(this.memory.data, at + needed, PREFIX / 4);
      for (let i = 0; i < PREFIX / 4; i++) atomicsStore(rest, i, 0);
      atomicsStore(rest, 1, available - needed);
    }
    atomicsStore(block, 0, id);
    atomicsStore(block, 1, needed);
    atomicsStore(
      new BigInt64ArrayConstructor(this.memory.data, at + 8, 1),
      0,
      ownership(this.memory.generation, id, REQUEST_CLIENT | REQUEST_SERVICE),
    );
    const buffer = objectFreeze({
      memory: this.memory,
      id,
      offset: at + PREFIX,
      length: REQUEST_HEADER + capacity,
    });
    const cells = requestCells(buffer);
    for (let i = 0; i < REQUEST_HEADER / 4; i++) atomicsStore(cells, i, 0);
    update(this.memory, C.count, (value) => value + 1);
    update(this.memory, C.bytes, (value) => value + needed);
    return buffer;
  }
}
export function receiveRequestBuffer(
  memory: FilesystemRequestMemory,
  id: number,
  generation: number,
  offset: number,
  length: number,
): FilesystemRequestBuffer {
  if (!current(memory) || generation !== memory.generation)
    throw new FilesystemTransportError("stale");
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    id > 0x1fffffff ||
    !Number.isSafeInteger(offset) ||
    offset < PREFIX ||
    offset % 16 ||
    !Number.isSafeInteger(length) ||
    length < REQUEST_HEADER ||
    offset + length > get(memory, C.used)
  )
    throw new FilesystemError(28, "invalid filesystem request descriptor");
  const buffer = objectFreeze({ memory, id, offset, length });
  const meta = prefix(buffer);
  if (
    atomicsLoad(meta, 0) !== id ||
    atomicsLoad(meta, 1) < length + PREFIX ||
    atomicsLoad(new BigInt64ArrayConstructor(memory.data, offset - 8, 1), 0) >> 3n !==
      ownership(memory.generation, id, 0) >> 3n ||
    !(
      atomicsLoad(new BigInt64ArrayConstructor(memory.data, offset - 8, 1), 0) &
      BigIntConstructor(REQUEST_SERVICE)
    )
  )
    throw new FilesystemError(28, "stale filesystem request descriptor");
  return buffer;
}
function ownership(generation: number, id: number, flags: number): bigint {
  return (
    (BigIntConstructor(generation) << 32n) |
    (BigIntConstructor(id) << 3n) |
    BigIntConstructor(flags)
  );
}
export function releaseRequestBuffer(
  buffer: FilesystemRequestBuffer,
  role: typeof REQUEST_CLIENT | typeof REQUEST_SERVICE,
): void {
  const words = new BigInt64ArrayConstructor(buffer.memory.data, buffer.offset - 8, 1);
  const identity = ownership(buffer.memory.generation, buffer.id, 0) >> 3n;
  const bytes = atomicsLoad(prefix(buffer), 1);
  for (;;) {
    const previous = atomicsLoad(words, 0);
    if (previous >> 3n !== identity || !(previous & BigIntConstructor(role))) return;
    const next = previous & ~BigIntConstructor(role);
    if (atomicsCompareExchange(words, 0, previous, next) !== previous) continue;
    if (!(next & 3n)) {
      releaseCount(buffer.memory, bytes);
    }
    return;
  }
}
export function requestMemoryResources(memory: FilesystemRequestMemory) {
  const stale = get(memory, C.closed) === 2;
  return {
    retainedBytes: Number(atomicsLoad(new BigInt64ArrayConstructor(memory.budget), 0)),
    namespaceRequests: atomicsLoad(new Int32ArrayConstructor(memory.budget), B.pending),
    connectionBytes: sharedArrayBufferByteLength(memory.data) + REQUEST_CONTROL_BYTES,
    maximumBytes: sharedArrayBufferMaxByteLength(memory.data),
    requests: stale ? 0 : get(memory, C.count),
    pendingBytes: stale ? 0 : get(memory, C.bytes),
  };
}

export function requestCancelled(buffer: FilesystemRequestBuffer): boolean {
  const word = atomicsLoad(
    new BigInt64ArrayConstructor(buffer.memory.data, buffer.offset - 8, 1),
    0,
  );
  return (
    !current(buffer.memory) ||
    word >> 3n !== ownership(buffer.memory.generation, buffer.id, 0) >> 3n ||
    !!(word & 4n)
  );
}
export function cancelRequestBuffer(buffer: FilesystemRequestBuffer): void {
  const words = new BigInt64ArrayConstructor(buffer.memory.data, buffer.offset - 8, 1);
  const identity = ownership(buffer.memory.generation, buffer.id, 0) >> 3n;
  for (;;) {
    const previous = atomicsLoad(words, 0);
    if (previous >> 3n !== identity || previous & 4n) return;
    if (atomicsCompareExchange(words, 0, previous, previous | 4n) === previous) return;
  }
}

export function requestMemorySections(memory: FilesystemRequestMemory): number {
  return get(memory, C.sections);
}

export function requestLengths(buffer: FilesystemRequestBuffer): {
  inputLength: number;
  dataLength: number;
} {
  const cells = requestCells(buffer);
  const inputLength = atomicsLoad(cells, 1),
    dataLength = atomicsLoad(cells, 2);
  if (
    inputLength < 0 ||
    dataLength < 0 ||
    inputLength + dataLength > buffer.length - REQUEST_HEADER
  )
    throw new FilesystemError(28, "invalid filesystem request payload bounds");
  return { inputLength, dataLength };
}
