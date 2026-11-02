import type { CompiledMember, LinkHost, PlanData } from "./plan.js";
import { invalid } from "./metadata.js";

const RELOCATION = "__wasm_apply_data_relocs";
const claimedMembers = new WeakSet<WebAssembly.Global>();

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
  /** Empty until initialize() publishes all linked libraries. */
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

type Range = { base: number; size: number };

/** The single table allocator: side elements, relay targets and new function addresses. */
function reserveTable(
  table: WebAssembly.Table,
  member: string,
  size: number,
  alignmentExponent: number,
  ranges: Range[],
): number {
  const alignment = 2 ** alignmentExponent;
  const base = Math.ceil(Math.max(1, table.length) / alignment) * alignment;
  const end = base + Math.max(1, size);
  if (end > 4294967295) invalid(member, "table reservation overflows wasm32");
  table.grow(end - table.length);
  ranges.push({ base, size: Math.max(1, size) });
  return base;
}

/** Reuses an existing slot so the address matches the provider's own pointers. */
function functionSlot(
  table: WebAssembly.Table,
  target: Function,
  member: string,
  ranges: Range[],
): number {
  for (let index = 0; index < table.length; index++) {
    if (table.get(index) === target) return index;
  }
  const index = reserveTable(table, member, 1, 0, ranges);
  table.set(index, target);
  return index;
}

interface SelfSlots {
  readonly base: number;
  readonly relay: WebAssembly.Instance | undefined;
}

/** Reserves one target slot per same-side definition; slots stay empty until binding. */
function reserveSelf(member: CompiledMember, table: WebAssembly.Table, ranges: Range[]): SelfSlots {
  const { targets, relay } = member.self;
  if (!relay) return { base: 0, relay: undefined };
  const base = reserveTable(table, member.id, targets.length, 0, ranges);
  const env = { table, base: new WebAssembly.Global({ value: "i32", mutable: false }, base) };
  return { base, relay: new WebAssembly.Instance(relay, { env }) };
}

/** Fills target slots with the actual defined exports, before relocation or constructors. */
function bindSelf(
  member: CompiledMember,
  instance: WebAssembly.Instance,
  table: WebAssembly.Table,
  slots: SelfSlots,
): void {
  member.self.targets.forEach((name, slot) => {
    const target = instance.exports[name];
    if (typeof target !== "function")
      invalid(member.id, `same-side definition ${name} is not an exported function`);
    table.set(slots.base + slot, target);
  });
}

function functionCells(
  core: WebAssembly.Instance,
  member: CompiledMember,
  table: WebAssembly.Table,
  ranges: Range[],
  slots: SelfSlots,
): WebAssembly.ModuleImports {
  const cells: WebAssembly.ModuleImports = Object.create(null);
  for (const entry of WebAssembly.Module.imports(member.module)) {
    if (entry.module !== "GOT.func" || Object.hasOwn(cells, entry.name)) continue;
    const provider = core.exports[entry.name];
    const address =
      typeof provider === "function"
        ? functionSlot(table, provider, member.id, ranges)
        : slots.base + member.self.targetSlots.get(entry.name)!;
    cells[entry.name] = new WebAssembly.Global({ value: "i32", mutable: true }, address);
  }
  return cells;
}

