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
export interface FunctionExport extends FunctionSignature {
  readonly index: number;
}
interface FunctionImport extends FunctionSignature {
  readonly module: string;
  readonly name: string;
  readonly index: number;
  readonly binding: "required" | "weak";
}
interface GlobalType {
  readonly value: 0x7f;
  readonly mutable: boolean;
}
interface GlobalImport extends GlobalType {
  readonly module: string;
  readonly name: string;
  readonly index: number;
}
interface ImportInfo {
  readonly module: string;
  readonly name: string;
  readonly flags: 0x11;
}
export interface ModuleProfile {
  readonly passiveData: boolean;
  readonly functions: ReadonlyMap<string, FunctionExport>;
  readonly memory: MemoryInfo | undefined;
  readonly functionImports: readonly FunctionImport[];
  readonly globalImports: readonly GlobalImport[];
  readonly globalExports: ReadonlyMap<string, GlobalType>;
  readonly importInfo: readonly ImportInfo[];
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
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        this.take(this.u32()).bytes,
      );
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

function importGlobal(
  reader: Reader,
  side: boolean,
  namespace: string,
  name: string,
  index: number,
): GlobalImport {
  if (!side) invalid(reader.member, "core must own its globals");
  if (reader.byte() !== 0x7f) invalid(reader.member, "only i32 global imports are supported");
  const mutable = reader.byte();
  if (mutable > 1) invalid(reader.member, "invalid global mutability");
  if (namespace === "env" && name === "__stack_pointer" && mutable !== 1)
    invalid(reader.member, "side stack pointer must be mutable i32");
  if (namespace === "env" && ["__memory_base", "__table_base"].includes(name) && mutable !== 0)
    invalid(reader.member, "side bases must be immutable i32");
  if (namespace === "GOT.mem" && mutable !== 1)
    invalid(reader.member, "GOT.mem requires mutable i32 address globals");
  if (side && namespace !== "env" && namespace !== "GOT.mem")
    invalid(reader.member, "side globals must import env or supported GOT.mem");
  return { module: namespace, name, index, value: 0x7f, mutable: mutable === 1 };
}

function imports(reader: Reader, side: boolean, types: readonly FunctionSignature[]) {
  const globals: GlobalImport[] = [];
  const functions: FunctionImport[] = [];
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
    if (kind === 0)
      functions.push({
        ...functionType(reader, types),
        module: namespace,
        name,
        index: functions.length,
        binding: "required",
      });
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
      globals.push(importGlobal(reader, side, namespace, name, globals.length));
    } else invalid(reader.member, "tags and unknown import kinds are unsupported");
  }
  if (!side && (memories || tables))
    invalid(reader.member, "core must define its own memory and table");
  if (memories > 1 || tables > 1)
    invalid(reader.member, "multiple memories/tables are unsupported");
  if (side && (memories !== 1 || tables !== 1))
    invalid(reader.member, "side requires one imported memory and table");
  reader.done();
  return { globals, functions };
}

function readImportInfo(reader: Reader, records: ImportInfo[]): void {
  const count = reader.u32();
  for (let index = 0; index < count; index++) {
    const module = reader.name(),
      name = reader.name(),
      flags = reader.u32();
    if (records.some((record) => record.module === module && record.name === name))
      invalid(reader.member, `duplicate or conflicting import-info ${module}.${name}`);
    if (flags !== 0x11) invalid(reader.member, `unsupported import-info flags ${flags}`);
    records.push({ module, name, flags });
  }
}

function bindImports(
  functions: readonly FunctionImport[],
  records: readonly ImportInfo[],
  member: string,
): readonly FunctionImport[] {
  for (const record of records) {
    if (
      record.module !== "env" ||
      !functions.some((entry) => entry.module === record.module && entry.name === record.name)
    )
      invalid(
        member,
        `import-info ${record.module}.${record.name} must name an imported env function`,
      );
  }
  return functions.map((entry) => ({
    ...entry,
    binding: records.some((record) => record.module === entry.module && record.name === entry.name)
      ? "weak"
      : "required",
  }));
}

function dylink(reader: Reader): { memory: MemoryInfo; importInfo: readonly ImportInfo[] } {
  let info: MemoryInfo | undefined;
  const importInfo: ImportInfo[] = [];
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
    } else if (kind === 4) {
      readImportInfo(part, importInfo);
    } else invalid(reader.member, `unsupported dylink.0 subsection ${kind}`);
    part.done();
  }
  if (!info) invalid(reader.member, "dylink.0 lacks memory-info");
  return { memory: info, importInfo };
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

function functionTypes(reader: Reader): readonly FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const count = reader.u32();
  for (let index = 0; index < count; index++) {
    if (reader.byte() !== 0x60) invalid(reader.member, "only function types are supported");
    const params = Array.from({ length: reader.u32() }, () => reader.byte());
    const results = Array.from({ length: reader.u32() }, () => reader.byte());
    signatures.push({ params, results });
  }
  reader.done();
  return signatures;
}

function functionType(reader: Reader, types: readonly FunctionSignature[]): FunctionSignature {
  const index = reader.u32();
  return types[index] ?? invalid(reader.member, `invalid function type index ${index}`);
}

