import type { WireTables } from "../../tooling/gpu-stream-model.js";
import { gpuStream } from "./generated/tables.js";
import {
  decodeCall,
  recordHeader,
  WireReader,
  wireHandle,
  wireNumber,
  wireBytes,
  type DecodedCall,
} from "./codec.js";
import { CompletionOwner } from "./completions.js";
import { HandleTable, numericObjectKind, objectKind, type ObjectKind } from "./handles.js";
import {
  DescriptorLowering,
  destroyNative,
  nativeCall,
  nativeObject,
  type Dictionary,
} from "./lowering.js";
import {
  GPU_TERMINAL,
  GpuCallError,
  GpuProtocolError,
  GpuResourceError,
  type Handle,
} from "./protocol.js";
import type { LogicalRecord } from "./transport.js";

export interface SurfaceTarget {
  /** The trusted display implementation must reject ids outside this connection's grant. */
  create(id: number, label: string, result: Handle): object;
  configure(surface: object, descriptor: Dictionary): void;
  acquire(
    surface: object,
  ): { kind: "await" } | { kind: "ready"; texture: object | null; status: number };
  present(surface: object): { kind: "await" } | { kind: "ready"; status: number };
  unconfigure(surface: object): void;
  release(surface: object): void;
}
export interface ReplayTarget {
  readonly root: object;
  readonly surfaces?: SurfaceTarget;
}
interface Blob {
  readonly bytes: Uint8Array;
  readonly encoder: Handle;
  offset: number;
  pass: Handle | undefined;
  finished: boolean;
}
interface Cursor {
  readonly record: LogicalRecord;
  offset: number;
  blob: Blob | undefined;
}
interface WaitingSurface {
  readonly call: DecodedCall;
  readonly receiver: object;
  readonly result: Handle | undefined;
}
export type ReplayStep =
  | { readonly kind: "progress"; readonly bytes: number; readonly presented: boolean }
  | { readonly kind: "idle" | "await" | "terminal" };

