import { invalid, type MemoryInfo } from "./metadata.js";

declare const sharedLinkPlan: unique symbol;
/** Compiled modules and immutable metadata. Structured-clone it, never transfer it. */
export interface SharedLinkPlan {
  readonly [sharedLinkPlan]: "waffle.SharedLinkPlan";
}

export interface SelfImage {
  readonly targets: readonly string[];
  readonly targetSlots: readonly { readonly name: string; readonly slot: number }[];
  readonly relay: WebAssembly.Module | undefined;
}
export interface MemberImage {
  readonly id: string;
  readonly module: WebAssembly.Module;
  readonly layout: Readonly<MemoryInfo> | undefined;
  readonly baseOffsets: { readonly memory: number; readonly table: number };
  readonly initializeMemory: readonly string[];
  readonly initialize: readonly string[];
  readonly automaticRelocation: boolean;
  readonly self: SelfImage;
}
export interface PlanImage {
  readonly core: MemberImage;
  readonly libraries: readonly MemberImage[];
  readonly reserve: string;
  readonly pie: boolean;
  readonly relativeAddresses: readonly string[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") invalid("plan", "expected metadata record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid("plan", "expected plain metadata record");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") invalid("plan", "expected metadata string");
  return value;
}
function integer(value: unknown, maximum = 0xffffffff): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum)
    invalid("plan", "expected non-negative metadata integer");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid("plan", "expected metadata boolean");
  return value;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid("plan", "expected metadata array");
  return value;
}
function strings(value: unknown): readonly string[] {
  return Object.freeze(Array.from(array(value), string));
}
function module(value: unknown): WebAssembly.Module {
  if (!(value instanceof WebAssembly.Module)) invalid("plan", "expected compiled module");
  return value;
}
function layout(value: unknown): Readonly<MemoryInfo> | undefined {
  if (value === undefined) return undefined;
  const info = record(value);
  return Object.freeze({
    memorySize: integer(info.memorySize),
    memoryAlignment: integer(info.memoryAlignment, 31),
    tableSize: integer(info.tableSize),
    tableAlignment: integer(info.tableAlignment, 31),
  });
}
function self(value: unknown): SelfImage {
  const info = record(value);
  const targets = strings(info.targets);
  const names = new Set<string>();
  const targetSlots = Object.freeze(
    Array.from(array(info.targetSlots), (value) => {
      const entry = record(value);
      const name = string(entry.name),
        slot = integer(entry.slot);
      if (slot >= targets.length || names.has(name)) invalid("plan", "invalid self target slot");
      names.add(name);
      return Object.freeze({ name, slot });
    }),
  );
  const relay = info.relay === undefined ? undefined : module(info.relay);
  if (Boolean(targets.length) !== Boolean(relay)) invalid("plan", "invalid self relay");
  return Object.freeze({ targets, targetSlots, relay });
}
function member(value: unknown): MemberImage {
  const info = record(value);
  const offsets = record(info.baseOffsets);
  return Object.freeze({
    id: string(info.id),
    module: module(info.module),
    layout: layout(info.layout),
    baseOffsets: Object.freeze({ memory: integer(offsets.memory), table: integer(offsets.table) }),
    initializeMemory: strings(info.initializeMemory),
    initialize: strings(info.initialize),
    automaticRelocation: boolean(info.automaticRelocation),
    self: self(info.self),
  });
}

/** Own the small metadata snapshot; retain compiled module references without copying code. */
export function snapshotImage(value: unknown): PlanImage & SharedLinkPlan {
  const info = record(value);
  const core = member(info.core);
  const libraries = Object.freeze(Array.from(array(info.libraries), member));
  const ids = [core.id].concat(libraries.map((entry) => entry.id));
  if (new Set(ids).size !== ids.length) invalid("plan", "duplicate member id");
  if (libraries.some((entry) => !entry.layout)) invalid("plan", "missing side layout");
  const pie = boolean(info.pie);
  if (pie && !core.layout) invalid("plan", "missing PIE layout");
  const image: PlanImage = Object.freeze({
    core,
    libraries,
    pie,
    reserve: string(info.reserve),
    relativeAddresses: strings(info.relativeAddresses),
  });
  return image as PlanImage & SharedLinkPlan;
}
