import { ExecutableFormatError } from "../proc/start-errno.js";

export interface MemoryInfo {
  memorySize: number;
  memoryAlignment: number;
  tableSize: number;
  tableAlignment: number;
}
export interface FunctionSignature {
  readonly params: readonly number[];
  readonly results: readonly number[];
}
export interface ModuleProfile {
  readonly passiveData: boolean;
  readonly functions: ReadonlyMap<string, FunctionSignature>;
  readonly memory: MemoryInfo | undefined;
  readonly globalImports: readonly string[];
  readonly immutableI32Exports: ReadonlySet<string>;
}

export function invalid(member: string, message: string): never {
  throw new ExecutableFormatError(`link ${member}: ${message}`);
}

class Reader {
  position = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly member: string,
  ) {}
  byte(): number {
    const byte = this.bytes[this.position++];
    if (byte === undefined) invalid(this.member, "truncated binary");
    return byte;
  }
  u32(): number {
    let result = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.byte();
      if (shift === 28 && byte > 15) invalid(this.member, "u32 overflow");
      result += (byte & 127) * 2 ** shift;
      if (byte < 128) return result;
    }
    return invalid(this.member, "invalid u32");
  }
  take(size: number): Reader {
    if (size > this.bytes.length - this.position) invalid(this.member, "truncated section");
    const start = this.position;
    this.position += size;
    return new Reader(this.bytes.subarray(start, this.position), this.member);
  }
  name(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.take(this.u32()).bytes);
    } catch (error) {
      if (error instanceof TypeError) invalid(this.member, "invalid UTF-8 name");
      throw error;
    }
  }
  done(): void {
    if (this.position !== this.bytes.length) invalid(this.member, "unexpected trailing bytes");
  }
}

function limits(reader: Reader): void {
  const flags = reader.u32();
  if (flags > 1) invalid(reader.member, "shared/memory64 limits are unsupported");
  reader.u32();
  if (flags === 1) reader.u32();
}

function importGlobal(reader: Reader, side: boolean, namespace: string, name: string): string {
  if (!side) invalid(reader.member, "core must own its globals");
  if (reader.byte() !== 0x7f) invalid(reader.member, "only i32 global imports are supported");
  const mutable = reader.byte();
  if (mutable > 1) invalid(reader.member, "invalid global mutability");
  if (namespace === "GOT.mem" && mutable !== 1)
    invalid(reader.member, "GOT.mem requires mutable i32 address globals");
  if (side && namespace !== "env" && namespace !== "GOT.mem")
    invalid(reader.member, "side globals must import env or supported GOT.mem");
  return namespace === "env" ? name : `${namespace}.${name}`;
}

function imports(reader: Reader, side: boolean, functions: number[]): string[] {
  const globals: string[] = [];
  let memories = 0;
  let tables = 0;
  const count = reader.u32();
  for (let i = 0; i < count; i++) {
    const namespace = reader.name(),
      name = reader.name(),
      kind = reader.byte();
    if (namespace.startsWith("GOT.") && namespace !== "GOT.mem")
      invalid(reader.member, `unsupported ${namespace}.${name}`);
    if (
      namespace === "GOT.mem" &&
      (!side || kind !== 3 || !["stdout", "_CLOCK_MONOTONIC", "errno"].includes(name))
    )
      invalid(reader.member, `unsupported GOT.mem.${name}`);
    if (kind === 0) functions.push(reader.u32());
    else if (kind === 1) {
      if (reader.byte() !== 0x70) invalid(reader.member, "only funcref tables are supported");
      limits(reader);
      tables++;
      if (side && (namespace !== "env" || name !== "__indirect_function_table"))
        invalid(reader.member, "side table must import env.__indirect_function_table");
    } else if (kind === 2) {
      limits(reader);
      memories++;
      if (side && (namespace !== "env" || name !== "memory"))
        invalid(reader.member, "side memory must import env.memory");
    } else if (kind === 3) {
      globals.push(importGlobal(reader, side, namespace, name));
    } else invalid(reader.member, "tags and unknown import kinds are unsupported");
  }
  if (!side && (memories || tables))
    invalid(reader.member, "core must define its own memory and table");
  if (memories > 1 || tables > 1)
    invalid(reader.member, "multiple memories/tables are unsupported");
  if (side && (memories !== 1 || tables !== 1))
    invalid(reader.member, "side requires one imported memory and table");
  reader.done();
  return globals;
}