/** Service-only resumable decoder. Target methods are real object calls, not wire round trips. */
export class GpuReplay {
  readonly handles: HandleTable;
  readonly #lower: DescriptorLowering;
  #cursor: Cursor | undefined;
  #waiting: WaitingSurface | undefined;
  readonly #devices = new Map<object, () => void>();
  readonly #finished = new Map<number, number>();
  #live = true;
  constructor(
    readonly target: ReplayTarget,
    readonly completions: CompletionOwner,
    handleLimit?: number,
  ) {
    this.handles = new HandleTable(
      target.root,
      (kind, value) => this.#disposeObject(kind, value),
      handleLimit,
    );
    this.#lower = new DescriptorLowering(this.handles);
  }
  get busy(): boolean {
    return this.#cursor !== undefined;
  }
  accept(record: LogicalRecord): void {
    if (!this.#live || this.#cursor) {
      record.release();
      throw new GpuProtocolError("Replay cannot accept another record");
    }
    this.#cursor = { record, offset: 0, blob: undefined };
  }
  step(): ReplayStep {
    if (!this.#live || this.completions.state.kind === "terminal") return { kind: "terminal" };
    try {
      return this.#step();
    } catch (error) {
      this.completions.terminate(
        error instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol,
      );
      this.dispose();
      return { kind: "terminal" };
    }
  }
  dispose(): void {
    if (!this.#live) return;
    this.#live = false;
    this.#cursor?.record.release();
    this.#cursor = undefined;
    this.#waiting = undefined;
    this.handles.retire();
    for (const stop of this.#devices.values()) stop();
    this.#devices.clear();
    this.#finished.clear();
  }
  #step(): ReplayStep {
    const cursor = this.#cursor;
    if (!cursor) return { kind: "idle" };
    if (this.#waiting) return this.#resumeSurface();
    if (cursor.blob) return this.#nested(cursor, cursor.blob);
    const bytes = cursor.record.bytes;
    const header = recordHeader(bytes, cursor.offset);
    const record = bytes.subarray(cursor.offset, cursor.offset + header.length);
    if (header.flags) throw new GpuProtocolError("Source record flags must be zero");
    if (header.opcode === 0x1001) return this.#beginBlob(cursor, record);
    if (header.opcode === 0x1000) return this.#release(cursor, record);
    const call = decodeCall(record);
    if (call.layout.context !== "top") throw new GpuProtocolError("Nested command outside encode");
    const waiting = this.#execute(call);
    if (!this.#live) return { kind: "terminal" };
    if (waiting) return { kind: "await" };
    this.#advance(cursor, header.length);
    return {
      kind: "progress",
      bytes: header.length,
      presented: call.layout.lowering.kind === "surface-present",
    };
  }
  #advance(cursor: Cursor, bytes: number): void {
    cursor.offset += bytes;
    if (cursor.offset !== cursor.record.bytes.byteLength) return;
    cursor.record.release();
    this.#cursor = undefined;
  }
  #beginBlob(cursor: Cursor, bytes: Uint8Array): ReplayStep {
    const layout = gpuStream.records.find((entry) => entry.name === "encode");
    if (!layout) throw new Error("Missing encode layout");
    const reader = new WireReader(bytes, 8);
    const fields = reader.fields(layout.fields);
    reader.finish();
    const encoder = wireHandle(fields.encoder);
    this.handles.get(encoder, "command_encoder");
    if (this.#finished.get(encoder.id) === encoder.generation)
      throw new GpuProtocolError("Encoder already finished");
    if (!(fields.commands instanceof Uint8Array))
      throw new GpuProtocolError("Missing encode bytes");
    cursor.blob = { bytes: fields.commands, encoder, offset: 0, pass: undefined, finished: false };
    // Only the envelope is charged here. Nested bytes are charged on each later step.
    return {
      kind: "progress",
      bytes: bytes.byteLength - fields.commands.byteLength,
      presented: false,
    };
  }
  #nested(cursor: Cursor, blob: Blob): ReplayStep {
    if (blob.offset === blob.bytes.byteLength) {
      if (blob.pass) throw new GpuProtocolError("Unclosed render pass");
      cursor.blob = undefined;
      const length = recordHeader(cursor.record.bytes, cursor.offset).length;
      this.#advance(cursor, length);
      return { kind: "progress", bytes: 0, presented: false };
    }
    if (blob.finished) throw new GpuProtocolError("Commands follow encoder finish");
    const header = recordHeader(blob.bytes, blob.offset);
    const call = decodeCall(blob.bytes.subarray(blob.offset, blob.offset + header.length));
    const context = blob.pass ? "pass" : "encoder";
    if (call.layout.context !== context) throw new GpuProtocolError("Invalid encoder/pass nesting");
    const receiver = blob.pass ?? blob.encoder;
    this.#execute(call, receiver);
    if (!this.#live) return { kind: "terminal" };
    if (call.layout.name === "command_encoder.begin_render_pass")
      blob.pass = wireHandle(call.fields.result);
    if (call.layout.name === "render_pass_encoder.end") blob.pass = undefined;
    if (call.layout.name === "command_encoder.finish") {
      blob.finished = true;
      this.#finished.set(blob.encoder.id, blob.encoder.generation);
    }
    blob.offset += header.length;
    return { kind: "progress", bytes: header.length, presented: false };
  }
  #release(cursor: Cursor, bytes: Uint8Array): ReplayStep {
    const layout = gpuStream.records.find((entry) => entry.name === "release");
    if (!layout) throw new Error("Missing release layout");
    const reader = new WireReader(bytes, 8);
    const fields = reader.fields(layout.fields);
    reader.finish();
    const handle = wireHandle(fields.object);
    this.handles.release(handle, numericObjectKind(wireNumber(fields.object_kind)));
    this.#finished.delete(handle.id);
    this.#advance(cursor, bytes.byteLength);
    return { kind: "progress", bytes: bytes.byteLength, presented: false };
  }
  #execute(call: DecodedCall, nested?: Handle): boolean {
    const { layout, fields } = call;
    const result = layout.result.kind === "handle" ? wireHandle(fields.result) : undefined;
    if (result && layout.result.kind === "handle")
      this.handles.reserve(result, objectKind(layout.result.object));
    // Native async admission is done by start(), before invoking a browser promise producer.
    if (
      layout.token &&
      layout.lowering.kind !== "request-adapter" &&
      layout.lowering.kind !== "request-device" &&
      layout.name !== "device.pop_error_scope"
    )
      this.completions.admit(wireNumber(fields.token));
    try {
      const receiver = this.handles.native(
        nested ?? wireHandle(fields.receiver),
        objectKind(layout.receiver),
      );
      return this.#lowerCall(call, receiver, result);
    } catch (error) {
      if (error instanceof GpuProtocolError || error instanceof GpuResourceError) throw error;
      this.#exception(call, result, error);
      return false;
    }
  }
  #exception(call: DecodedCall, result: Handle | undefined, error: unknown): void {
    this.#waiting = undefined;
    const message = errorMessage(error);
    if (result && call.layout.result.kind === "handle")
      this.handles.bind(result, objectKind(call.layout.result.object), {
        kind: "exception",
        message,
      });
    // Even failed adaptation consumes a callback token exactly once.
    if (
      call.layout.lowering.kind === "request-adapter" ||
      call.layout.lowering.kind === "request-device" ||
      call.layout.name === "device.pop_error_scope"
    )
      this.completions.admit(wireNumber(call.fields.token));
    this.completions.publish(
      "call-exception",
      typeof call.fields.token === "number" ? call.fields.token : 0,
      -28,
      { opcode: call.layout.opcode, message },
    );
  }
  #lowerCall(call: DecodedCall, receiver: object, result: Handle | undefined): boolean {
    const { fields, layout } = call;
    switch (layout.lowering.kind) {
      case "request-adapter":
        this.#request(
          call,
          receiver,
          result,
          "adapter",
          this.#lower.adapterOptions(fields.options),
        );
        return false;
      case "request-device":
        this.#request(
          call,
          receiver,
          result,
          "device",
          this.#lower.deviceDescriptor(fields.descriptor),
        );
        return false;
      case "surface-create": {
        const source = this.#lower.surfaceSource(fields.descriptor);
        if (!result) throw new GpuProtocolError("Missing surface result handle");
        this.#bind(call, result, this.#surfaces().create(source.id, source.label, result));
        return false;
      }
      case "surface-configure":
        this.#surfaces().configure(receiver, this.#lower.frameConfiguration(fields.config));
        return false;
      case "surface-acquire":
      case "surface-present":
        this.#waiting = { call, receiver, result };
        return !this.#surfaceResult(this.#waiting);
      case "property":
        this.#bind(call, result, Reflect.get(receiver, layout.lowering.member));
        return false;
      case "shader-module":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "createShaderModule", [this.#lower.wgsl(fields.descriptor)]),
        );
        return false;
      case "render-pipeline":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "createRenderPipeline", [this.#lower.pipeline(fields.descriptor)]),
        );
        return false;
      case "error-scope":
        this.#errorScope(call, receiver);
        return false;
      case "descriptor-method":
        this.#bind(
          call,
          result,
          nativeCall(receiver, layout.lowering.member, [
            this.#lower.dictionary(layout.lowering.descriptor, fields.descriptor),
          ]),
        );
        return false;
      case "write-buffer":
        nativeCall(receiver, layout.lowering.member, [
          this.#lower.value("object.buffer", fields.buffer ?? null),
          this.#lower.value("uint64", fields.buffer_offset ?? null),
          wireBytes(fields.data),
        ]);
        return false;
      case "write-texture":
        nativeCall(receiver, layout.lowering.member, [
          this.#lower.dictionary("texel_copy_texture_info", fields.destination),
          wireBytes(fields.data),
          this.#lower.dictionary("texel_copy_buffer_layout", fields.data_layout),
          this.#lower.dictionary("extent_3D", fields.write_size),
        ]);
        return false;
      case "method":
        this.#method(call, receiver, result);
        return false;
      default: {
        const exhaustive: never = layout.lowering;
        throw new Error(String(exhaustive));
      }
    }
  }
  #bind(call: DecodedCall, result: Handle | undefined, value: unknown): void {
    if (!result || call.layout.result.kind !== "handle") return;
    const kind = objectKind(call.layout.result.object);
    this.handles.bind(result, kind, { kind: "native", value: nativeObject(value) });
  }
  #method(call: DecodedCall, receiver: object, result: Handle | undefined): void {
    const fields = call.fields;
    switch (call.layout.name) {
      case "texture.create_view":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "createView", [
            this.#lower.dictionary("texture_view_descriptor", fields.descriptor),
          ]),
        );
        return;
      case "device.create_command_encoder":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "createCommandEncoder", [
            this.#lower.dictionary("command_encoder_descriptor", fields.descriptor),
          ]),
        );
        return;
      case "command_encoder.begin_render_pass":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "beginRenderPass", [
            this.#lower.dictionary("render_pass_descriptor", fields.descriptor),
          ]),
        );
        return;
      case "command_encoder.finish":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "finish", [
            this.#lower.dictionary("command_buffer_descriptor", fields.descriptor),
          ]),
        );
        return;
      case "render_pass_encoder.set_pipeline":
        nativeCall(receiver, "setPipeline", [
          this.#lower.value("object.render_pipeline", fields.pipeline ?? null),
        ]);
        return;
      case "render_pass_encoder.draw":
        nativeCall(receiver, "draw", [
          fields.vertex_count,
          fields.instance_count,
          fields.first_vertex,
          fields.first_instance,
        ]);
        return;
      case "render_pass_encoder.set_bind_group":
        nativeCall(receiver, "setBindGroup", [
          fields.group_index,
          fields.group === null
            ? null
            : this.#lower.value("object.bind_group", fields.group ?? null),
          this.#lower.value("array<uint32>", fields.dynamic_offsets ?? null),
        ]);
        return;
      case "render_pass_encoder.set_vertex_buffer":
      case "render_pass_encoder.set_index_buffer":
        this.#bufferBinding(call, receiver);
        return;
      case "render_pass_encoder.draw_indexed":
        nativeCall(receiver, "drawIndexed", [
          fields.index_count,
          fields.instance_count,
          fields.first_index,
          fields.base_vertex,
          fields.first_instance,
        ]);
        return;
      case "render_pass_encoder.end":
        nativeCall(receiver, "end", []);
        return;
      case "queue.submit":
        nativeCall(receiver, "submit", [
          this.#lower.value("array<object.command_buffer>", fields.commands ?? null),
        ]);
        return;
      case "device.destroy":
        nativeCall(receiver, "destroy", []);
        return;
      case "surface.unconfigure":
        this.#surfaces().unconfigure(receiver);
        return;
      default:
        throw new GpuProtocolError("Unclassified method lowering");
    }
  }
  #bufferBinding(call: DecodedCall, receiver: object): void {
    const fields = call.fields;
    const buffer =
      fields.buffer === null ? null : this.#lower.value("object.buffer", fields.buffer ?? null);
    const offset = this.#lower.value("uint64", fields.offset ?? null);
    const size =
      fields.size === 0xffffffffffffffffn
        ? undefined
        : this.#lower.value("uint64", fields.size ?? null);
    if (call.layout.name === "render_pass_encoder.set_vertex_buffer") {
      nativeCall(receiver, "setVertexBuffer", [fields.slot, buffer, offset, size]);
      return;
    }
    nativeCall(receiver, "setIndexBuffer", [
      buffer,
      this.#lower.value("enum.index_format", fields.format ?? null),
      offset,
      size,
    ]);
  }
  #request(
    call: DecodedCall,
    receiver: object,
    result: Handle | undefined,
    kind: "adapter" | "device",
    descriptor: Dictionary | undefined,
  ): void {
    if (!result) throw new GpuProtocolError("Missing callback result handle");
    const token = wireNumber(call.fields.token);
    this.completions.start(
      token,
      () =>
        Promise.resolve(
          nativeCall(receiver, kind === "adapter" ? "requestAdapter" : "requestDevice", [
            descriptor,
          ]),
        ),
      (owner, value) => this.#requestResult(owner, result, kind, token, value),
      (owner, error) => this.#requestFailure(owner, result, kind, token, error),
      kind === "device" ? destroyNative : ignoreResult,
    );
  }
  #requestResult(
    owner: CompletionOwner,
    result: Handle,
    kind: "adapter" | "device",
    token: number,
    value: unknown,
  ): void {
    if (value === null) {
      this.#requestFailure(
        owner,
        result,
        kind,
        token,
        new GpuCallError("No adapter available"),
        true,
      );
      return;
    }
    const object = nativeObject(value);
    if (!this.handles.bind(result, kind, { kind: "native", value: object })) {
      if (kind === "device") destroyNative(object);
      this.#requestFailure(
        owner,
        result,
        kind,
        token,
        new GpuCallError("Result handle was released"),
      );
      return;
    }
    if (kind === "device") this.#devices.set(object, observeDevice(owner, result, object));
    owner.publish(kind, token, 0, {
      status: cValue(`enum.request_${kind}_status`, "success"),
      [kind]: { ...result },
      message: "",
    });
  }
  #requestFailure(
    owner: CompletionOwner,
    result: Handle,
    kind: "adapter" | "device",
    token: number,
    error: unknown,
    unavailable = false,
  ): void {
    const message = errorMessage(error);
    this.handles.bind(result, kind, { kind: "exception", message });
    owner.publish(kind, token, -28, {
      status: cValue(
        `enum.request_${kind}_status`,
        unavailable && kind === "adapter" ? "unavailable" : "error",
      ),
      [kind]: { ...result },
      message,
    });
  }
  #errorScope(call: DecodedCall, receiver: object): void {
    if (call.layout.name === "device.push_error_scope") {
      nativeCall(receiver, "pushErrorScope", [
        this.#lower.value("enum.error_filter", call.fields.filter ?? null),
      ]);
      return;
    }
    const token = wireNumber(call.fields.token);
    this.completions.start(
      token,
      () => Promise.resolve(nativeCall(receiver, "popErrorScope", [])),
      (owner, error) => publishScope(owner, token, error),
      (owner, error) =>
        owner.publish("error-scope", token, -28, {
          status: cValue("enum.pop_error_scope_status", "error"),
          type: cValue("enum.error_type", "unknown"),
          message: errorMessage(error),
        }),
      ignoreResult,
    );
  }
  #surfaces(): SurfaceTarget {
    if (!this.target.surfaces) throw new GpuCallError("No granted surface target");
    return this.target.surfaces;
  }
  #surfaceResult(waiting: WaitingSurface): boolean {
    const { call, receiver, result } = waiting;
    const token = wireNumber(call.fields.token);
    if (call.layout.lowering.kind === "surface-acquire") {
      const acquired = this.#surfaces().acquire(receiver);
      if (acquired.kind === "await") return false;
      this.#bindSurfaceTexture(call, result, acquired.texture);
      this.completions.publish("surface-texture", token, 0, {
        texture: { ...result },
        status: acquired.status,
      });
    } else {
      const present = this.#surfaces().present(receiver);
      if (present.kind === "await") return false;
      this.completions.publish("present", token, 0, { status: present.status });
    }
    this.#waiting = undefined;
    return true;
  }
  #bindSurfaceTexture(call: DecodedCall, result: Handle | undefined, texture: object | null): void {
    if (texture) {
      this.#bind(call, result, texture);
      return;
    }
    if (result)
      this.handles.bind(result, "texture", {
        kind: "exception",
        message: "Surface acquire failed",
      });
  }
  #resumeSurface(): ReplayStep {
    const waiting = this.#waiting;
    const cursor = this.#cursor;
    if (!waiting || !cursor) throw new GpuProtocolError("Missing suspended call");
    try {
      if (!this.#surfaceResult(waiting)) return { kind: "await" };
    } catch (error) {
      if (error instanceof GpuProtocolError || error instanceof GpuResourceError) throw error;
      this.#waiting = undefined;
      this.#exception(waiting.call, waiting.result, error);
    }
    const length = recordHeader(cursor.record.bytes, cursor.offset).length;
    this.#advance(cursor, length);
    return {
      kind: "progress",
      bytes: length,
      presented: waiting.call.layout.lowering.kind === "surface-present",
    };
  }
  #disposeObject(kind: ObjectKind, value: object): void {
    if (kind === "surface") {
      try {
        this.target.surfaces?.release(value);
      } catch {
        /* Continue retiring other native objects. */
      }
      return;
    }
    if (kind !== "device" && kind !== "texture" && kind !== "buffer") return;
    this.#devices.get(value)?.();
    this.#devices.delete(value);
    destroyNative(value);
  }
}

