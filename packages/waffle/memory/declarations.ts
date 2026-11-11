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

export interface ThreadModuleDeclaration {
  readonly initialPages: WasmPages;
  readonly actualMaximumPages: WasmPages;
  readonly sourceMaximumPages: WasmPages;
}
const threadDeclarations = new WeakMap<WebAssembly.Module, ThreadModuleDeclaration>();
export function declareThreadModule(
  module: WebAssembly.Module,
  declaration: ThreadModuleDeclaration,
): void {
  threadDeclarations.set(module, declaration);
}
export function threadModuleDeclaration(
  module: WebAssembly.Module,
): ThreadModuleDeclaration | undefined {
  return threadDeclarations.get(module);
}
type Signature = { parameters: number[]; results: number[] };
const threadSignatures: Readonly<Record<string, readonly number[]>> = {
  args_get: [0x7f, 0x7f],
  args_sizes_get: [0x7f, 0x7f],
  environ_get: [0x7f, 0x7f],
  environ_sizes_get: [0x7f, 0x7f],
  clock_time_get: [0x7f, 0x7e, 0x7f],
  random_get: [0x7f, 0x7f],
  sched_yield: [],
  fd_read: [0x7f, 0x7f, 0x7f, 0x7f],
  fd_write: [0x7f, 0x7f, 0x7f, 0x7f],
  fd_pread: [0x7f, 0x7f, 0x7f, 0x7e, 0x7f],
  fd_pwrite: [0x7f, 0x7f, 0x7f, 0x7e, 0x7f],
  fd_seek: [0x7f, 0x7e, 0x7f, 0x7f],
  fd_tell: [0x7f, 0x7f],
  fd_fdstat_get: [0x7f, 0x7f],
  fd_filestat_get: [0x7f, 0x7f],
  fd_close: [0x7f],
  proc_exit: [0x7f],
};
function text(reader: Reader): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(reader.take(reader.u32()));
}
function signature(reader: Reader): Signature {
  if (reader.byte() !== 0x60)
    throw new WebAssembly.CompileError("Unsupported thread function type");
  const parameters = Array.from({ length: reader.u32() }, () => reader.byte());
  const results = Array.from({ length: reader.u32() }, () => reader.byte());
  return { parameters, results };
}
function matchesSignature(
  value: Signature | undefined,
  parameters: readonly number[],
  results: readonly number[],
): boolean {
  return (
    !!value &&
    value.parameters.length === parameters.length &&
    value.results.length === results.length &&
    value.parameters.every((item, index) => item === parameters[index]) &&
    value.results.every((item, index) => item === results[index])
  );
}
function threadSections(data: Uint8Array): Map<number, Uint8Array> | undefined {
  const reader = new Reader(data);
  reader.take(8);
  const sections = new Map<number, Uint8Array>();
  while (reader.position < data.length) {
    const id = reader.byte();
    const body = reader.take(reader.u32());
    if (id) sections.set(id, body);
    else {
      const custom = text(new Reader(body));
      if (custom === "dylink.0" || custom === "dylink") return undefined;
    }
  }
  return sections;
}
function threadImports(data: Uint8Array | undefined) {
  const imports = new Reader(data ?? new Uint8Array([0]));
  const functions: { module: string; name: string; type: number }[] = [];
  const memories: { module: string; name: string; declaration: MemoryDeclaration }[] = [];
  const count = imports.u32();
  for (let index = 0; index < count; index++) {
    const module = text(imports),
      name = text(imports),
      kind = imports.byte();
    if (kind === 0) functions.push({ module, name, type: imports.u32() });
    else if (kind === 2) memories.push({ module, name, declaration: memory(imports, "imported") });
    else return undefined;
  }
  return { functions, memories };
}
/** Source-only admission. Reflection cannot certify imported memory limits or function types. */
export function inspectThreadSource(data: Uint8Array): ThreadModuleDeclaration | undefined {
  const sections = threadSections(data);
  if (!sections) return undefined;
  const imported = threadImports(sections.get(2));
  if (!imported) return undefined;
  const { functions, memories } = imported;
  if (!functions.some((value) => value.module === "wasi" && value.name === "thread-spawn"))
    return undefined;
  const fail = (): never => {
    throw new WebAssembly.CompileError("Unsupported threaded Preview 1 source shape or signature");
  };
  const importedMemory = memories[0];
  if (
    memories.length !== 1 ||
    !importedMemory ||
    importedMemory.module !== "env" ||
    importedMemory.name !== "memory" ||
    importedMemory.declaration.kind !== "shared"
  )
    fail();
  if (
    sections.has(5) ||
    functions.filter((value) => value.module === "wasi" && value.name === "thread-spawn").length !==
      1
  )
    fail();
  const typesReader = new Reader(sections.get(1) ?? new Uint8Array([0]));
  const types = Array.from({ length: typesReader.u32() }, () => signature(typesReader));
  for (const value of functions) {
    const parameters =
      value.module === "wasi" && value.name === "thread-spawn"
        ? [0x7f]
        : value.module === "wasi_snapshot_preview1" && Object.hasOwn(threadSignatures, value.name)
          ? threadSignatures[value.name]
          : undefined;
    const results = value.name === "proc_exit" ? [] : [0x7f];
    if (!parameters || !matchesSignature(types[value.type], parameters, results)) fail();
  }
  const functionReader = new Reader(sections.get(3) ?? new Uint8Array([0]));
  const indices = functions
    .map((value) => value.type)
    .concat(Array.from({ length: functionReader.u32() }, () => functionReader.u32()));
  const exports = new Reader(sections.get(7) ?? new Uint8Array([0]));
  const exported = new Map<string, Signature | undefined>();
  const exportCount = exports.u32();
  for (let index = 0; index < exportCount; index++) {
    const name = text(exports),
      kind = exports.byte(),
      position = exports.u32();
    if (kind === 0) exported.set(name, types[indices[position] ?? -1]);
  }
  if (
    !matchesSignature(exported.get("_start"), [], []) ||
    !matchesSignature(exported.get("wasi_thread_start"), [0x7f, 0x7f], [])
  )
    fail();
  const declaration = importedMemory!.declaration;
  if (declaration.kind !== "shared") return fail();
  const maximum = pages(Math.min(512, declaration.maximumPages));
  if (declaration.initialPages > maximum) fail();
  return Object.freeze({
    initialPages: declaration.initialPages,
    actualMaximumPages: maximum,
    sourceMaximumPages: declaration.maximumPages,
  });
}
