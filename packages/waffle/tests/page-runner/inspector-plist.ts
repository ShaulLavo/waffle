// Bounded binary plist codec and four-byte big-endian frame decoder for the WIR frontend stream.
// Adapted from ../bun-inspector-client-preparation/codec.ts (original, ours). Changes: larger but still fixed
// bounds, and the decoder also accepts null, signed 8-byte integers, reals and dates, which an installed relay
// may legitimately send. UIDs, sets and XML still refuse. Errors are typed so a local codec limit is never
// reported as a protocol refusal.

export const plistLimits = Object.freeze({ frame: 1 << 20, objects: 16384, depth: 16 });

export type Plist =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | Plist[]
  | { [key: string]: Plist };
export type PlistDict = { [key: string]: Plist };

/** A local decode/encode limit or unsupported construct. Not a protocol answer. */
class CodecError extends Error {
  constructor(readonly reason: string) {
    super(`codec: ${reason}`);
  }
}

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new CodecError(reason);
}

export function isDict(value: unknown): value is PlistDict {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Date)
  );
}

function width(value: number): number {
  return value < 256 ? 1 : value < 65536 ? 2 : 4;
}

function uint(value: number, size: number): Buffer {
  check(
    Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    "encoder: unsigned 32-bit value required",
  );
  const result = Buffer.alloc(size);
  result.writeUIntBE(value, 0, size);
  return result;
}

function counted(kind: number, length: number): Buffer {
  if (length < 15) return Buffer.from([kind | length]);
  const size = width(length);
  return Buffer.concat([Buffer.from([kind | 15, 0x10 | Math.log2(size)]), uint(length, size)]);
}

function ascii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) >= 128) return false;
  }
  return true;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) return false;
    const next = value.charCodeAt(++index);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
  }
  return true;
}

function stringBytes(value: string): Buffer {
  check(wellFormed(value), "encoder: malformed Unicode string");
  if (ascii(value))
    return Buffer.concat([counted(0x50, value.length), Buffer.from(value, "ascii")]);
  return Buffer.concat([counted(0x60, value.length), Buffer.from(value, "utf16le").swap16()]);
}

/** Encodes the subset a frontend sends: strings, unsigned 32-bit integers, booleans, data and containers. */
function encodePlist(value: Plist): Buffer {
  const objects: Buffer[] = [];
  let total = 0;
  const add = (item: Plist, depth: number): number => {
    check(
      depth <= plistLimits.depth && objects.length < plistLimits.objects,
      "encoder: structure bound",
    );
    const id = objects.length;
    objects.push(Buffer.alloc(0));
    const encoded = encodeItem(item, depth, add);
    total += encoded.length;
    check(total <= plistLimits.frame, "encoder: byte bound");
    objects[id] = encoded;
    return id;
  };
  const root = add(value, 0);
  check(objects.length < 65536, "encoder: reference width");
  const offsets: number[] = [];
  let offset = 8;
  for (const item of objects) {
    offsets.push(offset);
    offset += item.length;
  }
  const size = width(offset);
  const table = Buffer.concat(offsets.map((n) => uint(n, size)));
  const trailer = Buffer.alloc(32);
  trailer[6] = size;
  trailer[7] = 2;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(root), 16);
  trailer.writeBigUInt64BE(BigInt(offset), 24);
  const parts: Buffer[] = [Buffer.from("bplist00")];
  const result = Buffer.concat(parts.concat(objects, [table, trailer]));
  check(result.length <= plistLimits.frame, "encoder: frame too large");
  return result;
}

function encodeItem(
  item: Plist,
  depth: number,
  add: (value: Plist, depth: number) => number,
): Buffer {
  if (typeof item === "boolean") return Buffer.from([item ? 9 : 8]);
  if (typeof item === "number") {
    const size = width(item);
    return Buffer.concat([Buffer.from([0x10 | Math.log2(size)]), uint(item, size)]);
  }
  if (typeof item === "string") return stringBytes(item);
  check(
    item !== null && !(item instanceof Date),
    "encoder: null and dates are not sent by this client",
  );
  if (Buffer.isBuffer(item)) return Buffer.concat([counted(0x40, item.length), item]);
  if (Array.isArray(item))
    return Buffer.concat(
      [counted(0xa0, item.length)].concat(item.map((v) => uint(add(v, depth + 1), 2))),
    );
  const entries = Object.entries(item);
  const keys = entries.map(([k]) => uint(add(k, depth + 1), 2));
  const values = entries.map(([, v]) => uint(add(v, depth + 1), 2));
  return Buffer.concat([counted(0xd0, entries.length)].concat(keys, values));
}