function cValue(type: string, name: string): number {
  const value = tables.enums[type]?.[name];
  if (value === undefined) throw new Error(`Missing generated C value ${type}.${name}`);
  return value;
}
function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "GPU native call failed";
}
function errorType(error: unknown): number {
  if (!error) return cValue("enum.error_type", "no_error");
  const name = typeof error === "object" ? error.constructor.name : "";
  if (name === "GPUValidationError") return cValue("enum.error_type", "validation");
  if (name === "GPUOutOfMemoryError") return cValue("enum.error_type", "out_of_memory");
  if (name === "GPUInternalError") return cValue("enum.error_type", "internal");
  return cValue("enum.error_type", "unknown");
}
function publishScope(owner: CompletionOwner, token: number, error: unknown): void {
  owner.publish("error-scope", token, 0, {
    status: cValue("enum.pop_error_scope_status", "success"),
    type: errorType(error),
    message: error ? errorMessage(error) : "",
  });
}
function observeDevice(owner: CompletionOwner, handle: Handle, device: object): () => void {
  const sink: { owner: CompletionOwner | undefined } = { owner };
  const lost: unknown = Reflect.get(device, "lost");
  if (lost instanceof Promise) watchLoss(lost, sink, handle);
  const listener = deviceListener(sink, handle);
  const listens = typeof Reflect.get(device, "addEventListener") === "function";
  if (listens) nativeCall(device, "addEventListener", ["uncapturederror", listener]);
  return () => {
    sink.owner = undefined;
    try {
      if (listens) nativeCall(device, "removeEventListener", ["uncapturederror", listener]);
    } catch {
      /* A failing native detach cannot keep the owner live. */
    }
  };
}
function publishLoss(owner: CompletionOwner | undefined, handle: Handle, info: unknown): void {
  if (!owner) return;
  const destroyed =
    typeof info === "object" && info !== null && "reason" in info && info.reason === "destroyed";
  owner.publish("device-lost", 0, 0, {
    device: { ...handle },
    reason: cValue("enum.device_lost_reason", destroyed ? "destroyed" : "unknown"),
    message: errorMessage(info),
  });
}

const tables: WireTables = gpuStream;

function watchLoss(
  lost: Promise<unknown>,
  sink: { owner: CompletionOwner | undefined },
  handle: Handle,
): void {
  void lost.then(
    (info: unknown) => publishLoss(sink.owner, handle, info),
    () => {},
  );
}
function deviceListener(
  sink: { owner: CompletionOwner | undefined },
  handle: Handle,
): (event: unknown) => void {
  return (event: unknown) => {
    const error =
      typeof event === "object" && event !== null && "error" in event ? event.error : event;
    sink.owner?.publish("uncaptured-error", 0, 0, {
      device: { ...handle },
      type: errorType(error),
      message: errorMessage(error),
    });
  };
}

function ignoreResult(): void {}
