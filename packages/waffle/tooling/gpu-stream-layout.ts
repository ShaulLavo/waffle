import { list, record, text, uint, type Field, type WireTables } from "./gpu-stream-model.ts";

/** Tooling encoder for independent layout checks. Not a guest import or browser replay. */
class Writer {
  readonly bytes: number[] = [];

  align(alignment: number): void {
    while (this.bytes.length % alignment) this.bytes.push(0);
  }

  span(value: unknown): void {
    const bytes = value instanceof Uint8Array ? value : list(value).map((byte) => uint(byte, 255));
    this.integer(bytes.length, 4);
    for (const byte of bytes) this.bytes.push(byte);
  }

  integer(value: unknown, size: 2 | 4 | 8, signed = false): void {
    this.align(size);
    const bits = integerBits(value, size, signed);
    for (let i = 0; i < size; i++) this.bytes.push(Number((bits >> BigInt(i * 8)) & 255n));
  }

  float(value: unknown, size: 4 | 8): void {
    if (typeof value !== "number") throw new Error("Expected float");
    this.align(size);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (size === 8) view.setFloat64(0, value, true);
    if (size === 4) view.setFloat32(0, value, true);
    for (const byte of bytes) this.bytes.push(byte);
  }

  string(value: unknown, nullable: boolean): void {
    if (nullable && value === null) {
      this.integer(0xffffffff, 4);
      return;
    }
    const bytes = new TextEncoder().encode(text(value));
    this.integer(bytes.length, 4);
    for (const byte of bytes) this.bytes.push(byte);
    this.align(4);
  }
}

function integerBits(value: unknown, size: number, signed: boolean): bigint {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value)))
    throw new Error("Expected exact integer");
  const bits = BigInt(value);
  const width = BigInt(size * 8);
  const min = signed ? -(1n << (width - 1n)) : 0n;
  const max = signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
  if (bits < min || bits > max) throw new Error("Integer outside wire bounds");
  return BigInt.asUintN(size * 8, bits);
}

/** WebGPU represents GPUSize64 as Number; reject truncation rather than rounding. */
export function gpuSafeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Lossy WebGPU integer");
  return Number(value);
}

/** Explicit browser mappings, not a snake-case conversion of C enum names. */
export function gpuEnum(
  tables: WireTables,
  type: string,
  value: number,
): string | number | undefined {
  uint(value);
  const values = tables.enums[type];
  const name = values && Object.keys(values).find((key) => values[key] === value);
  if (!name) throw new Error(`Unknown ${type} value ${value}`);
  const mapped = tables.browserEnums[type]?.[name];
  if (mapped === null || mapped === undefined)
    throw new Error(`Unsupported browser ${type}.${name}`);
  return mapped === "@omit" ? undefined : mapped;
}

export function gpuFlags(tables: WireTables, type: string, value: bigint): number {
  const number = gpuSafeNumber(value);
  const allowed = Object.values(tables.browserEnums[type] ?? {}).filter(
    (item): item is number => typeof item === "number",
  );
  const mask = allowed.reduce((bits, item) => bits | item, 0);
  if ((BigInt(number) & ~BigInt(mask)) !== 0n) throw new Error(`Unsupported browser ${type} bits`);
  return number;
}

function alignment(type: string): number {
  if (type === "uint16") return 2;
  if (
    ["uint64", "float64", "float64_supertype", "usize", "token"].includes(type) ||
    type.startsWith("bitflag.")
  )
    return 8;
  return 4;
}

function writeHandle(writer: Writer, value: unknown, optional: boolean): void {
  if (value === null && optional) {
    writer.integer(0, 4);
    writer.integer(0, 4);
    return;
  }
  const handle = record(value);
  const id = uint(handle.id);
  const generation = uint(handle.generation);
  if (!id || !generation) throw new Error("Null or zero-generation handle");
  writer.integer(id, 4);
  writer.integer(generation, 4);
}

function writeFields(
  writer: Writer,
  tables: WireTables,
  members: readonly Field[],
  value: unknown,
): void {
  const input = record(value);
  for (const member of members) writeField(writer, tables, member, input[member.name]);
  for (const name of Object.keys(input)) {
    if (!members.some((member) => member.name === name))
      throw new Error(`Unknown or omitted field ${name}`);
  }
}

function writeChain(writer: Writer, tables: WireTables, name: string, value: unknown): void {
  const extensions = list(value);
  if (extensions.length > 1) throw new Error("At most one allowlisted chain extension");
  writer.integer(extensions.length, 4);
  for (const extension of extensions) {
    const input = record(extension);
    const sType = uint(input.sType);
    const rule = tables.chains[name]?.find((entry) => entry.sType === sType);
    if (!rule) throw new Error("Unknown chain sType");
    writer.integer(sType, 4);
    writeType(writer, tables, `struct.${rule.struct}`, input.value, false);
  }
}