type Table = { bytes: Buffer; offsets: number[]; ends: Map<number, number>; refs: number };

function decodePlist(bytes: Buffer): Plist {
  check(bytes.length >= 40 && bytes.length <= plistLimits.frame, "decoder: frame size");
  check(
    bytes.subarray(0, 8).toString("latin1") === "bplist00",
    "decoder: binary plist magic required",
  );
  const trailer = bytes.length - 32;
  const size = bytes[trailer + 6] ?? 0,
    refs = bytes[trailer + 7] ?? 0;
  check(
    [1, 2, 4, 8].includes(size) && [1, 2, 4].includes(refs),
    "decoder: unsupported offset/reference size",
  );
  const safe64 = (at: number) => {
    const n = Number(bytes.readBigUInt64BE(at));
    check(Number.isSafeInteger(n), "decoder: unsafe count");
    return n;
  };
  const count = safe64(trailer + 8),
    root = safe64(trailer + 16),
    tableAt = safe64(trailer + 24);
  check(
    count > 0 &&
      count <= plistLimits.objects &&
      root < count &&
      tableAt >= 8 &&
      tableAt + count * size === trailer,
    "decoder: invalid object table",
  );
  const offsets = Array.from({ length: count }, (_, i) =>
    Number(readUnsigned(bytes, tableAt + i * size, size)),
  );
  check(
    offsets.every((n) => n >= 8 && n < tableAt) && new Set(offsets).size === count,
    "decoder: invalid object offsets",
  );
  const sorted = offsets.toSorted((a, b) => a - b);
  const ends = new Map(sorted.map((n, i) => [n, sorted[i + 1] ?? tableAt]));
  const table: Table = { bytes, offsets, ends, refs };
  const active = new Set<number>();
  let visits = 0;
  const parse = (id: number, depth: number): Plist => {
    check(
      depth <= plistLimits.depth && ++visits <= plistLimits.objects && !active.has(id),
      "decoder: cycle/expansion/depth bound",
    );
    const at = table.offsets[id];
    check(at !== undefined, "decoder: invalid object reference");
    const end = table.ends.get(at) ?? at;
    active.add(id);
    try {
      return decodeItem(table.bytes.subarray(at, end), table.refs, (child) =>
        parse(child, depth + 1),
      );
    } finally {
      active.delete(id);
    }
  };
  return parse(root, 0);
}

function readUnsigned(bytes: Buffer, at: number, size: number): bigint {
  check(at + size <= bytes.length, "decoder: truncated integer");
  if (size === 8) return bytes.readBigUInt64BE(at);
  return BigInt(bytes.readUIntBE(at, size));
}

function extent(bytes: Buffer): { count: number; start: number } {
  const marker = bytes[0] ?? 0;
  if ((marker & 15) < 15) return { count: marker & 15, start: 1 };
  const tag = bytes[1];
  check(
    tag !== undefined && (tag & 0xf0) === 0x10 && (tag & 15) <= 2,
    "decoder: unsupported length",
  );
  const size = 2 ** (tag & 15);
  check(bytes.length >= 2 + size, "decoder: truncated length");
  return { count: bytes.readUIntBE(2, size), start: 2 + size };
}

function exact(bytes: Buffer, start: number, length: number): Buffer {
  check(start + length === bytes.length, "decoder: truncated or trailing object data");
  return bytes.subarray(start);
}

function decodeInteger(bytes: Buffer, marker: number): number {
  const size = 2 ** (marker & 15);
  check(size <= 8, "decoder: unsupported integer width");
  const data = exact(bytes, 1, size);
  if (size < 8) return data.readUIntBE(0, size);
  const value = data.readBigInt64BE(0);
  check(
    value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER),
    "decoder: integer outside safe range",
  );
  return Number(value);
}

function decodeReal(bytes: Buffer, marker: number): number {
  const size = 2 ** (marker & 15);
  check(size === 4 || size === 8, "decoder: unsupported real width");
  const data = exact(bytes, 1, size);
  return size === 4 ? data.readFloatBE(0) : data.readDoubleBE(0);
}

