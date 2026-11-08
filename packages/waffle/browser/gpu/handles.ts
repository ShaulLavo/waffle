import { gpuObjectKinds, gpuStream } from "./generated/tables.js";
import {
  GPU_LIMITS,
  GpuCallError,
  GpuProtocolError,
  GpuResourceError,
  type Handle,
} from "./protocol.js";

export type ObjectKind = keyof typeof gpuObjectKinds;
export type ObjectValue =
  | { readonly kind: "native"; readonly value: object }
  | { readonly kind: "exception"; readonly message: string };
type Slot = { readonly generation: number; readonly objectKind: ObjectKind } & (
  | { readonly kind: "reserved" }
  | { readonly kind: "released" }
  | ObjectValue
);

export function objectKind(name: string): ObjectKind {
  if (!Object.hasOwn(gpuObjectKinds, name)) throw new GpuProtocolError("Unknown object kind");
  return name as ObjectKind;
}
export function numericObjectKind(value: number): ObjectKind {
  const entry = Object.entries(gpuObjectKinds).find((entry) => entry[1] === value);
  if (!entry) throw new GpuProtocolError("Unknown numeric object kind");
  return objectKind(entry[0]);
}

/** Fixed slot range retains generations without a growing tombstone map. Service realm only. */
export class HandleTable {
  readonly #slots: (Slot | undefined)[];
  #live = true;
  readonly #references = new Map<object, { kind: ObjectKind; count: number }>();
  constructor(
    root: object,
    readonly dispose: (kind: ObjectKind, value: object) => void,
    readonly limit: number = GPU_LIMITS.handles,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > 65536)
      throw new RangeError("Invalid handle limit");
    this.#slots = Array.from({ length: limit + 1 }, () => undefined);
    this.#slots[gpuStream.root.id] = {
      generation: gpuStream.root.generation,
      objectKind: "instance",
      kind: "native",
      value: root,
    };
  }
  reserve(handle: Handle, kind: ObjectKind): void {
    if (!this.#live) throw new GpuProtocolError("Terminal handle table");
    if (handle.id <= 1) throw new GpuProtocolError("Reserved root result handle");
    if (handle.id > this.limit) throw new GpuResourceError("GPU handle slot limit");
    const prior = this.#slots[handle.id];
    const expected = prior ? prior.generation + 1 : 1;
    if (prior && prior.kind !== "released") throw new GpuProtocolError("Result handle is occupied");
    if (handle.generation !== expected || expected > 0xffffffff)
      throw new GpuProtocolError("Invalid result generation");
    this.#slots[handle.id] = { kind: "reserved", generation: handle.generation, objectKind: kind };
  }
  bind(handle: Handle, kind: ObjectKind, value: ObjectValue): boolean {
    if (!this.#live) return false;
    const slot = this.#slots[handle.id];
    if (!slot || slot.generation !== handle.generation || slot.kind === "released") return false;
    if (slot.objectKind !== kind || slot.kind !== "reserved")
      throw new GpuProtocolError("Invalid result binding");
    this.#slots[handle.id] = { ...value, generation: handle.generation, objectKind: kind };
    if (value.kind === "native") {
      const reference = this.#references.get(value.value);
      if (reference) reference.count++;
      else this.#references.set(value.value, { kind, count: 1 });
    }
    return true;
  }
  get(handle: Handle, kind: ObjectKind): ObjectValue {
    const slot = this.#slot(handle, kind);
    if (slot.kind === "reserved") throw new GpuProtocolError("Object result is still pending");
    if (slot.kind === "released") throw new GpuProtocolError("Object was released");
    return slot;
  }
  native(handle: Handle, kind: ObjectKind): object {
    const value = this.get(handle, kind);
    if (value.kind === "exception") throw new GpuCallError(value.message);
    return value.value;
  }
  release(handle: Handle, kind: ObjectKind): void {
    if (handle.id === gpuStream.root.id)
      throw new GpuProtocolError("Reserved root cannot be released");
    const slot = this.#slot(handle, kind);
    if (slot.kind === "released") throw new GpuProtocolError("Double release");
    this.#slots[handle.id] = { kind: "released", generation: slot.generation, objectKind: kind };
    if (slot.kind !== "native") return;
    const reference = this.#references.get(slot.value);
    if (!reference || --reference.count > 0) return;
    this.#references.delete(slot.value);
    this.dispose(kind, slot.value);
  }
  retire(): void {
    if (!this.#live) return;
    this.#live = false;
    this.#slots.length = 0;
    const failures: unknown[] = [];
    for (const [value, reference] of this.#references) {
      try { this.dispose(reference.kind, value); }
      catch (error) { failures.push(error); }
    }
    this.#references.clear();
    if (failures.length) throw new AggregateError(failures, "GPU native cleanup failed");
  }
  #slot(handle: Handle, kind: ObjectKind): Slot {
    const slot = this.#slots[handle.id];
    if (!this.#live || !slot || slot.generation !== handle.generation || slot.objectKind !== kind)
      throw new GpuProtocolError("Unknown, stale or wrong-kind object handle");
    return slot;
  }
}
