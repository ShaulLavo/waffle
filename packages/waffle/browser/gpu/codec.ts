import { gpuStream } from "./generated/tables.js";
import type { CallLayout, Field, WireTables } from "../../tooling/gpu-stream-model.js";
import {
  checkedSpan,
  GPU_LIMITS,
  GpuProtocolError,
  GpuCallError,
  GpuResourceError,
  type Handle,
} from "./protocol.js";

export type WireValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | WireValue[]
  | WireObject;
export interface WireObject {
  [key: string]: WireValue;
}
export interface DecodedCall {
  readonly layout: CallLayout;
  readonly fields: WireObject;
}

export function wireObject(value: WireValue | undefined): WireObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array)
    throw new GpuProtocolError("Expected wire dictionary");
  return value;
}
export function wireArray(value: WireValue | undefined): WireValue[] {
  if (!Array.isArray(value)) throw new GpuProtocolError("Expected wire array");
  return value;
}
export function wireNumber(value: WireValue | undefined): number {
  if (typeof value !== "number") throw new GpuProtocolError("Expected wire number");
  return value;
}
export function wireBytes(value: WireValue | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new GpuProtocolError("Expected wire byte span");
  return value;
}
export function wireHandle(value: WireValue | undefined): Handle {
  const object = wireObject(value);
  return { id: wireNumber(object.id), generation: wireNumber(object.generation) };
}
export function safeGpuNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new GpuProtocolError("Lossy WebGPU integer");
  return Number(value);
}