/** Data symbols are nonzero addresses; linker stack bounds may sit at either memory edge. */
function dataAddress(name: string, address: number, memory: WebAssembly.Memory): boolean {
  if (name === "__stack_low" || name === "__stack_high") return address <= memory.buffer.byteLength;
  return address !== 0 && address < memory.buffer.byteLength;
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
  coreProfile: CompiledMember["profile"],
  slots: SelfSlots,
  ranges: Range[],
  coreBase: number,
  coreEnv: WebAssembly.ModuleImports | undefined,
): WebAssembly.Imports {
  const env: WebAssembly.ModuleImports = Object.create(null);
  for (const entry of WebAssembly.Module.imports(member.module)) {
    if (entry.module !== "env") continue;
    const shared = coreEnv?.[entry.name];
    const value =
      core.exports[entry.name] ?? (shared instanceof WebAssembly.Global ? shared : undefined);
    const slot = member.self.targetSlots.get(entry.name);
    if (entry.name === "memory") env[entry.name] = memory;
    else if (entry.name === "__indirect_function_table") env[entry.name] = table;
    else if (entry.name === "__memory_base")
      env[entry.name] = new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase);
    else if (entry.name === "__table_base")
      env[entry.name] = new WebAssembly.Global({ value: "i32", mutable: false }, tableBase);
    else if (value !== undefined) env[entry.name] = value;
    else if (slot !== undefined && slots.relay) env[entry.name] = slots.relay.exports[`f${slot}`]!;
    else invalid(member.id, `unresolved core export env.${entry.name}`);
  }
  for (const entry of WebAssembly.Module.imports(member.module)) {
    if (entry.module !== "GOT.mem" || Object.hasOwn(got, entry.name)) continue;
    if (!coreProfile.immutableI32Exports.has(entry.name))
      invalid(member.id, `GOT.mem.${entry.name} requires an immutable core i32 address export`);
    const symbol = core.exports[entry.name];
    if (!(symbol instanceof WebAssembly.Global) || typeof symbol.value !== "number")
      invalid(member.id, `GOT.mem.${entry.name} requires a core i32 address export`);
    // PIE data exports without extended-const are relative to the core's __memory_base.
    const relative = coreProfile.relativeExports.has(entry.name) ? coreBase : 0;
    const address = (symbol.value + relative) >>> 0;
    if (!dataAddress(entry.name, address, memory))
      invalid(member.id, `GOT.mem.${entry.name} address is outside core memory`);
    got[entry.name] = new WebAssembly.Global({ value: "i32", mutable: true }, address);
  }
  const func = functionCells(core, member, table, ranges, slots);
  return host.wasi.imports(member.module, { env, "GOT.mem": got, "GOT.func": func });
}

function memoryStages(member: CompiledMember): readonly string[] {
  return member.automaticRelocation
    ? [RELOCATION].concat(member.initializeMemory)
    : member.initializeMemory;
}

function runStages(
  member: CompiledMember,
  instance: WebAssembly.Instance,
  names: readonly string[],
  host: LinkHost,
  live: () => void,
): void {
  for (const name of names) {
    host.checkActive();
    live();
    exportedFunction(instance, member.id, name, 0)();
    live();
  }
}

function clearTable(table: WebAssembly.Table, ranges: readonly Range[]): void {
  for (const range of ranges) {
    for (let index = 0; index < range.size; index++) table.set(range.base + index, null);
  }
}

function claimMember(member: CompiledMember, imports: WebAssembly.Imports): void {
  const base = imports.env?.__memory_base;
  if (!(base instanceof WebAssembly.Global))
    invalid(member.id, "PIE core requires a carved __memory_base");
  if (claimedMembers.has(base)) invalid(member.id, "member bindings were already instantiated");
  claimedMembers.add(base);
}

