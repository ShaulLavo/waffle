import type { CallLayout, WireTables } from "../../tooling/gpu-stream-model.js";
import { gpuDictionaryMembers, gpuStream } from "./generated/tables.js";
import { outputStruct, wireNumber, type WireObject, type WireValue } from "./codec.js";
import { nativeCall, nativeObject, type Dictionary } from "./lowering.js";
import type { CompletionOwner } from "./completions.js";
import { GpuCallError, GpuResourceError, ServiceCredit } from "./protocol.js";

const tables: WireTables = gpuStream;
const dictionaries: Readonly<Record<string, Readonly<Record<string, string | null>>>> =
  gpuDictionaryMembers;
const uintMax = 0xffffffff;

export class NativeMetadata {
  readonly #adapters = new WeakMap<object, object>();
  device(device: object, adapter: object): void {
    this.#adapters.set(device, adapter);
  }
  query(call: CallLayout, receiver: object, fields: WireObject, owner: CompletionOwner): void {
    if (!call.output || call.lowering.kind !== "query")
      throw new GpuCallError("Missing checked query output");
    const token = wireNumber(fields.token);
    try {
      const value: WireObject = {};
      if (call.cReturn === "enum.status") value.returned = cValue("enum.status", "success");
      const adapter = call.lowering.adapter;
      if (adapter === "has-feature" || adapter === "has-wgsl-feature") {
        const type =
          adapter === "has-feature" ? "enum.feature_name" : "enum.WGSL_language_feature_name";
        value.returned = features(
          receiver,
          type,
          adapter === "has-feature" ? "features" : "wgslLanguageFeatures",
        ).includes(wireNumber(fields.feature));
      } else if (adapter === "info") {
        const native =
          call.receiver === "device"
            ? (Reflect.get(receiver, "adapterInfo") ??
              Reflect.get(this.#adapters.get(receiver) ?? receiver, "info"))
            : Reflect.get(receiver, "info");
        value.info = adapterInfo(nativeObject(native));
      } else if (adapter === "limits")
        value.limits = limits(nativeObject(Reflect.get(receiver, "limits")));
      else
        value.features = {
          features: features(
            receiver,
            adapter === "features" ? "enum.feature_name" : "enum.WGSL_language_feature_name",
            adapter === "features" ? "features" : "wgslLanguageFeatures",
          ),
        };
      publishOutput(owner, token, call.opcode, call.output.payload, value);
    } catch (error) {
      if (error instanceof GpuResourceError) throw error;
      owner.publish("query-result", token, -28, { opcode: call.opcode, payload: null, length: 0 });
    }
  }
}
function features(receiver: object, type: string, property: string): number[] {
  const collection = nativeObject(Reflect.get(receiver, property));
  const names = tables.browserEnums[type];
  const values = tables.enums[type];
  if (!names || !values) throw new GpuCallError("Missing generated feature conversion");
  const output: number[] = [];
  for (const [name, native] of Object.entries(names)) {
    if (typeof native === "string" && nativeCall(collection, "has", [native]) === true) {
      const value = values[name];
      if (value !== undefined) output.push(value);
    }
  }
  return output;
}
function limits(native: object): WireObject {
  const layout = tables.structs.limits;
  const members = dictionaries.limits;
  if (!layout || !members) throw new GpuCallError("Missing generated limits layout");
  const output: WireObject = { next_in_chain: [] };
  for (const field of layout.fields) {
    if (field.name === "next_in_chain") continue;
    const member = members[field.name];
    if (typeof member !== "string") throw new GpuCallError("Unclassified native limit");
    const value: unknown = Reflect.get(native, member);
    if (value === undefined) {
      output[field.name] = field.type === "uint64" ? 0xffffffffffffffffn : uintMax;
      continue;
    }
    const number = nativeInteger(
      value,
      field.type === "uint64" ? Number.MAX_SAFE_INTEGER : uintMax,
    );
    output[field.name] = field.type === "uint64" ? BigInt(number) : number;
  }
  return output;
}
function adapterInfo(native: object): WireObject {
  return {
    next_in_chain: [],
    vendor: nativeString(Reflect.get(native, "vendor")),
    architecture: nativeString(Reflect.get(native, "architecture")),
    device: nativeString(Reflect.get(native, "device")),
    description: nativeString(Reflect.get(native, "description")),
    backend_type: cValue("enum.backend_type", "WebGPU"),
    adapter_type: cValue("enum.adapter_type", "unknown"),
    vendor_ID: 0,
    device_ID: 0,
    subgroup_min_size: optionalInteger(Reflect.get(native, "subgroupMinSize")),
    subgroup_max_size: optionalInteger(Reflect.get(native, "subgroupMaxSize")),
  };
}
function optionalInteger(value: unknown): number {
  return value === undefined ? 0 : nativeInteger(value, uintMax);
}
function nativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new GpuCallError("Invalid native integer output");
  return value;
}
function nativeString(value: unknown): string {
  if (typeof value !== "string") throw new GpuCallError("Invalid native string output");
  return value;
}
export function cValue(type: string, name: string): number {
  const number = tables.enums[type]?.[name];
  if (number === undefined) throw new GpuCallError("Missing generated C enum value");
  return number;
}
function publishOutput(
  owner: CompletionOwner,
  token: number,
  opcode: number,
  struct: string,
  value: WireObject,
): void {
  const length = outputStruct(struct, value);
  const payload = owner.fillPayload(length, (destination) => {
    outputStruct(struct, value, destination);
  });
  if (payload) owner.publish("query-result", token, 0, { opcode, payload: { ...payload }, length });
}

interface ShaderSource {
  state: { kind: "owned"; text: string; release: () => void } | { kind: "retired" };
  released: boolean;
  pending: number;
}
/** Released native queries may retain a small detachable source cell, never replay or rings. */
export class ShaderSources {
  readonly #sources = new Map<object, ShaderSource>();
  readonly #retained = new Set<ShaderSource>();
  constructor(readonly credit: ServiceCredit) {}
  create(device: object, descriptor: Dictionary): object {
    const text = nativeString(descriptor.code);
    const release = this.credit.reserve(64 + text.length * 2);
    try {
      const native = nativeObject(nativeCall(device, "createShaderModule", [descriptor]));
      const retained = this.#retained;
      const source: ShaderSource = {
        state: {
          kind: "owned",
          text,
          release: () => {
            release();
            retained.delete(source);
          },
        },
        released: false,
        pending: 0,
      };
      this.#sources.set(native, source);
      this.#retained.add(source);
      return native;
    } catch (error) {
      release();
      throw error;
    }
  }
  compilation(native: object, token: number, owner: CompletionOwner): void {
    const source = this.#sources.get(native);
    if (!source) throw new GpuCallError("Missing shader source owner");
    owner.start(
      token,
      () => {
        source.pending++;
        return Promise.resolve(nativeCall(native, "getCompilationInfo", []));
      },
      (sink, result) => {
        try {
          publishCompilation(sink, token, result, source);
        } finally {
          finishSource(source);
        }
      },
      (sink, error) => {
        try {
          sink.publish("compilation-result", token, -28, {
            status: cValue("enum.compilation_info_request_status", "callback_cancelled"),
            message: errorMessage(error),
            payload: null,
            length: 0,
          });
        } finally {
          finishSource(source);
        }
      },
      () => {
        finishSource(source);
      },
    );
  }
  release(native: object): void {
    const source = this.#sources.get(native);
    if (!source) return;
    this.#sources.delete(native);
    source.released = true;
    if (!source.pending) retireSource(source);
  }
  dispose(): void {
    for (const source of this.#retained) retireSource(source);
    this.#retained.clear();
    this.#sources.clear();
  }
  snapshot(): number {
    return this.#retained.size;
  }
}
function finishSource(source: ShaderSource): void {
  source.pending--;
  if (source.released && !source.pending) retireSource(source);
}
function retireSource(source: ShaderSource): void {
  const state = source.state;
  source.state = { kind: "retired" };
  if (state.kind === "owned") state.release();
}
function publishCompilation(
  owner: CompletionOwner,
  token: number,
  result: unknown,
  source: ShaderSource,
): void {
  if (source.state.kind !== "owned") throw new GpuCallError("Retired shader source");
  const info = nativeObject(result);
  const messages: unknown = Reflect.get(info, "messages");
  if (!Array.isArray(messages)) throw new GpuCallError("Invalid native compilation messages");
  if (messages.length > 16384)
    throw new GpuResourceError("Compilation message count exceeds payload capacity");
  const input = messages.map(readMessage);
  const value: WireObject = {
    next_in_chain: [],
    messages: compilationMessages(source.state.text, input),
  };
  const length = outputStruct("compilation_info", value);
  const payload = owner.fillPayload(length, (destination) => {
    outputStruct("compilation_info", value, destination);
  });
  if (payload)
    owner.publish("compilation-result", token, 0, {
      status: cValue("enum.compilation_info_request_status", "success"),
      message: "",
      payload: { ...payload },
      length,
    });
}
interface NativeMessage {
  message: string;
  type: string;
  lineNum: number;
  linePos: number;
  offset: number;
  length: number;
}
function readMessage(value: unknown): NativeMessage {
  const native = nativeObject(value);
  return {
    message: nativeString(Reflect.get(native, "message")),
    type: nativeString(Reflect.get(native, "type")),
    lineNum: nativeInteger(Reflect.get(native, "lineNum")),
    linePos: nativeInteger(Reflect.get(native, "linePos")),
    offset: nativeInteger(Reflect.get(native, "offset")),
    length: nativeInteger(Reflect.get(native, "length")),
  };
}
/** Translate all requested UTF-16 boundaries in one source pass. */
export function compilationMessages(
  source: string,
  messages: readonly NativeMessage[],
): WireObject[] {
  const boundaries = new Set<number>();
  for (const message of messages) {
    if (message.offset > source.length || message.length > source.length - message.offset)
      throw new GpuCallError("Invalid native compilation range");
    boundaries.add(message.offset);
    boundaries.add(message.offset + message.length);
  }
  const positions = new Map<
    number,
    { bytes: number; line: number; lineStart: number; lineUnits: number }
  >();
  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  let next = 0,
    bytes = 0,
    line = 1,
    lineStart = 0,
    lineUnits = 0;
  for (let index = 0; index <= source.length;) {
    if (sorted[next] === index) {
      positions.set(index, { bytes, line, lineStart, lineUnits });
      next++;
    }
    if (index === source.length) break;
    const code = source.codePointAt(index) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    if (sorted[next] !== undefined && (sorted[next] ?? 0) < index + width)
      throw new GpuCallError("Native location splits a surrogate pair");
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += width;
    if (code === 10) {
      line++;
      lineStart = bytes;
      lineUnits = index;
    }
  }
  return messages.map((message) => {
    const start = positions.get(message.offset),
      end = positions.get(message.offset + message.length);
    if (!start || !end) throw new GpuCallError("Missing native source location");
    const noLocation =
      message.lineNum === 0 &&
      message.linePos === 0 &&
      message.offset === 0 &&
      message.length === 0;
    if (
      !noLocation &&
      (message.lineNum !== start.line || message.linePos !== message.offset - start.lineUnits + 1)
    )
      throw new GpuCallError("Inconsistent native source location");
    return {
      next_in_chain: [],
      message: message.message,
      type: cValue("enum.compilation_message_type", message.type),
      line_num: BigInt(noLocation ? 0 : start.line),
      line_pos: BigInt(noLocation ? 0 : start.bytes - start.lineStart + 1),
      offset: BigInt(start.bytes),
      length: BigInt(end.bytes - start.bytes),
    };
  });
}
export function errorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "GPU native call failed";
}