function dylink(reader: Reader): MemoryInfo {
  let info: MemoryInfo | undefined;
  while (reader.position < reader.bytes.length) {
    const kind = reader.byte(),
      part = reader.take(reader.u32());
    if (kind === 1 && !info) {
      info = {
        memorySize: part.u32(),
        memoryAlignment: part.u32(),
        tableSize: part.u32(),
        tableAlignment: part.u32(),
      };
      if (info.memoryAlignment > 31 || info.tableAlignment > 31)
        invalid(reader.member, "alignment exponent exceeds wasm32");
    } else if (kind === 2 && part.u32() === 0) {
      // Dependencies are explicit core imports, not a filesystem search policy.
    } else invalid(reader.member, `unsupported dylink.0 subsection ${kind}`);
    part.done();
  }
  if (!info) invalid(reader.member, "dylink.0 lacks memory-info");
  return info;
}

function segmentOffset(reader: Reader, global: number | undefined): void {
  if (reader.byte() !== 0x23 || reader.u32() !== global || reader.byte() !== 0x0b)
    invalid(reader.member, "side segment offset must be its imported base global");
}

function segments(
  reader: Reader,
  profile: MemoryInfo,
  global: number | undefined,
  data: boolean,
): boolean {
  const count = reader.u32();
  let passive = false,
    active = false,
    total = 0;
  for (let index = 0; index < count; index++) {
    const flag = reader.u32();
    if (data && flag === 1) passive = true;
    else if (flag === 0 && !active) {
      segmentOffset(reader, global);
      active = true;
    } else invalid(reader.member, "unsupported or overlapping side segments");
    const size = reader.u32();
    total += size;
    if (total > (data ? profile.memorySize : profile.tableSize))
      invalid(reader.member, "segments exceed dylink.0 reservation");
    if (data) reader.take(size);
    else for (let item = 0; item < size; item++) reader.u32();
  }
  reader.done();
  return passive;
}

function functionExports(
  sections: Map<number, Reader>,
  imported: readonly number[],
  member: string,
): ReadonlyMap<string, FunctionSignature> {
  const copy = (id: number) => new Reader(sections.get(id)?.bytes ?? new Uint8Array([0]), member);
  const types = copy(1),
    signatures: FunctionSignature[] = [];
  const count = types.u32();
  for (let index = 0; index < count; index++) {
    if (types.byte() !== 0x60) invalid(member, "only function types are supported");
    const params = Array.from({ length: types.u32() }, () => types.byte());
    const results = Array.from({ length: types.u32() }, () => types.byte());
    signatures.push({ params, results });
  }
  types.done();
  const defined = copy(3),
    size = defined.u32();
  const indices = imported.concat(Array.from({ length: size }, () => defined.u32()));
  defined.done();
  const exports = copy(7),
    result = new Map<string, FunctionSignature>();
  const exported = exports.u32();
  for (let index = 0; index < exported; index++) {
    const name = exports.name(),
      kind = exports.byte(),
      target = exports.u32();
    if (kind !== 0) continue;
    const signature = signatures[indices[target] ?? -1];
    if (!signature) invalid(member, `invalid function export ${name}`);
    result.set(name, signature);
  }
  exports.done();
  return result;
}

