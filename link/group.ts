import type { CompiledMember, LinkHost, PlanData } from "./plan.js";
import { invalid } from "./metadata.js";

export interface LinkedLibrary {
  readonly id: string;
  readonly instance: WebAssembly.Instance;
  readonly memoryBase: number;
  readonly memorySize: number;
  readonly tableBase: number;
  readonly tableSize: number;
}
export interface LinkedGroup {
  readonly entry: WebAssembly.Instance;
  readonly memory: WebAssembly.Memory;
  readonly table: WebAssembly.Table;
  readonly libraries: readonly LinkedLibrary[];
  initialize(): void;
  dispose(): void;
}

function instantiate(member: CompiledMember, imports: WebAssembly.Imports): WebAssembly.Instance {
  try {
    return new WebAssembly.Instance(member.module, imports);
  } catch (error) {
    if (error instanceof WebAssembly.LinkError) invalid(member.id, error.message);
    throw error;
  }
}

function exportedFunction(
  instance: WebAssembly.Instance,
  member: string,
  name: string,
  arity: number,
) {
  const fn = instance.exports[name];
  if (typeof fn !== "function" || fn.length !== arity)
    invalid(member, `export ${name} must be a function with ${arity} arguments`);
  return fn;
}

function reserveMemory(
  core: WebAssembly.Instance,
  member: CompiledMember,
  reserve: string,
  memory: WebAssembly.Memory,
  libraries: readonly LinkedLibrary[],
): number {
  const info = member.profile.memory;
  if (!info) return invalid(member.id, "missing side layout");
  const size = Math.max(1, info.memorySize),
    alignment = 2 ** info.memoryAlignment;
  const result: unknown = exportedFunction(core, "core", reserve, 2)(size, alignment);
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < -2147483648 ||
    result > 4294967295
  )
    invalid(member.id, "reservation must return a wasm32 pointer");
  const base = result >>> 0;
  if (base === 0) throw new RangeError(`link ${member.id}: core reservation failed`);
  if (base % alignment !== 0 || size > memory.buffer.byteLength - base)
    invalid(member.id, "core reservation is unaligned or out of bounds");
  for (const other of libraries) {
    if (base < other.memoryBase + Math.max(1, other.memorySize) && other.memoryBase < base + size)
      invalid(member.id, `core reservation overlaps ${other.id}`);
  }
  return base;
}

function reserveTable(table: WebAssembly.Table, member: CompiledMember): number {
  const info = member.profile.memory;
  if (!info) return invalid(member.id, "missing side layout");
  const alignment = 2 ** info.tableAlignment;
  const base = Math.ceil(Math.max(1, table.length) / alignment) * alignment;
  const end = base + Math.max(1, info.tableSize);
  if (end > 4294967295) invalid(member.id, "table reservation overflows wasm32");
  table.grow(end - table.length);
  return base;
}

function sideImports(
  core: WebAssembly.Instance,
  member: CompiledMember,
  host: LinkHost,
  memory: WebAssembly.Memory,
  table: WebAssembly.Table,
  memoryBase: number,
  tableBase: number,
  got: WebAssembly.ModuleImports,
  immutableI32Exports: ReadonlySet<string>,
): WebAssembly.Imports {
  const env: WebAssembly.ModuleImports = Object.create(null);
  for (const entry of WebAssembly.Module.imports(member.module)) {
    if (entry.module !== "env") continue;
    const value = core.exports[entry.name];
    if (entry.name === "memory") env[entry.name] = memory;
    else if (entry.name === "__indirect_function_table") env[entry.name] = table;
    else if (entry.name === "__memory_base")
      env[entry.name] = new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase);
    else if (entry.name === "__table_base")
      env[entry.name] = new WebAssembly.Global({ value: "i32", mutable: false }, tableBase);
    else if (value !== undefined) env[entry.name] = value;
    else invalid(member.id, `unresolved core export env.${entry.name}`);
  }
  for (const entry of WebAssembly.Module.imports(member.module)) {
    if (entry.module !== "GOT.mem" || Object.hasOwn(got, entry.name)) continue;
    if (!immutableI32Exports.has(entry.name))
      invalid(member.id, `GOT.mem.${entry.name} requires an immutable core i32 address export`);
    const symbol = core.exports[entry.name];
    if (!(symbol instanceof WebAssembly.Global) || typeof symbol.value !== "number")
      invalid(member.id, `GOT.mem.${entry.name} requires a core i32 address export`);
    const address = symbol.value >>> 0;
    if (!address || address >= memory.buffer.byteLength)
      invalid(member.id, `GOT.mem.${entry.name} address is outside core memory`);
    got[entry.name] = new WebAssembly.Global({ value: "i32", mutable: true }, address);
  }
  return host.wasi.imports(member.module, { env, "GOT.mem": got });
}

