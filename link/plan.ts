import type { Wasi } from "../core/wasi.js";
import {
  invalid,
  inspectProfile,
  requireSignature,
  sameSignature,
  type ModuleProfile,
} from "./metadata.js";
import { instantiateGroup, type LinkedGroup } from "./group.js";

export type { LinkedGroup } from "./group.js";
export interface LinkMemberSource {
  readonly id: string;
  readonly source: Uint8Array;
  readonly cooperative: true;
  readonly checkpoint: { readonly module: string; readonly name: string };
  readonly initialize: readonly string[];
}
export interface LinkPlanSource {
  readonly core: LinkMemberSource;
  readonly libraries: readonly LinkMemberSource[];
  readonly reserve: string;
}
export interface LinkHost {
  readonly wasi: Wasi;
  readonly coreImports?: WebAssembly.Imports;
  checkActive(): void;
  bindMemory?(memory: WebAssembly.Memory): void;
}
export interface CompiledMember {
  readonly id: string;
  readonly module: WebAssembly.Module;
  readonly profile: ModuleProfile;
  readonly initialize: readonly string[];
}
export interface PlanData {
  readonly core: CompiledMember;
  readonly libraries: readonly CompiledMember[];
  readonly reserve: string;
  readonly source: LinkPlanSource;
}
const plans = new WeakMap<PreparedLinkPlan, PlanData>();
const code = new Map<string, Promise<WebAssembly.Module>>();

export class PreparedLinkPlan {
  private constructor(readonly entryModule: WebAssembly.Module) {}
  /** Exact-byte structured-clone transport. Receivers must prepare it again. */
  toSource(): LinkPlanSource {
    const data = plans.get(this);
    if (!data) return invalid("plan", "expected a local prepared plan");
    return snapshotPlan(data.source);
  }
  static async prepare(source: LinkPlanSource): Promise<PreparedLinkPlan> {
    const owned = snapshotPlan(source);
    const members = [owned.core].concat(owned.libraries);
    const reserve = owned.reserve;
    const ids = members.map((member) => member.id);
    if (new Set(ids).size !== ids.length) invalid("plan", "duplicate member id");
    const compiled: CompiledMember[] = [];
    for (let index = 0; index < members.length; index++)
      compiled.push(await compile(members[index]!, index !== 0));
    const core = compiled[0]!;
    requireSignature(core.profile, core.id, "_start", [], []);
    requireSignature(core.profile, core.id, reserve, [0x7f, 0x7f], [0x7f]);
    for (const member of compiled.slice(1)) validateCoreImports(core, member);
    const plan = Object.freeze(new PreparedLinkPlan(core.module));
    plans.set(plan, { core, libraries: compiled.slice(1), reserve, source: owned });
    return plan;
  }
}

function validateCoreImports(core: CompiledMember, member: CompiledMember): void {
  const exports = WebAssembly.Module.exports(core.module);
  for (const entry of member.profile.functionImports) {
    if (entry.module !== "env") continue;
    const provider = core.profile.functions.get(entry.name);
    if (!provider && exports.some((value) => value.name === entry.name))
      invalid(member.id, `core export env.${entry.name} must be a function`);
    if (!provider)
      invalid(
        member.id,
        `unresolved ${entry.binding === "weak" ? "weak direct" : "required"} function env.${entry.name}`,
      );
    if (!sameSignature(provider, entry))
      invalid(member.id, `env.${entry.name} has an incompatible core function signature`);
  }
  for (const entry of member.profile.globalImports) {
    if (entry.module === "env" && ["__memory_base", "__table_base"].includes(entry.name)) continue;
    const provider = core.profile.globalExports.get(entry.name);
    const mutable = entry.module === "GOT.mem" ? false : entry.mutable;
    if (!provider || provider.value !== entry.value || provider.mutable !== mutable)
      invalid(
        member.id,
        `${entry.module}.${entry.name} requires a core ${mutable ? "mutable" : "immutable"} i32 global export`,
      );
  }
}

function snapshotPlan(source: LinkPlanSource): LinkPlanSource {
  return {
    core: snapshot(source.core),
    libraries: Array.from(source.libraries, snapshot),
    reserve: source.reserve,
  };
}

function snapshot(member: LinkMemberSource): LinkMemberSource {
  if (!(member.source instanceof Uint8Array)) invalid(member.id, "source must be exact bytes");
  if (member.cooperative !== true) invalid(member.id, "explicit cooperative trust is required");
  return {
    id: member.id,
    source: new Uint8Array(member.source),
    cooperative: true,
    checkpoint: { module: member.checkpoint.module, name: member.checkpoint.name },
    initialize: Array.from(member.initialize),
  };
}

function validateInitializers(member: LinkMemberSource, profile: ModuleProfile): void {
  const scheduled = new Set<number>();
  const entry = profile.functions.get("_start");
  const relocation = profile.functions.get("__wasm_apply_data_relocs");
  for (const name of member.initialize) {
    requireSignature(profile, member.id, name, [], []);
    const fn = profile.functions.get(name)!;
    if (fn.index === entry?.index)
      invalid(member.id, `initializer ${name} is owned by command entry`);
    if (fn.index === relocation?.index)
      invalid(member.id, `initializer ${name} is owned by automatic relocation`);
    if (scheduled.has(fn.index)) invalid(member.id, `duplicate initializer ${name}`);
    scheduled.add(fn.index);
  }
}

async function compile(member: LinkMemberSource, side: boolean): Promise<CompiledMember> {
  const profile = inspectProfile(member.source, member.id, side);
  validateInitializers(member, profile);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(member.source)),
  );
  const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let pending = code.get(key);
  if (!pending) {
    pending = WebAssembly.compile(new Uint8Array(member.source));
    code.set(key, pending);
    if (code.size > 16) code.delete(code.keys().next().value!);
  }
  let module: WebAssembly.Module;
  try {
    module = await pending;
  } catch (error) {
    if (code.get(key) === pending) code.delete(key);
    if (error instanceof WebAssembly.CompileError) invalid(member.id, error.message);
    throw error;
  }
  if (
    profile.passiveData &&
    (!member.initialize.length || profile.functions.has("__wasm_apply_data_relocs"))
  )
    invalid(
      member.id,
      "passive data requires explicit ordered memory/relocation initialization; rename generic data reloc export",
    );
  const checkpoint = member.checkpoint;
  if (
    !WebAssembly.Module.imports(module).some(
      (entry) =>
        entry.kind === "function" &&
        entry.module === checkpoint.module &&
        entry.name === checkpoint.name,
    )
  )
    invalid(member.id, `checkpoint import ${checkpoint.module}.${checkpoint.name} is absent`);
  if (profile.functions.has("__wasm_apply_data_relocs"))
    requireSignature(profile, member.id, "__wasm_apply_data_relocs", [], []);
  return { id: member.id, module, profile, initialize: member.initialize };
}

export const prepareLinkPlan = PreparedLinkPlan.prepare;
export function instantiateLinkPlan(plan: PreparedLinkPlan, host: LinkHost): LinkedGroup {
  const data = plans.get(plan);
  if (!data) invalid("plan", "expected a local prepared plan, not a clone or manifest");
  return instantiateGroup(data, host);
}