export function requireSignature(
  profile: ModuleProfile,
  member: string,
  name: string,
  params: readonly number[],
  results: readonly number[],
): void {
  const signature = profile.functions.get(name);
  if (
    !signature ||
    signature.params.join() !== params.join() ||
    signature.results.join() !== results.join()
  )
    invalid(member, `export ${name} has an unsupported Wasm signature`);
}

function coreLayout(sections: Map<number, Reader>, member: string): ReadonlySet<string> {
  const table = sections.get(4),
    memory = sections.get(5);
  if (!table || table.u32() !== 1 || table.byte() !== 0x70)
    invalid(member, "core requires one defined funcref table");
  limits(table);
  table.done();
  if (!memory || memory.u32() !== 1) invalid(member, "core requires one defined memory");
  limits(memory);
  memory.done();
  const globals = sections.get(6),
    immutable: boolean[] = [];
  const count = globals?.u32() ?? 0;
  for (let index = 0; index < count; index++) {
    const value = globals!.byte(),
      mutable = globals!.byte();
    if (value !== 0x7f || mutable > 1) invalid(member, "core requires i32 globals");
    immutable.push(mutable === 0);
    if (globals!.byte() !== 0x41) invalid(member, "core globals require constant i32 initializers");
    // Signed LEB values need not be interpreted to inspect the global's type.
    let more = true;
    while (more) more = globals!.byte() >= 128;
    if (globals!.byte() !== 0x0b) invalid(member, "unsupported core global initializer");
  }
  globals?.done();
  const exports = sections.get(7),
    names = new Set<string>();
  const size = exports?.u32() ?? 0;
  for (let index = 0; index < size; index++) {
    const name = exports!.name(),
      kind = exports!.byte(),
      target = exports!.u32();
    if (kind === 3 && immutable[target]) names.add(name);
  }
  exports?.done();
  return names;
}

export function inspectProfile(bytes: Uint8Array, member: string, side: boolean): ModuleProfile {
  const reader = new Reader(bytes, member);
  const header = reader.take(8).bytes;
  if (header.join() !== "0,97,115,109,1,0,0,0") invalid(member, "invalid wasm header");
  let memory: MemoryInfo | undefined;
  let globalImports: string[] = [];
  const sections = new Map<number, Reader>();
  while (reader.position < bytes.length) {
    const id = reader.byte(),
      section = reader.take(reader.u32());
    if (id === 0) {
      const name = section.name();
      if (name === "dylink.0" && !memory) memory = dylink(section);
      else if (/^(dylink|linking|reloc\.)/.test(name))
        invalid(member, `unsupported custom section ${name}`);
      continue;
    }
    if (sections.has(id)) invalid(member, `duplicate section ${id}`);
    sections.set(id, section);
  }
  if (sections.has(8)) invalid(member, "true Wasm start sections are unsupported");
  if (sections.has(13)) invalid(member, "exception tags are unsupported");
  if (side !== Boolean(memory))
    invalid(
      member,
      side ? "side requires dylink.0" : "core must own its static layout, not dylink",
    );
  const imported = sections.get(2);
  const importedFunctions: number[] = [];
  if (imported) globalImports = imports(imported, side, importedFunctions);
  const functions = functionExports(sections, importedFunctions, member);
  if (!side)
    return {
      passiveData: false,
      functions,
      memory,
      globalImports,
      immutableI32Exports: coreLayout(sections, member),
    };
  if (!imported) invalid(member, "side requires imports");
  for (const id of [4, 5, 6]) {
    const section = sections.get(id);
    if (section && section.u32() !== 0)
      invalid(member, "side cannot define tables, memory or globals");
  }
  if (!memory) invalid(member, "missing memory-info");
  const data = sections.get(11),
    elements = sections.get(9);
  const passiveData = data
    ? segments(data, memory, globalImports.indexOf("__memory_base"), true)
    : false;
  if (elements) segments(elements, memory, globalImports.indexOf("__table_base"), false);
  return { passiveData, functions, memory, globalImports, immutableI32Exports: new Set() };
}