function linkLibrary(
  member: CompiledMember,
  plan: PlanData,
  core: WebAssembly.Instance,
  host: LinkHost,
  memory: WebAssembly.Memory,
  table: WebAssembly.Table,
  libraries: LinkedLibrary[],
  ranges: Range[],
  got: WebAssembly.ModuleImports,
  coreBase: number,
  coreEnv: WebAssembly.ModuleImports | undefined,
  live: () => void,
): void {
  host.checkActive();
  live();
  const memoryBase = reserveMemory(core, member, plan.reserve, memory, libraries);
  live();
  host.checkActive();
  live();
  const layout = member.profile.memory!;
  const tableBase = reserveTable(table, member.id, layout.tableSize, layout.tableAlignment, ranges);
  if (
    memoryBase + member.profile.baseOffsets.memory > 4294967295 ||
    tableBase + member.profile.baseOffsets.table > 4294967295
  )
    invalid(member.id, "relative global address overflows wasm32");
  new Uint8Array(memory.buffer, memoryBase, layout.memorySize).fill(0);
  const slots = reserveSelf(member, table, ranges);
  const imports = sideImports(
    core,
    member,
    host,
    memory,
    table,
    memoryBase,
    tableBase,
    got,
    plan.core.profile,
    slots,
    ranges,
    coreBase,
    coreEnv,
  );
  host.checkActive();
  live();
  const instance = instantiate(member, imports);
  live();
  bindSelf(member, instance, table, slots);
  libraries.push({
    id: member.id,
    instance,
    memoryBase,
    tableBase,
    memorySize: layout.memorySize,
    tableSize: layout.tableSize,
  });
  runStages(member, instance, memoryStages(member), host, live);
  runStages(member, instance, member.initialize, host, live);
}

type LifecycleState = "linking" | "linked" | "initializing" | "ready" | "poisoned" | "disposed";

export function instantiateGroup(plan: PlanData, host: LinkHost): LinkedGroup {
  host.checkActive();
  const pie = plan.core.profile.pie;
  // A PIE core runs in a memory group: its env image (shared memory, own table) is supplied.
  if (pie && !host.coreImports?.env?.memory)
    invalid(plan.core.id, "PIE core requires a memory group");
  const coreImports = host.coreImports ?? host.wasi.imports(plan.core.module);
  if (pie) claimMember(plan.core, coreImports);
  const core = instantiate(plan.core, coreImports);
  const coreEnv = pie ? coreImports.env : undefined;
  const memory = pie ? coreEnv!.memory : core.exports.memory,
    table = pie ? coreEnv!.__indirect_function_table : core.exports.__indirect_function_table;
  if (!(memory instanceof WebAssembly.Memory)) invalid(plan.core.id, "core must export memory");
  if (!(table instanceof WebAssembly.Table))
    invalid(plan.core.id, "core must export __indirect_function_table");
  exportedFunction(core, plan.core.id, "_start", 0);
  exportedFunction(core, plan.core.id, plan.reserve, 2);
  const libraries: LinkedLibrary[] = [];
  const ranges: Range[] = [];
  const got: WebAssembly.ModuleImports = Object.create(null);
  const coreBase = pie ? (coreEnv!.__memory_base as WebAssembly.Global).value : 0;
  const lifecycle: { state: LifecycleState } = { state: "linking" };
  const live = () => {
    if (lifecycle.state !== "linking" && lifecycle.state !== "initializing")
      throw new Error(`link group is ${lifecycle.state}`);
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
    host.checkActive();
    host.bindMemory?.(memory);
    host.wasi.bindMemory(memory);
    runStages(plan.core, core, memoryStages(plan.core), host, live);
    host.checkActive();
    lifecycle.state = "linked";
  } catch (error) {
    dispose();
    throw error;
  }
  let publishedLibraries: readonly LinkedLibrary[] = Object.freeze([]);
  return {
    entry: core,
    memory,
    table,
    get libraries() {
      return publishedLibraries;
    },
    initialize() {
      if (lifecycle.state === "ready") return;
      if (lifecycle.state !== "linked") throw new Error(`link group is ${lifecycle.state}`);
      lifecycle.state = "initializing";
      try {
        runStages(plan.core, core, plan.core.initialize, host, live);
        for (const member of plan.libraries)
          linkLibrary(
            member,
            plan,
            core,
            host,
            memory,
            table,
            libraries,
            ranges,
            got,
            coreBase,
            coreEnv,
            live,
          );
        host.checkActive();
        live();
        publishedLibraries = Object.freeze(libraries);
        lifecycle.state = "ready";
      } catch (error) {
        poison();
        throw error;
      }
    },
    dispose,
  };
}
