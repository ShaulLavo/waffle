import {
  DataViewConstructor,
  dataViewGetUint32,
  dataViewSetUint32,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  typedArraySet,
  Uint8ArrayConstructor,
} from "../../proc/intrinsics.js";
import type { RecordRing, RingWriter, RingReadResult } from "./ring.js";
import {
  GPU_LIMITS,
  GPU_TERMINAL,
  GpuProtocolError,
  GpuResourceError,
  ServiceCredit,
} from "./protocol.js";

const CHUNK = 0x1004;
const minimum = Math.min;
const ceil = Math.ceil;
const integer = Number.isSafeInteger;
function view(bytes: Uint8Array): DataView {
  return new DataViewConstructor(
    typedArrayBuffer(bytes),
    typedArrayByteOffset(bytes),
    typedArrayLength(bytes),
  );
}
function slice(bytes: Uint8Array, start: number, length: number): Uint8Array {
  return new Uint8ArrayConstructor(
    typedArrayBuffer(bytes),
    typedArrayByteOffset(bytes) + start,
    length,
  );
}
function header(bytes: Uint8Array, at: number): number {
  if (typedArrayLength(bytes) - at < 8) throw new GpuProtocolError("Truncated append record");
  const input = view(bytes);
  const prefix = dataViewGetUint32(input, at, true);
  const length = dataViewGetUint32(input, at + 4, true);
  if (!prefix || prefix >>> 16 !== 0 || (prefix & 0xffff) === CHUNK)
    throw new GpuProtocolError("Invalid source opcode or flags");
  if (length < 8 || length % 8 || length > typedArrayLength(bytes) - at)
    throw new GpuProtocolError("Invalid append framing");
  return length;
}