export function recordHeader(
  bytes: Uint8Array,
  offset = 0,
): { opcode: number; flags: number; length: number } {
  checkedSpan(bytes.byteLength, offset, 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const length = view.getUint32(4, true);
  if (length < 8 || length % 8 !== 0) throw new GpuProtocolError("Invalid record length");
  checkedSpan(bytes.byteLength, offset, length);
  return { opcode: view.getUint16(0, true), flags: view.getUint16(2, true), length };
}

/** Views stay inside a trusted service task. Never pass these through guest-realm code. */
export class WireReader {
  readonly #view: DataView;
  #offset = 0;
  #values = 0;
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    checkedSpan(bytes.byteLength, start, 0);
    this.#offset = start;
  }
  get offset(): number {
    return this.#offset;
  }
  align(alignment: number): void {
    const end = Math.ceil(this.#offset / alignment) * alignment;
    this.zeroTo(end);
  }
  zeroTo(end: number): void {
    checkedSpan(this.bytes.byteLength, this.#offset, end - this.#offset);
    while (this.#offset < end) {
      if (this.bytes[this.#offset++] !== 0) throw new GpuProtocolError("Nonzero wire padding");
    }
  }
  take(length: number): Uint8Array {
    checkedSpan(this.bytes.byteLength, this.#offset, length);
    const view = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return view;
  }
  u32(): number {
    checkedSpan(this.bytes.byteLength, this.#offset, 4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }
  scalar(type: string): WireValue {
    if (type.includes("string")) return this.#string(type === "nullable_string");
    if (type === "bytes") return this.take(this.u32());
    if (type === "token") return this.#token();
    if (type === "bool" || type === "nullable_bool") return this.#boolean(type);
    if (type.startsWith("enum.")) return this.#enum(type);
    return this.#numeric(type);
  }
  fields(fields: readonly Field[]): WireObject {
    const result: WireObject = Object.create(null);
    for (const field of fields) result[field.name] = this.field(field);
    return result;
  }
  field(field: Field): WireValue {
    if (++this.#values > GPU_LIMITS.decodeValues)
      throw new GpuResourceError("GPU decoded-value limit");
    if (field.optional && field.type.startsWith("struct.") && !this.#presence()) return null;
    this.align(wireAlignment(field.type));
    return this.type(field.type, field.optional);
  }
  type(type: string, optional = false): WireValue {
    if (type.startsWith("object.") || type === "handle") return this.#handle(optional);
    if (type.startsWith("array<")) return this.#array(type.slice(6, -1));
    if (type.startsWith("chain.")) return this.#chain(type.slice(6));
    if (!type.startsWith("struct.")) return this.scalar(type);
    const layout = tables.structs[type.slice(7)];
    if (!layout) throw new GpuProtocolError(`Unknown wire struct ${type}`);
    return this.fields(layout.fields);
  }
  finish(): void {
    this.align(8);
    if (this.#offset !== this.bytes.byteLength) throw new GpuProtocolError("Trailing wire bytes");
  }
  #presence(): boolean {
    const value = this.u32();
    if (value > 1) throw new GpuProtocolError("Invalid optional presence");
    return value === 1;
  }
  #handle(optional: boolean): WireValue {
    const id = this.u32();
    const generation = this.u32();
    if (id === 0 && generation === 0 && optional) return null;
    if (!id || !generation) throw new GpuProtocolError("Invalid wire handle");
    return { id, generation };
  }
  #array(element: string): WireValue[] {
    const count = this.u32();
    if (count > GPU_LIMITS.decodeValues - this.#values)
      throw new GpuResourceError("GPU array limit");
    this.align(wireAlignment(element));
    const result: WireValue[] = [];
    for (let index = 0; index < count; index++)
      result.push(this.field({ name: "element", type: element, optional: false }));
    return result;
  }
  #chain(name: string): WireValue[] {
    const count = this.u32();
    if (count > 1) throw new GpuProtocolError("Too many chain extensions");
    if (!count) return [];
    const sType = this.u32();
    const rule = tables.chains[name]?.find((entry) => entry.sType === sType);
    if (!rule) throw new GpuProtocolError("Unknown chain extension");
    return [{ sType, value: this.type(`struct.${rule.struct}`) }];
  }
  #string(nullable: boolean): WireValue {
    const length = this.u32();
    if (length === 0xffffffff && nullable) return null;
    const bytes = this.take(length);
    this.align(4);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GpuProtocolError("Invalid UTF-8");
    }
  }
  #token(): number {
    const token = this.u32();
    if (!token || this.u32() !== 0) throw new GpuProtocolError("Invalid callback token");
    return token;
  }
  #boolean(type: string): WireValue {
    const value = this.u32();
    if (value > (type === "bool" ? 1 : 2)) throw new GpuProtocolError("Invalid boolean");
    return type === "bool" ? value === 1 : value;
  }
  #enum(type: string): number {
    const value = this.u32();
    if (!Object.values(tables.enums[type] ?? {}).includes(value))
      throw new GpuProtocolError(`Unknown ${type} value`);
    return value;
  }
  #numeric(type: string): WireValue {
    const size = wireAlignment(type);
    checkedSpan(this.bytes.byteLength, this.#offset, size);
    const at = this.#offset;
    this.#offset += size;
    if (type.startsWith("bitflag.") || type === "uint64" || type === "usize")
      return this.#view.getBigUint64(at, true);
    if (type === "float64" || type === "float64_supertype") return this.#view.getFloat64(at, true);
    if (type === "float32" || type === "nullable_float32") return this.#view.getFloat32(at, true);
    if (type === "int32") return this.#view.getInt32(at, true);
    if (type === "uint16") return this.#view.getUint16(at, true);
    if (type === "uint32") return this.#view.getUint32(at, true);
    throw new GpuProtocolError(`Unsupported scalar ${type}`);
  }
}

function wireAlignment(type: string): number {
  if (type === "uint16") return 2;
  if (
    ["uint64", "usize", "float64", "float64_supertype", "token"].includes(type) ||
    type.startsWith("bitflag.")
  )
    return 8;
  return 4;
}

export function decodeCall(bytes: Uint8Array): DecodedCall {
  const header = recordHeader(bytes);
  if (header.flags || header.length !== bytes.byteLength)
    throw new GpuProtocolError("Invalid command framing");
  const layout = callsByOpcode.get(header.opcode);
  if (!layout) throw new GpuProtocolError("Unknown selected opcode");
  const reader = new WireReader(bytes, 8);
  const fields = reader.fields(layout.fields);
  reader.finish();
  return { layout, fields };
}

/** Completion bodies use generated fields and allocate only their measured whole length. */
export function completionBytes(
  name: string,
  token: number,
  status: number,
  value: WireObject,
  capacity: number,
): Uint8Array {
  const layout = gpuStream.completions.find((entry) => entry.name === name);
  if (!layout) throw new GpuProtocolError("Unknown completion layout");
  const limit = Math.min(capacity, GPU_LIMITS.copyBytes);
  const fields = layout.fields.map((field) =>
    prepareCompletionField(field, value[field.name], limit),
  );
  const length =
    Math.ceil(
      (16 + fields.reduce<number>((sum, field) => sum + completionFieldLength(field), 0)) / 8,
    ) * 8;
  if (length > limit) throw new GpuResourceError("GPU completion exceeds capacity");
  const writer = new CompletionWriter(length);
  writer.u32(layout.kind);
  writer.u32(length);
  writer.u32(token);
  writer.u32(status);
  for (const field of fields) writer.field(field);
  return writer.bytes;
}

type CompletionField = number | Handle | Uint8Array;
function prepareCompletionField(
  field: Field,
  value: WireValue | undefined,
  capacity: number,
): CompletionField {
  if (field.type.startsWith("object.") || field.type === "handle")
    return field.optional && value === null ? { id: 0, generation: 0 } : wireHandle(value);
  if (field.type !== "out_string") return wireNumber(value);
  if (typeof value !== "string") throw new GpuProtocolError("Expected completion string");
  if (value.length > capacity - 4) throw new GpuResourceError("GPU message exceeds capacity");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > capacity - 4) throw new GpuResourceError("GPU message exceeds capacity");
  return bytes;
}
function completionFieldLength(field: CompletionField): number {
  if (typeof field === "number") return 4;
  if (field instanceof Uint8Array) return 4 + Math.ceil(field.byteLength / 4) * 4;
  return 8;
}
class CompletionWriter {
  readonly bytes: Uint8Array;
  #offset = 0;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
  }
  u32(value: number): void {
    new DataView(this.bytes.buffer).setUint32(this.#offset, value, true);
    this.#offset += 4;
  }
  field(field: CompletionField): void {
    if (typeof field === "number") {
      this.u32(field);
      return;
    }
    if (field instanceof Uint8Array) {
      this.u32(field.byteLength);
      this.bytes.set(field, this.#offset);
      this.#offset += Math.ceil(field.byteLength / 4) * 4;
      return;
    }
    this.u32(field.id);
    this.u32(field.generation);
  }
}

const tables: WireTables = gpuStream;
const callsByOpcode = new Map<number, CallLayout>();
for (const call of tables.calls) callsByOpcode.set(call.opcode, call);

/** Runs the same checked traversal for sizing and bounded in-arena encoding. */
export function outputStruct(name: string, value: WireObject, destination?: Uint8Array): number {
  const writer = new OutputWriter(destination);
  writer.value(`struct.${name}`, value);
  return writer.offset;
}
class OutputWriter {
  offset = 0;
  readonly #view: DataView | undefined;
  constructor(readonly destination?: Uint8Array) {
    this.#view = destination
      ? new DataView(destination.buffer, destination.byteOffset, destination.byteLength)
      : undefined;
  }
  #align(alignment: number): void {
    this.offset = Math.ceil(this.offset / alignment) * alignment;
  }
  #advance(length: number): number {
    const at = this.offset;
    if (length > GPU_LIMITS.logicalBytes - at)
      throw new GpuResourceError("Output exceeds logical capacity");
    if (this.destination) checkedSpan(this.destination.byteLength, at, length);
    this.offset += length;
    return at;
  }
  #u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new GpuCallError("Invalid C u32 output");
    const at = this.#advance(4);
    this.#view?.setUint32(at, value, true);
  }
  value(type: string, value: WireValue): void {
    this.#align(wireAlignment(type));
    if (type.startsWith("struct.")) return this.#struct(type.slice(7), wireObject(value));
    if (type.startsWith("chain.")) {
      this.#u32(0);
      return;
    }
    if (type.startsWith("array<")) {
      const items = wireArray(value);
      this.#u32(items.length);
      this.#align(wireAlignment(type.slice(6, -1)));
      for (const item of items) this.value(type.slice(6, -1), item);
      return;
    }
    if (type.includes("string")) return this.#string(value);
    if (type === "bool") {
      this.#u32(value === true ? 1 : value === false ? 0 : invalidOutput());
      return;
    }
    if (type === "uint64" || type === "usize") {
      if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn)
        throw new GpuCallError("Invalid C u64 output");
      const at = this.#advance(8);
      this.#view?.setBigUint64(at, value, true);
      return;
    }
    this.#u32(wireNumber(value));
  }
  #struct(name: string, object: WireObject): void {
    const layout = tables.structs[name];
    if (!layout) throw new GpuProtocolError("Unknown output structure");
    for (const field of layout.fields) this.value(field.type, object[field.name] ?? null);
  }
  #string(value: WireValue): void {
    if (typeof value !== "string") throw new GpuCallError("Invalid C string output");
    const length = utf8Length(value);
    this.#u32(length);
    const at = this.#advance(length);
    if (this.destination) writeUtf8(value, this.destination, at);
    this.#align(4);
    if (this.destination && this.offset > this.destination.byteLength)
      throw new GpuProtocolError("Output padding exceeds capacity");
  }
}
function invalidOutput(): never {
  throw new GpuCallError("Invalid C boolean output");
}
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function writeUtf8(text: string, destination: Uint8Array, at: number): void {
  for (const character of text) {
    const original = character.codePointAt(0) ?? 0;
    const code = original >= 0xd800 && original <= 0xdfff ? 0xfffd : original;
    if (code < 0x80) {
      destination[at++] = code;
      continue;
    }
    if (code < 0x800) {
      destination[at++] = 0xc0 | (code >> 6);
      destination[at++] = 0x80 | (code & 63);
      continue;
    }
    if (code < 0x10000) {
      destination[at++] = 0xe0 | (code >> 12);
      destination[at++] = 0x80 | ((code >> 6) & 63);
      destination[at++] = 0x80 | (code & 63);
      continue;
    }
    destination[at++] = 0xf0 | (code >> 18);
    destination[at++] = 0x80 | ((code >> 12) & 63);
    destination[at++] = 0x80 | ((code >> 6) & 63);
    destination[at++] = 0x80 | (code & 63);
  }
}
