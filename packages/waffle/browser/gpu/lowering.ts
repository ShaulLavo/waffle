import type { WireTables } from "../../tooling/gpu-stream-model.js";
import { gpuDictionaryMembers, gpuSentinels, gpuStream } from "./generated/tables.js";
import {
  safeGpuNumber,
  wireArray,
  wireHandle,
  wireNumber,
  wireObject,
  type WireObject,
  type WireValue,
} from "./codec.js";
import { HandleTable, objectKind } from "./handles.js";
import { GpuCallError, GpuProtocolError } from "./protocol.js";

export type Dictionary = Record<string, unknown>;
const dictionaries: Readonly<Record<string, Readonly<Record<string, string | null>>>> =
  gpuDictionaryMembers;
const sentinels: Readonly<Record<string, string>> = gpuSentinels;

function browserEnum(type: string, value: number): string | number | undefined {
  const name = Object.keys(tables.enums[type] ?? {}).find(
    (name) => tables.enums[type]?.[name] === value,
  );
  if (!name) throw new GpuProtocolError(`Unknown ${type}`);
  const mapped = tables.browserEnums[type]?.[name];
  if (mapped === undefined || mapped === null)
    throw new GpuCallError(`Unsupported browser ${type}.${name}`);
  return mapped === "@omit" ? undefined : mapped;
}
function browserFlags(type: string, value: bigint): number {
  const number = safeGpuNumber(value);
  const mask = Object.values(tables.browserEnums[type] ?? {}).reduce<number>(
    (bits, item) => bits | (typeof item === "number" ? item : 0),
    0,
  );
  if ((value & ~BigInt(mask)) !== 0n) throw new GpuCallError(`Unsupported browser ${type} bits`);
  return number;
}
function omitSentinel(struct: string, name: string, value: WireValue): boolean {
  if (struct === "limits" && (value === 0xffffffff || value === 0xffffffffffffffffn)) return true;
  if (struct === "pass_timestamp_writes" && name.endsWith("_index") && value === 0xffffffff)
    return true;
  const rule = sentinels[`${struct}.${name}`];
  if (rule === "uint32_max-to-omit" && value === 0xffffffff) return true;
  if (rule === "uint64_max-to-omit" && value === 0xffffffffffffffffn) return true;
  return rule === "nan-to-omit" && typeof value === "number" && Number.isNaN(value);
}