function decodeItem(bytes: Buffer, refs: number, parse: (id: number) => Plist): Plist {
  const marker = bytes[0];
  check(marker !== undefined, "decoder: empty object");
  if (marker === 0) {
    exact(bytes, 1, 0);
    return null;
  }
  if (marker === 8 || marker === 9) {
    exact(bytes, 1, 0);
    return marker === 9;
  }
  if (marker === 0x33)
    return new Date(Date.UTC(2001, 0, 1) + exact(bytes, 1, 8).readDoubleBE(0) * 1000);
  const kind = marker & 0xf0;
  if (kind === 0x10) return decodeInteger(bytes, marker);
  if (kind === 0x20) return decodeReal(bytes, marker);
  check(
    [0x40, 0x50, 0x60, 0xa0, 0xd0].includes(kind),
    `decoder: unsupported plist type 0x${kind.toString(16)}`,
  );
  const { count, start } = extent(bytes);
  if (kind === 0x40) return Buffer.from(exact(bytes, start, count));
  if (kind === 0x50) {
    const data = exact(bytes, start, count);
    check(
      data.every((n) => n < 128),
      "decoder: invalid ASCII",
    );
    return data.toString("ascii");
  }
  if (kind === 0x60) {
    const value = Buffer.from(exact(bytes, start, count * 2))
      .swap16()
      .toString("utf16le");
    check(wellFormed(value), "decoder: malformed UTF-16");
    return value;
  }
  check(count <= plistLimits.objects, "decoder: container bound");
  const data = exact(bytes, start, count * refs * (kind === 0xd0 ? 2 : 1));
  const ids = Array.from({ length: data.length / refs }, (_, i) => data.readUIntBE(i * refs, refs));
  if (kind === 0xa0) return ids.map(parse);
  return decodeDictionary(ids, count, parse);
}

function decodeDictionary(ids: number[], count: number, parse: (id: number) => Plist): PlistDict {
  const result: PlistDict = Object.create(null);
  for (let i = 0; i < count; i++) {
    const keyId = ids[i],
      valueId = ids[i + count];
    check(keyId !== undefined && valueId !== undefined, "decoder: dictionary shape");
    const key = parse(keyId);
    check(
      typeof key === "string" && !Object.hasOwn(result, key),
      "decoder: invalid or duplicate dictionary key",
    );
    result[key] = parse(valueId);
  }
  return result;
}

export function frame(value: Plist): Buffer {
  const data = encodePlist(value);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}

/** A peer answer that does not look like this framing at all: kept distinct from a codec limit. */
class FramingError extends Error {
  constructor(
    readonly reason: string,
    readonly headerHex: string,
  ) {
    super(`framing: ${reason}`);
  }
}

/** Streaming four-byte big-endian length decoder. Split and coalesced reads are handled; no read boundary is assumed. */
export class Frames {
  private header = Buffer.alloc(4);
  private used = 0;
  private payload: Buffer | null = null;
  private offset = 0;
  private failed = false;
  frames = 0;

  feed(chunk: Buffer, accept: (value: Plist) => void): void {
    check(!this.failed, "decoder closed after an earlier failure");
    let at = 0;
    try {
      while (at < chunk.length) at = this.consume(chunk, at, accept);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** True when EOF fell on a frame boundary. */
  atBoundary(): boolean {
    return this.used === 0 && this.payload === null;
  }

  private consume(chunk: Buffer, at: number, accept: (value: Plist) => void): number {
    if (!this.payload) return this.readHeader(chunk, at);
    const size = Math.min(this.payload.length - this.offset, chunk.length - at);
    chunk.copy(this.payload, this.offset, at, at + size);
    this.offset += size;
    if (this.offset !== this.payload.length) return at + size;
    const payload = this.payload;
    this.payload = null;
    this.offset = 0;
    this.used = 0;
    if (payload.subarray(0, 8).toString("latin1") !== "bplist00")
      throw new FramingError(
        "payload is not a binary plist",
        payload.subarray(0, 8).toString("hex"),
      );
    this.frames++;
    accept(decodePlist(payload));
    return at + size;
  }

  private readHeader(chunk: Buffer, at: number): number {
    const size = Math.min(4 - this.used, chunk.length - at);
    chunk.copy(this.header, this.used, at, at + size);
    this.used += size;
    if (this.used !== 4) return at + size;
    const length = this.header.readUInt32BE();
    if (length < 40 || length > 64 * plistLimits.frame)
      throw new FramingError(`implausible length ${length}`, this.header.toString("hex"));
    check(
      length <= plistLimits.frame,
      `frame of ${length} bytes exceeds the local ${plistLimits.frame}-byte bound`,
    );
    this.payload = Buffer.alloc(length);
    return at + size;
  }
}