export type AppendProgress = "done" | "progress" | "full" | "busy" | "terminal";
/** Guest-side publication cursor. Its caller owns waiting; this class never sleeps. */
export class LogicalAppend {
  #writer: RingWriter | undefined;
  #source: Uint8Array | undefined;
  #at = 0;
  #offset = 0;
  #chunk: Uint8Array | undefined;
  #chunkPayload = 0;
  readonly #chunkBytes: number;
  constructor(
    readonly ring: Pick<RecordRing, "capacity" | "recordHeaderBytes" | "tryAcquireWriter" | "terminal" | "terminate">,
    bytes: Uint8Array,
    readonly maxLogical: number = GPU_LIMITS.logicalBytes,
  ) {
    if (
      ring.recordHeaderBytes !== 8 ||
      !integer(maxLogical) ||
      maxLogical < 8 ||
      maxLogical > GPU_LIMITS.logicalBytes
    )
      throw new RangeError("Invalid logical transport configuration");
    let at = 0;
    while (at < typedArrayLength(bytes)) {
      const length = header(bytes, at);
      if (length > maxLogical) throw new GpuResourceError("Logical record exceeds limit");
      at += length;
    }
    this.#source = bytes;
    this.#chunkBytes = minimum(ring.capacity / 2, GPU_LIMITS.copyBytes);
  }
  advance(budget: number = GPU_LIMITS.copyBytes): AppendProgress {
    if (!integer(budget) || budget < 8) throw new RangeError("Invalid append budget");
    if (!this.#source) return this.ring.terminal() ? "terminal" : "done";
    if (this.ring.terminal()) return this.#finish("terminal");
    const acquired = this.#acquire();
    if (acquired) return acquired;
    let copied = 0;
    try {
      while (this.#source && copied < budget) {
        const next = this.#publishOne();
        if (typeof next === "string") return next;
        copied += next;
      }
    } catch (error) {
      this.ring.terminate(
        error instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol,
      );
      this.#finish("terminal");
      throw error;
    }
    return this.#source ? "progress" : "done";
  }
  cancel(reason: number = GPU_TERMINAL.revoked): void {
    this.ring.terminate(reason);
    this.#finish("terminal");
  }
  #acquire(): "busy" | "terminal" | undefined {
    if (this.#writer) return;
    const acquired = this.ring.tryAcquireWriter();
    if (acquired.kind === "busy") return "busy";
    if (acquired.kind === "terminal") return this.#finish("terminal");
    this.#writer = acquired.writer;
  }
  #finish<T extends "terminal" | "done">(result: T): T {
    this.#writer?.release();
    this.#writer = undefined;
    this.#source = undefined;
    this.#chunk = undefined;
    return result;
  }
  #publishOne(): number | "full" | "terminal" | "done" {
    const source = this.#source;
    if (!source || !this.#writer) return this.#finish("done");
    if (this.#at === typedArrayLength(source)) return this.#finish("done");
    const length = header(source, this.#at);
    const record = this.#record(source, length);
    const result = this.#writer.tryWrite(record);
    if (result.kind === "full") return "full";
    if (result.kind === "terminal") return this.#finish("terminal");
    const copied = typedArrayLength(record);
    this.#offset += this.#chunk ? this.#chunkPayload : length;
    this.#chunk = undefined;
    if (this.#offset === length) {
      this.#at += length;
      this.#offset = 0;
    }
    if (this.#at === typedArrayLength(source)) this.#finish("done");
    return copied;
  }
  #record(source: Uint8Array, length: number): Uint8Array {
    if (length <= this.#chunkBytes) return slice(source, this.#at, length);
    if (this.#chunk) return this.#chunk;
    if (this.#chunkBytes < 32)
      throw new GpuResourceError("Command ring cannot hold chunk envelope");
    const payload = minimum(length - this.#offset, this.#chunkBytes - 24);
    const bytes = new Uint8ArrayConstructor(ceil((24 + payload) / 8) * 8);
    const output = view(bytes);
    dataViewSetUint32(output, 0, CHUNK | ((payload + this.#offset === length ? 2 : 1) << 16), true);
    dataViewSetUint32(output, 4, typedArrayLength(bytes), true);
    dataViewSetUint32(output, 8, length, true);
    dataViewSetUint32(output, 12, this.#offset, true);
    dataViewSetUint32(output, 16, payload, true);
    typedArraySet(bytes, slice(source, this.#at + this.#offset, payload), 24);
    this.#chunkPayload = payload;
    this.#chunk = bytes;
    return bytes;
  }
}

type Assembly = { bytes: Uint8Array; offset: number; release: () => void };
export interface LogicalRecord {
  readonly bytes: Uint8Array;
  release(): void;
}
export type CommandReadResult = RingReadResult | { readonly kind: "reader-closed" };
export interface CommandReadSource extends Pick<RecordRing, "capacity" | "recordHeaderBytes" | "terminal" | "terminate"> {
  readInto(destination: Uint8Array): CommandReadResult;
}

export type LogicalRead =
  | { readonly kind: "reader-closed" }

  | { kind: "record"; record: LogicalRecord }
  | { kind: "progress" }
  | { kind: "empty" }
  | { kind: "terminal"; reason: number };

/** Service-side bounded reassembly. One scratch and at most one charged logical record. */
export class LogicalReader {
  #assembly: Assembly | undefined;
  lastReadBytes = 0;
  #scratch: Uint8Array | undefined;
  readonly #releaseScratch: () => void;
  constructor(
    readonly ring: CommandReadSource,
    readonly credit: ServiceCredit,
    readonly maxLogical: number = GPU_LIMITS.logicalBytes,
  ) {
    if (
      ring.recordHeaderBytes !== 8 ||
      !integer(maxLogical) ||
      maxLogical < 8 ||
      maxLogical > GPU_LIMITS.logicalBytes
    )
      throw new RangeError("Invalid logical reader configuration");
    const size = minimum(ring.capacity, GPU_LIMITS.copyBytes);
    this.#releaseScratch = credit.reserve(size);
    try {
      this.#scratch = new Uint8ArrayConstructor(size);
    } catch (error) {
      this.#releaseScratch();
      throw error;
    }
  }
  get assembling(): boolean {
    return this.#assembly !== undefined;
  }
  read(): LogicalRead {
    this.lastReadBytes = 0;
    if (!this.#scratch)
      return { kind: "terminal", reason: this.ring.terminal()?.reason ?? GPU_TERMINAL.closed };
    try {
      return this.#read();
    } catch (error) {
      const reason =
        error instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol;
      this.ring.terminate(reason);
      this.dispose();
      return { kind: "terminal", reason: this.ring.terminal()?.reason ?? reason };
    }
  }
  dispose(): void {
    this.#assembly?.release();
    this.#assembly = undefined;
    this.#scratch = undefined;
    this.#releaseScratch();
  }
  #read(): LogicalRead {
    const scratch = this.#scratch;
    if (!scratch) throw new GpuProtocolError("Reader retired");
    const result = this.ring.readInto(scratch);
    if (result.kind === "short") throw new GpuResourceError("Physical record exceeds copy budget");
    if (result.kind === "empty" || result.kind === "reader-closed") return result;
    if (result.kind === "terminal") {
      this.dispose();
      return result;
    }
    this.lastReadBytes = result.bytes;
    const bytes = slice(scratch, 0, result.bytes);
    const prefix = dataViewGetUint32(view(bytes), 0, true);
    if ((prefix & 0xffff) === CHUNK) return this.#chunk(bytes, prefix >>> 16);
    if (this.#assembly) throw new GpuProtocolError("Interleaved logical record");
    header(bytes, 0);
    return this.#copy(bytes);
  }
  #copy(bytes: Uint8Array): LogicalRead {
    const length = typedArrayLength(bytes);
    if (length > this.maxLogical) throw new GpuResourceError("Logical record exceeds limit");
    const release = this.credit.reserve(length);
    try {
      const copy = new Uint8ArrayConstructor(length);
      typedArraySet(copy, bytes);
      return { kind: "record", record: { bytes: copy, release } };
    } catch (error) {
      release();
      throw error;
    }
  }
  #chunk(bytes: Uint8Array, flags: number): LogicalRead {
    if (typedArrayLength(bytes) < 32 || (flags !== 1 && flags !== 2))
      throw new GpuProtocolError("Invalid chunk header");
    const input = view(bytes);
    const total = dataViewGetUint32(input, 8, true);
    const offset = dataViewGetUint32(input, 12, true);
    const length = dataViewGetUint32(input, 16, true);
    if (dataViewGetUint32(input, 20, true) || total < 8 || total % 8 || !length)
      throw new GpuProtocolError("Invalid chunk envelope");
    if (total > this.maxLogical) throw new GpuResourceError("Logical record exceeds limit");
    if (
      length > total - offset ||
      offset > total ||
      ceil((24 + length) / 8) * 8 !== typedArrayLength(bytes)
    )
      throw new GpuProtocolError("Invalid chunk span");
    if ((flags === 2) !== (offset + length === total))
      throw new GpuProtocolError("Missing or early final chunk");
    for (let at = 24 + length; at < typedArrayLength(bytes); at++)
      if (bytes[at] !== 0) throw new GpuProtocolError("Nonzero chunk padding");
    const assembly = this.#getAssembly(total, offset);
    typedArraySet(assembly.bytes, slice(bytes, 24, length), offset);
    assembly.offset += length;
    if (flags === 1) return { kind: "progress" };
    header(assembly.bytes, 0);
    if (dataViewGetUint32(view(assembly.bytes), 4, true) !== total)
      throw new GpuProtocolError("Logical header length mismatch");
    this.#assembly = undefined;
    return { kind: "record", record: { bytes: assembly.bytes, release: assembly.release } };
  }
  #getAssembly(total: number, offset: number): Assembly {
    if (this.#assembly) {
      if (this.#assembly.offset !== offset || typedArrayLength(this.#assembly.bytes) !== total)
        throw new GpuProtocolError("Chunk gap, overlap or changed total");
      return this.#assembly;
    }
    if (offset !== 0) throw new GpuProtocolError("First chunk has nonzero offset");
    const release = this.credit.reserve(total);
    try {
      this.#assembly = { bytes: new Uint8ArrayConstructor(total), offset: 0, release };
    } catch (error) {
      release();
      throw error;
    }
    return this.#assembly;
  }
}