function writeType(
  writer: Writer,
  tables: WireTables,
  type: string,
  value: unknown,
  optional: boolean,
): void {
  if (type.startsWith("object.") || type === "handle") return writeHandle(writer, value, optional);
  if (type.startsWith("chain.")) return writeChain(writer, tables, type.slice(6), value);
  if (type.startsWith("array<")) {
    const items = list(value);
    const element = type.slice(6, -1);
    writer.integer(items.length, 4);
    writer.align(alignment(element));
    for (const item of items) writeType(writer, tables, element, item, false);
    return;
  }
  if (type.startsWith("struct.")) {
    const layout = tables.structs[type.slice(7)];
    if (!layout) throw new Error(`Unknown struct ${type}`);
    return writeFields(writer, tables, layout.fields, value);
  }
  writeScalar(writer, tables, type, value);
}

function writeScalar(writer: Writer, tables: WireTables, type: string, value: unknown): void {
  if (type === "bytes") return writer.span(value);
  if (type === "bool") {
    if (value !== true && value !== false) throw new Error("Expected boolean");
    writer.integer(value ? 1 : 0, 4);
    return;
  }
  if (type === "nullable_bool") {
    if (value !== 0 && value !== 1 && value !== 2) throw new Error("Invalid WGPUOptionalBool");
    writer.integer(value, 4);
    return;
  }
  if (type.includes("string")) return writer.string(value, type === "nullable_string");
  if (type === "token") {
    const token = uint(value);
    if (!token) throw new Error("Zero callback token");
    writer.integer(token, 4);
    writer.integer(0, 4);
    return;
  }
  if (type.startsWith("enum.")) {
    const number = uint(value);
    if (!Object.values(tables.enums[type] ?? {}).includes(number))
      throw new Error("Unknown numeric C enum");
    writer.integer(number, 4);
    return;
  }
  if (type.startsWith("bitflag.") || type === "uint64" || type === "usize")
    return writer.integer(value, 8);
  if (
    type === "float32" ||
    type === "nullable_float32" ||
    type === "float64" ||
    type === "float64_supertype"
  )
    return writer.float(value, type === "float64" || type === "float64_supertype" ? 8 : 4);
  if (type === "uint32" || type === "int32") return writer.integer(value, 4, type === "int32");
  if (type === "uint16") return writer.integer(value, 2);
  throw new Error(`No layout encoder for ${type}`);
}

function writeField(writer: Writer, tables: WireTables, member: Field, value: unknown): void {
  if (member.optional && member.type.startsWith("struct.")) {
    writer.integer(value === null ? 0 : 1, 4);
    if (value === null) return;
  }
  writer.align(alignment(member.type));
  writeType(writer, tables, member.type, value, member.optional);
}

function beginRecord(code: number): Writer {
  const writer = new Writer();
  writer.integer(code, 2);
  writer.integer(0, 2);
  writer.integer(0, 4);
  return writer;
}

function finishRecord(
  writer: Writer,
  tables: WireTables,
  members: readonly Field[],
  value: unknown,
): Uint8Array {
  writeFields(writer, tables, members, value);
  writer.align(8);
  const bytes = Uint8Array.from(writer.bytes);
  new DataView(bytes.buffer).setUint32(4, uint(bytes.length), true);
  return bytes;
}

export function encodeGpuCommand(tables: WireTables, name: string, value: unknown): Uint8Array {
  const call = tables.calls.find((entry) => entry.name === name);
  if (!call) throw new Error("Unknown selected command");
  return finishRecord(beginRecord(call.opcode), tables, call.fields, value);
}

export function encodeGpuStruct(tables: WireTables, name: string, value: unknown): Uint8Array {
  const writer = new Writer();
  writeType(writer, tables, `struct.${name}`, value, false);
  return Uint8Array.from(writer.bytes);
}

export function encodeGpuCompletion(
  tables: WireTables,
  name: string,
  token: number,
  status: number,
  value: unknown,
): Uint8Array {
  const completion = tables.completions.find((entry) => entry.name === name);
  if (!completion) throw new Error("Unknown completion");
  const writer = beginRecord(completion.kind);
  writer.integer(token, 4);
  writer.integer(status, 4, true);
  return finishRecord(writer, tables, completion.fields, value);
}

export function encodeGpuPrivate(tables: WireTables, name: string, value: unknown): Uint8Array {
  const layout = tables.records.find((entry) => entry.name === name && entry.enabled);
  if (!layout) throw new Error("Unknown private record");
  return finishRecord(beginRecord(layout.opcode), tables, layout.fields, value);
}
