import {
  recordModuleMemory,
  parseModuleMemory,
  type MemoryDeclaration,
} from "../memory/declarations.js";
import {
  snapshotImage,
  type CompiledMember,
  type PlanData,
  type SelfPlan,
  type SharedLinkPlan,
} from "./image.js";
import { issueGroupPlan } from "./issuance.js";
export type { SharedLinkPlan } from "./image.js";
import type { Wasi } from "../core/wasi.js";
import {
  invalid,
  inspectProfile,
  requireSignature,
  sameSignature,
  type ModuleProfile,
} from "./metadata.js";
import { instantiateGroup, type LinkedGroup } from "./group.js";
import { relayModule } from "./relay.js";
import { growthFree } from "./code.js";

export type { LinkedGroup } from "./group.js";
export interface LinkMemberSource {
  readonly id: string;
  readonly source: Uint8Array;
  readonly cooperative: true;
  readonly checkpoint: { readonly module: string; readonly name: string };
  /** Ordered memory and relocation stages, completed before the instance escapes. */
  readonly initializeMemory: readonly string[];
  /** Ordered constructor and registration stages, run by initialize(). */
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
interface OwnedMember extends LinkMemberSource {
  readonly source: Uint8Array<ArrayBuffer>;
}
interface ValidatedMember {
  readonly source: OwnedMember;
  readonly profile: ModuleProfile;
  readonly declarations: readonly MemoryDeclaration[];
  readonly automaticRelocation: boolean;
}
interface ProfiledMember extends CompiledMember {
  readonly profile: ModuleProfile;
}
const plans = new WeakMap<PreparedLinkPlan, PlanData>();
const NO_SELF: SelfPlan = { targets: [], targetSlots: [], relay: undefined };

export class PreparedLinkPlan {
  private constructor(
    readonly entryModule: WebAssembly.Module,
    readonly shared: SharedLinkPlan,
  ) {}
  static async prepare(source: LinkPlanSource): Promise<PreparedLinkPlan> {
    const owned = snapshotPlan(source);
    const members = [owned.core].concat(owned.libraries);
    const ids = members.map((member) => member.id);
    if (new Set(ids).size !== ids.length) invalid("plan", "duplicate member id");
    const validated = members.map((member, index) => validateMember(member, index !== 0));
    const coreInput = validated[0]!;
    if (coreInput.profile.pie)
      validated.forEach((member) => {
        if (!growthFree(member.source.source, member.source.id))
          invalid(
            member.source.id,
            "a memory group image cannot use memory.grow; grow through group_grow",
          );
      });
    requireSignature(coreInput.profile, coreInput.source.id, "_start", [], []);
    requireSignature(coreInput.profile, coreInput.source.id, owned.reserve, [0x7f, 0x7f], [0x7f]);
    // Every rejection is observed as compilation starts. All byte reads end before this await.
    const results = await Promise.allSettled(validated.map(compileMember));
    const compiled = results.map((result, index) => {
      if (result.status === "rejected") return formatError(members[index]!.id, result.reason);
      return result.value;
    });
    const core = compiled[0]!;
    if (core.profile.pie)
      compiled.forEach((member) => {
        if (WebAssembly.Module.exports(member.module).some((entry) => entry.kind === "memory"))
          invalid(member.id, "a memory group image cannot export the shared memory");
      });
    const libraries: CompiledMember[] = [];
    for (const member of compiled.slice(1))
      libraries.push({ ...member, self: await selectProviders(core, member) });
    const importedAddresses = new Set(
      compiled
        .slice(1)
        .flatMap((member) =>
          member.profile.globalImports
            .filter((entry) => entry.module === "GOT.mem")
            .map((entry) => entry.name),
        ),
    );
    const relativeAddresses = Array.from(core.profile.relativeExports).filter((name) =>
      importedAddresses.has(name),
    );
    const image = snapshotImage({
      core,
      libraries,
      reserve: owned.reserve,
      pie: core.profile.pie,
      relativeAddresses,
    });
    const plan = Object.freeze(new PreparedLinkPlan(core.module, image));
    plans.set(plan, image);
    if (image.pie) issueGroupPlan(image, core.module);
    return plan;
  }
  /** Synchronous receiving-side adoption. No parsing, hashing or compilation. */
  static adopt(shared: SharedLinkPlan): PreparedLinkPlan {
    const image = snapshotImage(shared);
    const plan = Object.freeze(new PreparedLinkPlan(image.core.module, image));
    plans.set(plan, image);
    return plan;
  }
}

function selfTarget(member: ProfiledMember, name: string, kind: string): void {
  const local = member.profile.functions.get(name);
  if (local && !local.defined)
    invalid(member.id, `${kind}.${name} same-side export re-exports an import, not a definition`);
}

/** Core preempts; otherwise only a defined same-member export of the exact type binds. */
async function selectProviders(core: ProfiledMember, member: ProfiledMember): Promise<SelfPlan> {
  const exports = WebAssembly.Module.exports(core.module);
  const targets: string[] = [];
  const targetSlots = new Map<string, number>();
  const target = (name: string) => {
    const identity = member.profile.functions.get(name)!.index;
    const known = targets.findIndex(
      (targetName) => member.profile.functions.get(targetName)!.index === identity,
    );
    const slot = known >= 0 ? known : targets.push(name) - 1;
    targetSlots.set(name, slot);
    return slot;
  };
  for (const entry of member.profile.functionImports) {
    if (entry.module !== "env") continue;
    const coreProvider = core.profile.functions.get(entry.name);
    if (!coreProvider && exports.some((value) => value.name === entry.name))
      invalid(member.id, `core export env.${entry.name} must be a function`);
    // wasm-ld imports a shared library's visible definitions so they stay preemptible:
    // the same member exports the definition under the import's name.
    if (!coreProvider) selfTarget(member, entry.name, "env");
    const provider = coreProvider ?? member.profile.functions.get(entry.name);
    if (!provider)
      invalid(
        member.id,
        `unresolved ${entry.binding === "weak" ? "weak direct" : "required"} function env.${entry.name}`,
      );
    if (!sameSignature(provider, entry))
      invalid(
        member.id,
        `env.${entry.name} has an incompatible ${coreProvider ? "core" : "same-side"} function signature`,
      );
    if (!coreProvider) target(entry.name);
  }
  for (const entry of member.profile.globalImports) {
    if (entry.module === "env" && ["__memory_base", "__table_base"].includes(entry.name)) continue;
    if (entry.module === "GOT.func") continue;
    // A PIE core imports its stack pointer; a side shares that same imported global.
    const provider =
      core.profile.globalExports.get(entry.name) ??
      (core.profile.pie && entry.module === "env"
        ? core.profile.globalImports.find((g) => g.module === "env" && g.name === entry.name)
        : undefined);
    const mutable = entry.module === "GOT.mem" ? false : entry.mutable;
    if (!provider || provider.value !== entry.value || provider.mutable !== mutable)
      invalid(
        member.id,
        `${entry.module}.${entry.name} requires a core ${mutable ? "mutable" : "immutable"} i32 global export`,
      );
  }
  for (const entry of member.profile.globalImports) {
    if (entry.module !== "GOT.func" || core.profile.functions.has(entry.name)) continue;
    if (exports.some((value) => value.name === entry.name))
      invalid(member.id, `core export GOT.func.${entry.name} must be a function`);
    selfTarget(member, entry.name, "GOT.func");
    if (!member.profile.functions.has(entry.name))
      invalid(member.id, `GOT.func.${entry.name} requires a core or same-side function export`);
    target(entry.name);
  }
  if (!targets.length) return NO_SELF;
  const signatures = targets.map((name) => member.profile.functions.get(name)!);
  return {
    targets,
    targetSlots: Array.from(targetSlots, ([name, slot]) => ({ name, slot })),
    relay: await WebAssembly.compile(relayModule(signatures)),
  };
}

function snapshotPlan(source: LinkPlanSource): {
  core: OwnedMember;
  libraries: OwnedMember[];
  reserve: string;
} {
  return {
    core: snapshot(source.core),
    libraries: Array.from(source.libraries, snapshot),
    reserve: source.reserve,
  };
}

function snapshot(member: LinkMemberSource): OwnedMember {
  if (!(member.source instanceof Uint8Array)) invalid(member.id, "source must be exact bytes");
  if (member.cooperative !== true) invalid(member.id, "explicit cooperative trust is required");
  return {
    id: member.id,
    source:
      member.source.buffer instanceof ArrayBuffer
        ? new Uint8Array(member.source.buffer, member.source.byteOffset, member.source.byteLength)
        : new Uint8Array(member.source),
    cooperative: true,
    checkpoint: { module: member.checkpoint.module, name: member.checkpoint.name },
    initializeMemory: copyStageNames(member, "initializeMemory"),
    initialize: copyStageNames(member, "initialize"),
  };
}

const RELOCATION = "__wasm_apply_data_relocs";

function copyStageNames(
  member: LinkMemberSource,
  field: "initializeMemory" | "initialize",
): readonly string[] {
  const stages = member[field];
  if (!Array.isArray(stages)) invalid(member.id, `${field} must list export names`);
  const names = Array.from(stages);
  if (!names.every((name) => typeof name === "string"))
    invalid(member.id, `${field} must list export names`);
  return names;
}

function validateStages(member: LinkMemberSource, profile: ModuleProfile, side: boolean): boolean {
  const scheduled = new Set<number>();
  const entry = profile.functions.get("_start");
  const relocation = profile.functions.get(RELOCATION);
  const memoryStages = member.initializeMemory;
  const allStages = memoryStages.concat(member.initialize);
  for (const name of allStages) {
    requireSignature(profile, member.id, name, [], []);
    const fn = profile.functions.get(name)!;
    if (fn.index === entry?.index)
      invalid(member.id, `initializer ${name} is owned by command entry`);
    if (scheduled.has(fn.index)) invalid(member.id, `duplicate initializer ${name}`);
    scheduled.add(fn.index);
    if (fn.index === relocation?.index && !memoryStages.some((stage) => stage === name))
      invalid(member.id, `relocation ${name} must be a memory stage`);
  }
  if (profile.passiveData && !memoryStages.length)
    invalid(member.id, "passive data requires declared memory stages");
  const listedRelocation = Boolean(
    relocation &&
    memoryStages.some((name) => profile.functions.get(name)?.index === relocation.index),
  );
  const firstStage = memoryStages[0];
  if (
    profile.passiveData &&
    relocation &&
    firstStage !== undefined &&
    profile.functions.get(firstStage)?.index === relocation.index
  )
    invalid(member.id, "relocation cannot precede passive memory initialization");
  if (relocation && !listedRelocation && (profile.passiveData || profile.pie))
    invalid(member.id, `${RELOCATION} must be a declared memory stage`);
  return Boolean(relocation && side && !listedRelocation);
}

function formatError(id: string, error: unknown): never {
  if (error instanceof WebAssembly.CompileError) invalid(id, error.message);
  throw error;
}

function validateMember(member: OwnedMember, side: boolean): ValidatedMember {
  const profile = inspectProfile(member.source, member.id, side);
  const automaticRelocation = validateStages(member, profile, side);
  if (profile.functions.has(RELOCATION)) requireSignature(profile, member.id, RELOCATION, [], []);
  try {
    return {
      source: member,
      profile,
      automaticRelocation,
      declarations: parseModuleMemory(member.source),
    };
  } catch (error) {
    return formatError(member.id, error);
  }
}

async function compileMember(member: ValidatedMember): Promise<ProfiledMember> {
  const source = member.source;
  const module = await WebAssembly.compile(source.source);
  recordModuleMemory(module, member.declarations);
  const checkpoint = source.checkpoint;
  if (
    !WebAssembly.Module.imports(module).some(
      (entry) =>
        entry.kind === "function" &&
        entry.module === checkpoint.module &&
        entry.name === checkpoint.name,
    )
  )
    invalid(source.id, `checkpoint import ${checkpoint.module}.${checkpoint.name} is absent`);
  return {
    id: source.id,
    module,
    profile: member.profile,
    layout: member.profile.memory,
    baseOffsets: member.profile.baseOffsets,
    initializeMemory: source.initializeMemory,
    initialize: source.initialize,
    automaticRelocation: member.automaticRelocation,
    self: NO_SELF,
  };
}

export const prepareLinkPlan = PreparedLinkPlan.prepare;
export const adoptLinkPlan = PreparedLinkPlan.adopt;
export function instantiateLinkPlan(plan: PreparedLinkPlan, host: LinkHost): LinkedGroup {
  const data = plans.get(plan);
  if (!data) invalid("plan", "expected a local prepared plan, not a clone or manifest");
  return instantiateGroup(data, host);
}