/** Generated member names with explicit C-to-browser value policies, never name guessing. */
export class DescriptorLowering {
  constructor(readonly handles: HandleTable) {}
  dictionary(name: string, value: WireValue | undefined): Dictionary | undefined {
    if (value === null) return undefined;
    const input = wireObject(value);
    if (name === "bind_group_entry") return this.#bindingResource(input);
    if (name === "texel_copy_buffer_info")
      return Object.assign(
        Object.create(null),
        this.dictionary("texel_copy_buffer_layout", input.layout),
        { buffer: this.value("object.buffer", input.buffer ?? null) },
      );
    if (name === "bind_group_layout_entry" && input.binding_array_size !== 0)
      throw new GpuCallError("Browser binding arrays are unsupported");
    const layout = tables.structs[name];
    const names = dictionaries[name];
    if (!layout || !names) throw new GpuProtocolError(`Unclassified descriptor ${name}`);
    const output: Dictionary = Object.create(null);
    for (const field of layout.fields) {
      const member = names[field.name];
      const raw = input[field.name];
      if (
        member === null ||
        member === undefined ||
        raw === undefined ||
        omitSentinel(name, field.name, raw)
      )
        continue;
      const lowered = this.#member(name, field.name, field.type, raw);
      if (lowered !== undefined) output[member] = lowered;
    }
    return output;
  }
  value(type: string, value: WireValue): unknown {
    if (value === null) return undefined;
    if (type.startsWith("object."))
      return this.handles.native(wireHandle(value), objectKind(type.slice(7)));
    if (type === "enum.optional_bool") {
      const optional = browserEnum(type, wireNumber(value));
      return optional === undefined ? undefined : optional === 1;
    }
    if (type.startsWith("enum.")) return browserEnum(type, wireNumber(value));
    if (type.startsWith("bitflag.")) {
      if (typeof value !== "bigint") throw new GpuProtocolError("Expected flag bits");
      return browserFlags(type, value);
    }
    if (type.startsWith("struct.")) return this.dictionary(type.slice(7), value);
    if (type.startsWith("array<"))
      return wireArray(value).map((item) => this.value(type.slice(6, -1), item));
    if (typeof value === "bigint") return safeGpuNumber(value);
    return value;
  }
  adapterOptions(value: WireValue | undefined): Dictionary | undefined {
    if (value === null) return undefined;
    const input = wireObject(value);
    if (input.feature_level !== 0 && input.feature_level !== 2)
      throw new GpuCallError("Only core feature level is supported");
    if (input.backend_type !== 0) throw new GpuCallError("Backend selection is unsupported");
    if (input.compatible_surface !== null)
      this.handles.native(wireHandle(input.compatible_surface), "surface");
    return this.dictionary("request_adapter_options", input);
  }
  deviceDescriptor(value: WireValue | undefined): Dictionary | undefined {
    return this.dictionary("device_descriptor", value);
  }
  wgsl(value: WireValue | undefined): Dictionary {
    const input = wireObject(value);
    const extension = onlyExtension(input, "shader_module_descriptor", "shader_source_WGSL");
    const descriptor = this.dictionary("shader_module_descriptor", input) ?? Object.create(null);
    descriptor.code = extension.code;
    return descriptor;
  }
  pipeline(value: WireValue | undefined): Dictionary {
    return this.dictionary("render_pipeline_descriptor", value) ?? Object.create(null);
  }
  surfaceSource(value: WireValue | undefined): { id: number; label: string } {
    const input = wireObject(value);
    const extension = onlyExtension(input, "surface_descriptor", "surface_source_waffle");
    if (typeof input.label !== "string") throw new GpuProtocolError("Invalid surface label");
    return { id: wireNumber(extension.surface_id), label: input.label };
  }
  frameConfiguration(value: WireValue | undefined): Dictionary {
    const input = wireObject(value);
    const width = wireNumber(input.width);
    const height = wireNumber(input.height);
    if (!width || !height) throw new GpuCallError("Surface dimensions must be positive");
    if (input.present_mode !== 0 && input.present_mode !== 1)
      throw new GpuCallError("Only FIFO presentation is supported");
    const descriptor = this.dictionary("surface_configuration", input) ?? Object.create(null);
    descriptor.width = width;
    descriptor.height = height;
    descriptor.usage = Number(descriptor.usage) | 1;
    if (input.alpha_mode === 0) descriptor.alphaMode = "opaque";
    return descriptor;
  }
  #member(struct: string, name: string, type: string, value: WireValue): unknown {
    if (
      (struct === "render_pipeline_descriptor" || struct === "compute_pipeline_descriptor") &&
      name === "layout" &&
      value === null
    )
      return "auto";
    if (struct === "texture_view_descriptor" && name === "usage" && value === 0n) return undefined;
    if (
      (struct === "vertex_state" || struct === "fragment_state" || struct === "compute_state") &&
      name === "constants"
    )
      return this.#constants(value);
    if (struct === "render_pass_descriptor" && name === "color_attachments")
      return this.#attachments(value);
    const selector = bindingArms[name];
    if (struct === "bind_group_layout_entry" && selector && wireObject(value)[selector] === 0)
      return undefined;
    return this.value(type, value);
  }
  #bindingResource(input: WireObject): Dictionary {
    const arms = ["buffer", "sampler", "texture_view"].filter((name) => input[name] !== null);
    const arm = arms[0];
    if (arms.length !== 1 || !arm)
      throw new GpuCallError("Bind group entry needs exactly one resource");
    const type = arm === "texture_view" ? "texture_view" : arm;
    const native = this.handles.native(wireHandle(input[arm]), objectKind(type));
    if (arm !== "buffer") return { binding: input.binding, resource: native };
    const resource: Dictionary = Object.create(null);
    resource.buffer = native;
    resource.offset = this.value("uint64", input.offset ?? null);
    if (input.size !== 0xffffffffffffffffn)
      resource.size = this.value("uint64", input.size ?? null);
    return { binding: input.binding, resource };
  }
  #constants(value: WireValue): Dictionary {
    const result: Dictionary = Object.create(null);
    for (const item of wireArray(value)) {
      const entry = wireObject(item);
      if (typeof entry.key !== "string" || Object.hasOwn(result, entry.key))
        throw new GpuCallError("Invalid or duplicate constant key");
      result[entry.key] = entry.value;
    }
    return result;
  }
  #attachments(value: WireValue): (Dictionary | null | undefined)[] {
    return wireArray(value).map((item) => {
      const attachment = wireObject(item);
      return attachment.view === null
        ? null
        : this.dictionary("render_pass_color_attachment", attachment);
    });
  }
}
function onlyExtension(input: WireObject, chainName: string, struct: string): WireObject {
  const rule = tables.chains[chainName]?.find((entry) => entry.struct === struct);
  if (!rule) throw new GpuProtocolError("Missing generated extension layout");
  const chain = wireArray(input.next_in_chain);
  const extension = chain[0];
  if (chain.length !== 1 || !extension)
    throw new GpuProtocolError("Required chain extension missing");
  const entry = wireObject(extension);
  if (entry.sType !== rule.sType) throw new GpuProtocolError("Wrong chain extension");
  return wireObject(entry.value);
}

export function nativeObject(value: unknown): object {
  if (!value || typeof value !== "object") throw new GpuCallError("Native call returned no object");
  return value;
}
export function nativeCall(receiver: object, member: string, args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(receiver, member);
  if (typeof method !== "function")
    throw new GpuCallError(`Native member ${member} is not callable`);
  return Reflect.apply(method, receiver, args);
}
export function destroyNative(value: unknown): void {
  if (!value || typeof value !== "object") return;
  try {
    if (typeof Reflect.get(value, "destroy") === "function") nativeCall(value, "destroy", []);
  } catch {
    /* Retirement must finish even when a native resource is already lost. */
  }
}

const tables: WireTables = gpuStream;
const bindingArms: Readonly<Record<string, string>> = {
  buffer: "type",
  sampler: "type",
  texture: "sample_type",
  storage_texture: "access",
};
