import { accessed } from "./access.js";
import { gpuStream } from "./generated/tables.js";
import {
  decodeCall,
  recordHeader,
  WireReader,
  wireHandle,
  wireNumber,
  wireBytes,
  wireObject,
  type DecodedCall,
} from "./codec.js";
import { BufferMaps } from "./buffers.js";
import { NativeMetadata, ShaderSources, cValue, errorMessage } from "./metadata.js";
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
  ServiceCredit,
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
  /** Frame-owning targets forget storage after native destruction, independently of handles. */
  textureDestroyed?(texture: object): void;
}
export interface ReplayTarget {
  readonly root: object;
  readonly surfaces?: SurfaceTarget;
}
interface BlobCursor {
  readonly bytes: Uint8Array;
  readonly encoder: Handle;
  offset: number;
  finished: boolean;
}
type Blob = BlobCursor &
  (
    | {
        readonly kind: "command_encoder";
        pass:
          | {
              readonly handle: Handle;
              readonly kind: "render_pass_encoder" | "compute_pass_encoder";
            }
          | undefined;
      }
    | { readonly kind: "render_bundle_encoder" }
  );
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
  readonly #devices = new Map<object, DeviceObservation>();
  readonly #buffers = new BufferMaps();
  readonly #metadata = new NativeMetadata();
  readonly #sources: ShaderSources;
  readonly #frameTextures = new WeakSet<object>();
  readonly #finished = new Map<number, number>();
  #live = true;
  constructor(
    readonly target: ReplayTarget,
    readonly completions: CompletionOwner,
    handleLimit?: number,
    credit = new ServiceCredit(),
  ) {
    this.#sources = new ShaderSources(credit);
    this.handles = new HandleTable(
      target.root,
      (kind, value) => this.#disposeObject(kind, value),
      handleLimit,
    );
    this.#lower = new DescriptorLowering(this.handles);
  }
  get devicesLive(): number {
    let count = 0;
    for (const device of this.#devices.values()) if (device.sink.live) count++;
    return count;
  }
  snapshot() {
    return {
      ...this.#buffers.snapshot(),
      sources: this.#sources.snapshot(),
      devicesLive: this.devicesLive,
    };
  }
  get busy(): boolean {
    return this.#cursor !== undefined;
  }
  accept(record: LogicalRecord): void {
    if (
      this.completions.run(() => {
        this.#accept(record);
        return undefined;
      }) === "closed"
    )
      record.release();
  }
  #accept(record: LogicalRecord): void {
    if (!this.#live || this.#cursor) {
      record.release();
      throw new GpuProtocolError("Replay cannot accept another record");
    }
    this.#cursor = { record, offset: 0, blob: undefined };
  }
  step(): ReplayStep {
    return accessed<ReplayStep>(
      { run: (work) => this.completions.run(work) },
      { kind: "terminal" },
      () => this.#admittedStep(),
    );
  }
  #admittedStep(): ReplayStep {
    if (!this.#live || this.completions.state.kind === "terminal") return { kind: "terminal" };
    try {
      return this.#step();
    } catch (error) {
      this.completions.terminate(
        error instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol,
      );
      return { kind: "terminal" };
    }
  }
  dispose(): void {
    if (!this.#live) return;
    this.#live = false;
    this.#cursor?.record.release();
    this.#cursor = undefined;
    this.#waiting = undefined;
    const failures: unknown[] = [];
    for (const device of this.#devices.values()) {
      try {
        device.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.handles.retire();
    } catch (error) {
      failures.push(error);
    }
    this.#buffers.dispose();
    this.#sources.dispose();
    this.#finished.clear();
    if (failures.length) throw new AggregateError(failures, "GPU replay cleanup failed");
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
    if (header.opcode === 0x1001 || header.opcode === 0x1002)
      return this.#beginBlob(cursor, record, header.opcode);
    if (header.opcode === 0x1000) return this.#release(cursor, record);
    if (header.opcode === 0x1003) {
      const layout = gpuStream.records.find((entry) => entry.opcode === 0x1003);
      if (!layout) throw new GpuProtocolError("Missing write-back layout");
      const reader = new WireReader(record, 8);
      const fields = reader.fields(layout.fields);
      reader.finish();
      this.#buffers.writes(this.handles.native(wireHandle(fields.buffer), "buffer"), fields);
      this.#advance(cursor, header.length);
      return { kind: "progress", bytes: header.length, presented: false };
    }
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
  #beginBlob(cursor: Cursor, bytes: Uint8Array, opcode: number): ReplayStep {
    const layout = gpuStream.records.find((entry) => entry.opcode === opcode && entry.enabled);
    if (!layout) throw new Error("Missing encode layout");
    const reader = new WireReader(bytes, 8);
    const fields = reader.fields(layout.fields);
    reader.finish();
    const encoder = wireHandle(fields.encoder);
    const kind = opcode === 0x1001 ? "command_encoder" : "render_bundle_encoder";
    this.handles.get(encoder, kind);
    if (this.#finished.get(encoder.id) === encoder.generation)
      throw new GpuProtocolError("Encoder already finished");
    if (!(fields.commands instanceof Uint8Array))
      throw new GpuProtocolError("Missing encode bytes");
    const state = { bytes: fields.commands, encoder, offset: 0, finished: false };
    cursor.blob =
      kind === "command_encoder" ? { ...state, kind, pass: undefined } : { ...state, kind };
    // Only the envelope is charged here. Nested bytes are charged on each later step.
    return {
      kind: "progress",
      bytes: bytes.byteLength - fields.commands.byteLength,
      presented: false,
    };
  }
  #nested(cursor: Cursor, blob: Blob): ReplayStep {
    if (blob.offset === blob.bytes.byteLength) {
      if (blob.kind === "command_encoder" && blob.pass)
        throw new GpuProtocolError("Unclosed command pass");
      cursor.blob = undefined;
      const length = recordHeader(cursor.record.bytes, cursor.offset).length;
      this.#advance(cursor, length);
      return { kind: "progress", bytes: 0, presented: false };
    }
    if (blob.finished) throw new GpuProtocolError("Commands follow encoder finish");
    const header = recordHeader(blob.bytes, blob.offset);
    const call = decodeCall(blob.bytes.subarray(blob.offset, blob.offset + header.length));
    const pass = blob.kind === "command_encoder" ? blob.pass : undefined;
    const context = blob.kind === "render_bundle_encoder" ? "bundle" : pass ? "pass" : "encoder";
    if (call.layout.context !== context || call.layout.receiver !== (pass?.kind ?? blob.kind))
      throw new GpuProtocolError("Invalid encoder/pass nesting");
    this.#execute(call, pass?.handle ?? blob.encoder);
    if (!this.#live) return { kind: "terminal" };
    this.#nestedState(blob, call);
    blob.offset += header.length;
    return { kind: "progress", bytes: header.length, presented: false };
  }
  #nestedState(blob: Blob, call: DecodedCall): void {
    const name = call.layout.name;
    if (blob.kind === "command_encoder") {
      if (name === "command_encoder.begin_render_pass")
        blob.pass = { handle: wireHandle(call.fields.result), kind: "render_pass_encoder" };
      if (name === "command_encoder.begin_compute_pass")
        blob.pass = { handle: wireHandle(call.fields.result), kind: "compute_pass_encoder" };
      if (name === "render_pass_encoder.end" || name === "compute_pass_encoder.end")
        blob.pass = undefined;
    }
    if (name !== "command_encoder.finish" && name !== "render_bundle_encoder.finish") return;
    blob.finished = true;
    this.#finished.set(blob.encoder.id, blob.encoder.generation);
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
      layout.lowering.kind !== "async" &&
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
    const requestKind =
      call.layout.lowering.kind === "request-adapter"
        ? "adapter"
        : call.layout.lowering.kind === "request-device"
          ? "device"
          : undefined;
    if (requestKind && result) {
      const token = wireNumber(call.fields.token);
      this.completions.admit(token);
      this.#requestFailure(this.completions, result, requestKind, token, error);
      return;
    }
    if (result && call.layout.result.kind === "handle")
      this.handles.bind(result, objectKind(call.layout.result.object), {
        kind: "exception",
        message,
      });
    if (call.layout.lowering.kind === "async") {
      const token = wireNumber(call.fields.token);
      this.completions.admit(token);
      const name = call.layout.token;
      const status =
        name === "map-result"
          ? cValue("enum.map_async_status", "error")
          : name === "compilation-result"
            ? cValue("enum.compilation_info_request_status", "callback_cancelled")
            : cValue("enum.queue_work_done_status", "error");
      if (name)
        this.completions.publish(
          name,
          token,
          -28,
          name === "queue-work-result"
            ? { status, message }
            : { status, message, payload: null, length: 0 },
        );
      return;
    }
    // Even failed adaptation consumes a callback token exactly once.
    if (call.layout.name === "device.pop_error_scope")
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
      case "query":
        this.#metadata.query(layout, receiver, fields, this.completions);
        return false;
      case "async":
        this.#async(call, receiver);
        return false;
      case "label":
        if (layout.lowering.target === "surface-reference") surfaceLabel(receiver, fields.label);
        else nativeLabel(receiver, fields.label);
        return false;
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
        const surface = this.#surfaces().create(source.id, source.label, result);
        surfaceLabel(surface, source.label);
        this.#bind(call, result, surface);
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
          this.#sources.create(receiver, this.#lower.wgsl(fields.descriptor)),
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
      case "descriptor-method": {
        const native = nativeCall(receiver, layout.lowering.member, [
          this.#lower.dictionary(layout.lowering.descriptor, fields.descriptor),
        ]);
        this.#bind(call, result, native);
        if (layout.name === "device.create_buffer")
          this.#buffers.register(nativeObject(native), receiver, wireObject(fields.descriptor));
        return false;
      }
      case "set-immediates":
        nativeCall(receiver, layout.lowering.member, [fields.offset, wireBytes(fields.data)]);
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
      case "compute_pipeline.get_bind_group_layout":
      case "render_pipeline.get_bind_group_layout":
        this.#bind(call, result, nativeCall(receiver, "getBindGroupLayout", [fields.group_index]));
        return;
      case "render_bundle_encoder.finish":
        this.#bind(
          call,
          result,
          nativeCall(receiver, "finish", [
            this.#lower.dictionary("render_bundle_descriptor", fields.descriptor),
          ]),
        );
        return;
      case "render_pass_encoder.execute_bundles":
        nativeCall(receiver, "executeBundles", [
          this.#lower.value("array<object.render_bundle>", fields.bundles ?? null),
        ]);
        return;
      case "command_encoder.copy_buffer_to_buffer":
        nativeCall(receiver, "copyBufferToBuffer", [
          this.#lower.value("object.buffer", fields.source ?? null),
          this.#lower.value("uint64", fields.source_offset ?? null),
          this.#lower.value("object.buffer", fields.destination ?? null),
          this.#lower.value("uint64", fields.destination_offset ?? null),
          this.#lower.value("uint64", fields.size ?? null),
        ]);
        return;
      case "command_encoder.copy_buffer_to_texture":
      case "command_encoder.copy_texture_to_buffer":
      case "command_encoder.copy_texture_to_texture":
        this.#textureCopy(call, receiver);
        return;
      case "command_encoder.clear_buffer":
        nativeCall(receiver, "clearBuffer", [
          this.#lower.value("object.buffer", fields.buffer ?? null),
          this.#lower.value("uint64", fields.offset ?? null),
          fields.size === 0xffffffffffffffffn
            ? undefined
            : this.#lower.value("uint64", fields.size ?? null),
        ]);
        return;
      case "render_pass_encoder.set_stencil_reference":
        nativeCall(receiver, "setStencilReference", [fields.reference]);
        return;
      case "render_pass_encoder.set_blend_constant":
        nativeCall(receiver, "setBlendConstant", [this.#lower.dictionary("color", fields.color)]);
        return;
      case "render_pass_encoder.set_viewport":
        nativeCall(receiver, "setViewport", [
          fields.x,
          fields.y,
          fields.width,
          fields.height,
          fields.min_depth,
          fields.max_depth,
        ]);
        return;
      case "render_pass_encoder.set_scissor_rect":
        nativeCall(receiver, "setScissorRect", [fields.x, fields.y, fields.width, fields.height]);
        return;
      case "command_encoder.resolve_query_set":
        nativeCall(receiver, "resolveQuerySet", [
          this.#lower.value("object.query_set", fields.query_set ?? null),
          fields.first_query,
          fields.query_count,
          this.#lower.value("object.buffer", fields.destination ?? null),
          this.#lower.value("uint64", fields.destination_offset ?? null),
        ]);
        return;
      case "render_pass_encoder.begin_occlusion_query":
        nativeCall(receiver, "beginOcclusionQuery", [fields.query_index]);
        return;
      case "render_pass_encoder.end_occlusion_query":
        nativeCall(receiver, "endOcclusionQuery", []);
        return;
      case "render_pass_encoder.draw_indirect":
      case "render_pass_encoder.draw_indexed_indirect":
      case "render_bundle_encoder.draw_indirect":
      case "render_bundle_encoder.draw_indexed_indirect":
        nativeCall(
          receiver,
          call.layout.name.endsWith(".draw_indirect") ? "drawIndirect" : "drawIndexedIndirect",
          [
            this.#lower.value("object.buffer", fields.indirect_buffer ?? null),
            this.#lower.value("uint64", fields.indirect_offset ?? null),
          ],
        );
        return;
      case "compute_pass_encoder.set_pipeline":
        nativeCall(receiver, "setPipeline", [
          this.#lower.value("object.compute_pipeline", fields.pipeline ?? null),
        ]);
        return;
      case "compute_pass_encoder.dispatch_workgroups":
        nativeCall(receiver, "dispatchWorkgroups", [
          fields.workgroupCountX,
          fields.workgroupCountY,
          fields.workgroupCountZ,
        ]);
        return;
      case "compute_pass_encoder.dispatch_workgroups_indirect":
        nativeCall(receiver, "dispatchWorkgroupsIndirect", [
          this.#lower.value("object.buffer", fields.indirect_buffer ?? null),
          this.#lower.value("uint64", fields.indirect_offset ?? null),
        ]);
        return;
      case "command_encoder.push_debug_group":
      case "render_pass_encoder.push_debug_group":
      case "render_bundle_encoder.push_debug_group":
      case "compute_pass_encoder.push_debug_group":
        nativeCall(receiver, "pushDebugGroup", [fields.group_label]);
        return;
      case "command_encoder.insert_debug_marker":
      case "render_pass_encoder.insert_debug_marker":
      case "render_bundle_encoder.insert_debug_marker":
      case "compute_pass_encoder.insert_debug_marker":
        nativeCall(receiver, "insertDebugMarker", [fields.marker_label]);
        return;
      case "command_encoder.pop_debug_group":
      case "render_pass_encoder.pop_debug_group":
      case "render_bundle_encoder.pop_debug_group":
      case "compute_pass_encoder.pop_debug_group":
        nativeCall(receiver, "popDebugGroup", []);
        return;
      case "render_bundle_encoder.set_label":
      case "compute_pass_encoder.set_label":
        nativeLabel(receiver, fields.label);
        return;
      case "render_bundle_encoder.set_pipeline":
      case "render_pass_encoder.set_pipeline":
        nativeCall(receiver, "setPipeline", [
          this.#lower.value("object.render_pipeline", fields.pipeline ?? null),
        ]);
        return;
      case "render_bundle_encoder.draw":
      case "render_pass_encoder.draw":
        nativeCall(receiver, "draw", [
          fields.vertex_count,
          fields.instance_count,
          fields.first_vertex,
          fields.first_instance,
        ]);
        return;
      case "compute_pass_encoder.set_bind_group":
      case "render_bundle_encoder.set_bind_group":
      case "render_pass_encoder.set_bind_group":
        nativeCall(receiver, "setBindGroup", [
          fields.group_index,
          fields.group === null
            ? null
            : this.#lower.value("object.bind_group", fields.group ?? null),
          this.#lower.value("array<uint32>", fields.dynamic_offsets ?? null),
        ]);
        return;
      case "render_bundle_encoder.set_vertex_buffer":
      case "render_pass_encoder.set_vertex_buffer":
      case "render_bundle_encoder.set_index_buffer":
      case "render_pass_encoder.set_index_buffer":
        this.#bufferBinding(call, receiver);
        return;
      case "render_bundle_encoder.draw_indexed":
      case "render_pass_encoder.draw_indexed":
        nativeCall(receiver, "drawIndexed", [
          fields.index_count,
          fields.instance_count,
          fields.first_index,
          fields.base_vertex,
          fields.first_instance,
        ]);
        return;
      case "compute_pass_encoder.end":
      case "render_pass_encoder.end":
        nativeCall(receiver, "end", []);
        return;
      case "queue.submit":
        nativeCall(receiver, "submit", [
          this.#lower.value("array<object.command_buffer>", fields.commands ?? null),
        ]);
        return;
      case "texture.destroy":
        nativeCall(receiver, "destroy", []);
        this.target.surfaces?.textureDestroyed?.(receiver);
        return;
      case "buffer.unmap":
        this.#buffers.unmap(receiver);
        return;
      case "buffer.destroy":
        nativeCall(receiver, "destroy", []);
        this.#buffers.destroyed(receiver);
        return;
      case "device.destroy":
        nativeCall(receiver, "destroy", []);
        this.#buffers.deviceDestroyed(receiver);
        const observation = this.#devices.get(receiver);
        if (observation) {
          observation.sink.live = false;
          observation.destroyed = true;
        }
        return;
      case "query_set.destroy":
        nativeCall(receiver, "destroy", []);
        return;
      case "surface.unconfigure":
        this.#surfaces().unconfigure(receiver);
        return;
      default:
        throw new GpuProtocolError("Unclassified method lowering");
    }
  }
  #textureCopy(call: DecodedCall, receiver: object): void {
    const { fields, layout } = call;
    if (layout.lowering.kind !== "method") throw new GpuProtocolError("Invalid copy lowering");
    const source =
      layout.name === "command_encoder.copy_buffer_to_texture"
        ? "texel_copy_buffer_info"
        : "texel_copy_texture_info";
    const destination =
      layout.name === "command_encoder.copy_texture_to_buffer"
        ? "texel_copy_buffer_info"
        : "texel_copy_texture_info";
    nativeCall(receiver, layout.lowering.member, [
      this.#lower.dictionary(source, fields.source),
      this.#lower.dictionary(destination, fields.destination),
      this.#lower.dictionary("extent_3D", fields.copy_size),
    ]);
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
    if (call.layout.name.endsWith(".set_vertex_buffer")) {
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
      (owner, value) => {
        this.#requestResult(owner, result, kind, token, value);
        if (kind === "device" && value && typeof value === "object")
          this.#metadata.device(value, receiver);
      },
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
    if (kind === "device" && !this.#devices.has(object))
      this.#devices.set(object, observeDevice(owner, result, object));
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
  #async(call: DecodedCall, receiver: object): void {
    const token = wireNumber(call.fields.token);
    if (call.layout.name === "buffer.map_async") {
      this.#buffers.map(receiver, call.fields, this.completions);
      return;
    }
    if (call.layout.name === "shader_module.get_compilation_info") {
      this.#sources.compilation(receiver, token, this.completions);
      return;
    }
    this.completions.start(
      token,
      () => Promise.resolve(nativeCall(receiver, "onSubmittedWorkDone", [])),
      (owner) => {
        owner.publish("queue-work-result", token, 0, {
          status: cValue("enum.queue_work_done_status", "success"),
          message: "",
        });
      },
      (owner, error) => {
        owner.publish("queue-work-result", token, 0, {
          status: cValue("enum.queue_work_done_status", "error"),
          message: errorMessage(error),
        });
      },
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
      this.#frameTextures.add(texture);
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
      this.target.surfaces?.release(value);
      return;
    }
    if (kind === "buffer") {
      this.#buffers.release(value);
      return;
    }
    if (kind === "shader_module") {
      this.#sources.release(value);
      return;
    }
    // Releasing a guest handle is not WebGPU destroy(). Native bind groups and
    // command buffers retain ordinary resources. The owning device retires them.
    // Surface frames alone have the explicit discard-on-last-handle contract.
    if (kind !== "device" && !(kind === "texture" && this.#frameTextures.has(value))) return;
    const observed = this.#devices.get(value);
    observed?.stop();
    if (!observed?.destroyed) nativeCall(value, "destroy", []);
    if (kind === "device") {
      const observation = this.#devices.get(value);
      if (observation) observation.sink.live = false;
      this.#devices.delete(value);
      this.#buffers.deviceDestroyed(value);
    }
    if (kind === "texture") this.target.surfaces?.textureDestroyed?.(value);
  }
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
interface DeviceObservation {
  destroyed: boolean;
  sink: { owner: CompletionOwner | undefined; live: boolean };
  stop(): void;
}
function observeDevice(owner: CompletionOwner, handle: Handle, device: object): DeviceObservation {
  const sink: DeviceObservation["sink"] = { owner, live: true };
  const lost: unknown = Reflect.get(device, "lost");
  if (lost instanceof Promise) watchLoss(lost, sink, handle);
  const listener = deviceListener(sink, handle);
  const listens = typeof Reflect.get(device, "addEventListener") === "function";
  if (listens) nativeCall(device, "addEventListener", ["uncapturederror", listener]);
  let stopped = false;
  return {
    sink,
    destroyed: false,
    stop: () => {
      if (stopped) return;
      stopped = true;
      sink.owner = undefined;
      if (listens) nativeCall(device, "removeEventListener", ["uncapturederror", listener]);
    },
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

function watchLoss(
  lost: Promise<unknown>,
  sink: { owner: CompletionOwner | undefined; live: boolean },
  handle: Handle,
): void {
  void lost.then(
    (info: unknown) => {
      sink.live = false;
      publishLoss(sink.owner, handle, info);
    },
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

function nativeLabel(receiver: object, label: unknown): void {
  if (!Reflect.set(receiver, "label", label))
    throw new GpuCallError("Native label assignment failed");
}
function surfaceLabel(reference: object, label: unknown): void {
  // A Waffle surface is a service-owned reference, not a native canvas/context label setter.
  Object.defineProperty(reference, "label", { value: label, writable: true, configurable: true });
}