function functionExports(
  sections: Map<number, Reader>,
  types: readonly FunctionSignature[],
  imported: readonly FunctionSignature[],
  member: string,
): ReadonlyMap<string, FunctionExport> {
  const copy = (id: number) => new Reader(sections.get(id)?.bytes ?? new Uint8Array([0]), member);
  const defined = copy(3),
    size = defined.u32();
  const signatures = imported.concat(
    Array.from({ length: size }, () => functionType(defined, types)),
  );
  defined.done();
  const exports = copy(7),
    result = new Map<string, FunctionExport>();
  const exported = exports.u32();
  for (let index = 0; index < exported; index++) {
    const name = exports.name(),
      kind = exports.byte(),
      target = exports.u32();
    if (kind !== 0) continue;
    const signature = signatures[target];
    if (!signature) invalid(member, `invalid function export ${name}`);
    result.set(name, { ...signature, index: target });
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
  if (!signature || !sameSignature(signature, { params, results }))
    invalid(member, `export ${name} has an unsupported Wasm signature`);
}

export function sameSignature(left: FunctionSignature, right: FunctionSignature): boolean {
  return left.params.join() === right.params.join() && left.results.join() === right.results.join();
}

function definedGlobals(section: Reader | undefined, member: string): GlobalType[] {
  const globals = section ?? new Reader(new Uint8Array([0]), member);
  const result: GlobalType[] = [];
  const count = globals.u32();
  for (let index = 0; index < count; index++) {
    const value = globals.byte(),
      mutable = globals.byte();
    if (value !== 0x7f || mutable > 1) invalid(member, "only defined i32 globals are supported");
    result.push({ value, mutable: mutable === 1 });
    if (globals.byte() !== 0x41) invalid(member, "globals require constant i32 initializers");
    // Signed LEB values need not be interpreted to inspect the global's type.
    let more = true;
    while (more) more = globals.byte() >= 128;
    if (globals.byte() !== 0x0b) invalid(member, "unsupported global initializer");
  }
  globals.done();
  return result;
}

function coreLayout(sections: Map<number, Reader>, member: string): void {
  const table = sections.get(4),
    memory = sections.get(5);
  if (!table || table.u32() !== 1 || table.byte() !== 0x70)
    invalid(member, "core requires one defined funcref table");
  limits(table);
  table.done();
  if (!memory || memory.u32() !== 1) invalid(member, "core requires one defined memory");
  limits(memory);
  memory.done();
}

function globalExports(
  section: Reader | undefined,
  globals: readonly GlobalType[],
  member: string,
): ReadonlyMap<string, GlobalType> {
  const exports = new Reader(section?.bytes ?? new Uint8Array([0]), member);
  const result = new Map<string, GlobalType>();
  const size = exports.u32();
  for (let index = 0; index < size; index++) {
    const name = exports.name(),
      kind = exports.byte(),
      target = exports.u32();
    if (kind !== 3) continue;
    const type = globals[target];
    if (!type) invalid(member, `invalid global export ${name}`);
    result.set(name, type);
  }
  exports.done();
  return result;
}

export function inspectProfile(bytes: Uint8Array, member: string, side: boolean): ModuleProfile {
  const reader = new Reader(bytes, member);
  const header = reader.take(8).bytes;
  if (header.join() !== "0,97,115,109,1,0,0,0") invalid(member, "invalid wasm header");
  let memory: MemoryInfo | undefined;
  let importInfo: readonly ImportInfo[] = [];
  const sections = new Map<number, Reader>();
  while (reader.position < bytes.length) {
    const id = reader.byte(),
      section = reader.take(reader.u32());
    if (id === 0) {
      const name = section.name();
      if (name === "dylink.0" && !memory) ({ memory, importInfo } = dylink(section));
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
  const types = functionTypes(new Reader(sections.get(1)?.bytes ?? new Uint8Array([0]), member));
  const entries = imported ? imports(imported, side, types) : { globals: [], functions: [] };
  const functionImports = bindImports(entries.functions, importInfo, member);
  const globalImports = entries.globals;
  const functions = functionExports(sections, types, functionImports, member);
  const importedGlobals: readonly GlobalType[] = globalImports;
  const globals = importedGlobals.concat(definedGlobals(sections.get(6), member));
  const exportedGlobals = globalExports(sections.get(7), globals, member);
  const immutableI32Exports = new Set<string>();
  for (const [name, type] of exportedGlobals) {
    if (!type.mutable) immutableI32Exports.add(name);
  }
  const profile = {
    functions,
    functionImports,
    memory,
    globalImports,
    globalExports: exportedGlobals,
    importInfo,
    immutableI32Exports,
  };
  if (!side) {
    coreLayout(sections, member);
    return { ...profile, passiveData: false };
  }
  if (!imported) invalid(member, "side requires imports");
  const base = (name: string) =>
    globalImports.find((entry) => entry.module === "env" && entry.name === name)?.index;
  if (base("__stack_pointer") === undefined)
    invalid(member, "side must import the core stack pointer");
  for (const id of [4, 5]) {
    const section = sections.get(id);
    if (section && section.u32() !== 0) invalid(member, "side cannot define tables or memory");
  }
  if (!memory) invalid(member, "missing memory-info");
  const data = sections.get(11),
    elements = sections.get(9);
  const passiveData = data ? segments(data, memory, base("__memory_base"), true) : false;
  if (elements) segments(elements, memory, base("__table_base"), false);
  return { ...profile, passiveData };
}
