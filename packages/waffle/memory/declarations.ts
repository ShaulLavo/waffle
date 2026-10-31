import { pages, SharedMemoryAdmissionError, type WasmPages } from "./reservations.js";
export type MemoryDeclaration =
  | {
      readonly kind: "private";
      readonly maximumPages: WasmPages;
      readonly origin: "defined" | "imported";
    }
  | {
      readonly kind: "shared";
      readonly initialPages: WasmPages;
      readonly maximumPages: WasmPages;
      readonly origin: "defined" | "imported";
    };
class Reader {
  position = 0;
  constructor(readonly data: Uint8Array) {}
  byte(): number {
    const value = this.data[this.position++];
    if (value === undefined) throw new WebAssembly.CompileError("Truncated memory declaration");
    return value;
  }
  u32(): number {
    let result = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.byte();
      if (index === 4 && byte > 15) throw new WebAssembly.CompileError("Invalid u32 declaration");
      result += (byte & 127) * 2 ** (7 * index);
      if (!(byte & 128)) return result;
    }
    throw new WebAssembly.CompileError("Invalid u32 declaration");
  }
  take(length: number): Uint8Array {
    if (length > this.data.length - this.position)
      throw new WebAssembly.CompileError("Truncated declaration section");
    const value = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }
  name(): void {
    this.take(this.u32());
  }
}
function limits(
  reader: Reader,
  memory: boolean,
): { initial: number; maximum?: number; shared: boolean } {
  const flags = reader.u32();
  if (flags & 4)
    throw new SharedMemoryAdmissionError({
      kind: "configuration",
      configuration: "memory64-module",
    });
  if (flags & ~3) throw new WebAssembly.CompileError("Unknown memory limits");
  const initial = reader.u32();
  const maximum = flags & 1 ? reader.u32() : undefined;
  if (memory && flags & 2 && maximum === undefined)
    throw new WebAssembly.CompileError("Shared memory requires maximum");
  return { initial, maximum, shared: Boolean(flags & 2) };
}
function memory(reader: Reader, origin: MemoryDeclaration["origin"]): MemoryDeclaration {
  const value = limits(reader, true);
  return value.shared
    ? Object.freeze({
        kind: "shared",
        initialPages: pages(value.initial),
        maximumPages: pages(value.maximum ?? 65_536),
        origin,
      })
    : Object.freeze({ kind: "private", maximumPages: pages(value.maximum ?? 65_536), origin });
}
function imported(reader: Reader, result: MemoryDeclaration[]): void {
  reader.name();
  reader.name();
  switch (reader.byte()) {
    case 0:
      reader.u32();
      return;
    case 1:
      reader.byte();
      limits(reader, false);
      return;
    case 2:
      result.push(memory(reader, "imported"));
      return;
    case 3:
      reader.byte();
      reader.byte();
      return;
    case 4:
      reader.byte();
      reader.u32();
      return;
    default:
      throw new WebAssembly.CompileError("Unsupported import declaration");
  }
}
export function parseModuleMemory(data: Uint8Array): readonly MemoryDeclaration[] {
  const reader = new Reader(data);
  const header = reader.take(8);
  if (
    header[0] !== 0 ||
    header[1] !== 97 ||
    header[2] !== 115 ||
    header[3] !== 109 ||
    header[4] !== 1
  )
    throw new WebAssembly.CompileError("Invalid wasm header");
  const result: MemoryDeclaration[] = [];
  while (reader.position < data.length) {
    const section = reader.byte();
    const body = new Reader(reader.take(reader.u32()));
    if (section !== 2 && section !== 5) continue;
    const count = body.u32();
    for (let index = 0; index < count; index++) {
      if (section === 2) imported(body, result);
      else result.push(memory(body, "defined"));
    }
    if (body.position !== body.data.length)
      throw new WebAssembly.CompileError("Trailing memory declaration bytes");
  }
  return Object.freeze(result);
}
const declarations = new WeakMap<WebAssembly.Module, readonly MemoryDeclaration[]>();
export function declareModuleMemory(module: WebAssembly.Module, data: Uint8Array): void {
  declarations.set(module, parseModuleMemory(data));
}
export function moduleMemoryDeclarations(
  module: WebAssembly.Module,
): readonly MemoryDeclaration[] | undefined {
  return declarations.get(module);
}