function initializeMember(
  member: CompiledMember,
  instance: WebAssembly.Instance,
  host: LinkHost,
): void {
  for (const name of member.initialize) {
    host.checkActive();
    exportedFunction(instance, member.id, name, 0)();
  }
}

function clearTable(
  table: WebAssembly.Table,
  ranges: readonly { base: number; size: number }[],
): void {
  for (const range of ranges) {
    for (let index = 0; index < range.size; index++) table.set(range.base + index, null);
  }
}

function linkLibrary(
  member: CompiledMember,
  plan: PlanData,
  core: WebAssembly.Instance,
  host: LinkHost,
  memory: WebAssembly.Memory,
  table: WebAssembly.Table,
  libraries: LinkedLibrary[],
  ranges: { base: number; size: number }[],
  got: WebAssembly.ModuleImports,
): void {
  host.checkActive();
  const memoryBase = reserveMemory(core, member, plan.reserve, memory, libraries);
  host.checkActive();
  const tableBase = reserveTable(table, member);
  const layout = member.profile.memory!;
  ranges.push({ base: tableBase, size: Math.max(1, layout.tableSize) });
  new Uint8Array(memory.buffer, memoryBase, layout.memorySize).fill(0);
  const imports = sideImports(
    core,
    member,
    host,
    memory,
    table,
    memoryBase,
    tableBase,
    got,
    plan.core.profile.immutableI32Exports,
  );
  host.checkActive();
  const instance = instantiate(member, imports);
  libraries.push({
    id: member.id,
    instance,
    memoryBase,
    tableBase,
    memorySize: layout.memorySize,
    tableSize: layout.tableSize,
  });
  if (instance.exports.__wasm_apply_data_relocs === undefined) return;
  host.checkActive();
  exportedFunction(instance, member.id, "__wasm_apply_data_relocs", 0)();
}

export function instantiateGroup(plan: PlanData, host: LinkHost): LinkedGroup {
  host.checkActive();
  const core = instantiate(plan.core, host.coreImports ?? host.wasi.imports(plan.core.module));
  const memory = core.exports.memory,
    table = core.exports.__indirect_function_table;
  if (!(memory instanceof WebAssembly.Memory)) invalid(plan.core.id, "core must export memory");
  if (!(table instanceof WebAssembly.Table))
    invalid(plan.core.id, "core must export __indirect_function_table");
  exportedFunction(core, plan.core.id, "_start", 0);
  exportedFunction(core, plan.core.id, plan.reserve, 2);
  host.checkActive();
  host.bindMemory?.(memory);
  host.wasi.bindMemory(memory);
  const libraries: LinkedLibrary[] = [];
  const ranges: { base: number; size: number }[] = [];
  const got: WebAssembly.ModuleImports = Object.create(null);
  const lifecycle: { state: "linked" | "initializing" | "ready" | "poisoned" | "disposed" } = {
    state: "linked",
  };
  const dispose = () => {
    if (lifecycle.state === "disposed") return;
    lifecycle.state = "disposed";
    clearTable(table, ranges);
  };
  const poison = () => {
    if (lifecycle.state !== "disposed") lifecycle.state = "poisoned";
  };
  try {
    for (const member of plan.libraries)
      linkLibrary(member, plan, core, host, memory, table, libraries, ranges, got);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    entry: core,
    memory,
    table,
    libraries: Object.freeze(libraries),
    initialize() {
      if (lifecycle.state === "ready") return;
      if (lifecycle.state !== "linked") throw new Error(`link group is ${lifecycle.state}`);
      lifecycle.state = "initializing";
      try {
        initializeMember(plan.core, core, host);
        for (let index = 0; index < libraries.length; index++)
          initializeMember(plan.libraries[index]!, libraries[index]!.instance, host);
        host.checkActive();
        if (lifecycle.state !== "initializing") throw new Error(`link group is ${lifecycle.state}`);
        lifecycle.state = "ready";
      } catch (error) {
        poison();
        throw error;
      }
    },
    dispose,
  };
}
