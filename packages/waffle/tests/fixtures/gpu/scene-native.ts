import { gpuStream } from "../../../browser/gpu/generated/tables.js";
import { nativeCall, nativeObject, destroyNative } from "../../../browser/gpu/lowering.js";
import { GpuConnection } from "../../../browser/gpu/scheduler.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { LogicalAppend } from "../../../browser/gpu/transport.js";
import { ServiceCredit } from "../../../browser/gpu/protocol.js";
import { encodeGpuCommand } from "../../../tooling/gpu-stream-layout.js";
import {
  bufferDescriptor,
  depthState,
  depthStencil,
  layoutEntry,
  textureDescriptor,
} from "./scene-fixture.js";
import expected from "./expected.json";

const h = (id: number) => ({ id, generation: 1 });
function enumeration(type: string, name: string): number {
  const values: Readonly<Record<string, Readonly<Record<string, number>>>> = gpuStream.enums;
  const value = values[`enum.${type}`]?.[name];
  if (value === undefined) throw new Error(`Missing pinned C enum ${type}.${name}`);
  return value;
}
function send(connection: GpuConnection, bytes: Uint8Array): void {
  const writer = new LogicalAppend(connection.commands, bytes);
  let completed = false;
  try {
    for (let steps = 0; steps < 10000; steps++) {
      const state = writer.advance();
      connection.slice();
      if (connection.state.kind !== "ready") throw new Error("Native control connection closed");
      if (state === "done") {
        completed = true;
        return;
      }
      if (state === "terminal") throw new Error("Native control stream terminated");
    }
    throw new Error("Native control stream did not progress");
  } finally {
    if (!completed) writer.cancel();
  }
}
function record(connection: GpuConnection, name: string, input: unknown) {
  send(connection, encodeGpuCommand(gpuStream, name, input));
}
function create(connection: GpuConnection, name: string, id: number, descriptor: unknown) {
  record(connection, `device.create_${name}`, { result: h(id), receiver: h(3), descriptor });
}
function blob(encoder: number, records: Uint8Array[]): Uint8Array {
  const length = records.reduce((sum, entry) => sum + entry.byteLength, 0);
  const output = new Uint8Array(Math.ceil((20 + length) / 8) * 8);
  const view = new DataView(output.buffer);
  view.setUint16(0, 0x1001, true);
  view.setUint32(4, output.byteLength, true);
  view.setUint32(8, encoder, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, length, true);
  let at = 20;
  for (const entry of records) {
    output.set(entry, at);
    at += entry.byteLength;
  }
  return output;
}
function bytes(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}
const shader = `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var sampleImage: sampler;
struct Tint { color: vec4f }
@group(0) @binding(2) var<uniform> tint: Tint;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@location(0) position: vec3f, @location(1) uv: vec2f) -> Vertex {
  return Vertex(vec4f(position, 1), uv);
}
@fragment fn fs(vertex: Vertex) -> @location(0) vec4f {
  return textureSample(image, sampleImage, vertex.uv) * tint.color;
}`;
function resources(connection: GpuConnection, control: string) {
  const rgba = enumeration("texture_format", "RGBA8_unorm");
  const depth = enumeration("texture_format", "depth24_plus");
  create(connection, "buffer", 4, bufferDescriptor(120, 40));
  create(connection, "buffer", 5, bufferDescriptor(8, 24));
  create(connection, "buffer", 6, bufferDescriptor(512, 72));
  create(connection, "texture", 7, textureDescriptor(rgba));
  create(connection, "sampler", 8, null);
  const entries = [layoutEntry(0), layoutEntry(1), layoutEntry(2)];
  entries[0]!.texture.sample_type = 2;
  entries[1]!.sampler.type = 2;
  entries[2]!.buffer = {
    next_in_chain: [],
    type: 2,
    has_dynamic_offset: true,
    min_binding_size: 16,
  };
  create(connection, "bind_group_layout", 9, { next_in_chain: [], label: "", entries });
  create(connection, "pipeline_layout", 10, {
    next_in_chain: [],
    label: "",
    bind_group_layouts: [h(9)],
    immediate_size: 0,
  });
  record(connection, "texture.create_view", { result: h(11), receiver: h(7), descriptor: null });
  const entry = {
    next_in_chain: [],
    buffer: null,
    offset: 0,
    size: 0xffffffffffffffffn,
    sampler: null,
    texture_view: null,
  };
  create(connection, "bind_group", 12, {
    next_in_chain: [],
    label: "",
    layout: h(9),
    entries: [
      { ...entry, binding: 0, texture_view: h(11) },
      { ...entry, binding: 1, sampler: h(8) },
      { ...entry, binding: 2, buffer: h(6), size: 16 },
    ],
  });
  record(connection, "device.create_shader_module", {
    result: h(13),
    receiver: h(3),
    descriptor: { next_in_chain: [{ sType: 2, value: { code: shader } }], label: "" },
  });
  const pipeline = expected.vectors.find(
    (entry) => entry.command === "device.create_render_pipeline",
  )?.input.descriptor;
  if (!pipeline) throw new Error("Missing baseline pipeline descriptor");
  create(connection, "render_pipeline", 14, {
    ...pipeline,
    layout: h(10),
    vertex: {
      next_in_chain: [],
      module: h(13),
      entry_point: "vs",
      constants: [],
      buffers: [
        {
          next_in_chain: [],
          step_mode: 1,
          array_stride: 20,
          attributes: [
            {
              next_in_chain: [],
              format: enumeration("vertex_format", "float32x3"),
              offset: 0,
              shader_location: 0,
            },
            {
              next_in_chain: [],
              format: enumeration("vertex_format", "float32x2"),
              offset: 12,
              shader_location: 1,
            },
          ],
        },
      ],
    },
    fragment: {
      next_in_chain: [],
      module: h(13),
      entry_point: "fs",
      constants: [],
      targets: [{ next_in_chain: [], format: rgba, blend: null, write_mask: 15 }],
    },
    depth_stencil: {
      ...depthState(depth),
      depth_compare:
        control === "no-depth"
          ? enumeration("compare_function", "always")
          : enumeration("compare_function", "less"),
    },
  });
  create(connection, "texture", 15, textureDescriptor(rgba, 17));
  create(connection, "texture", 16, textureDescriptor(depth, 16));
  record(connection, "texture.create_view", { result: h(17), receiver: h(15), descriptor: null });
  record(connection, "texture.create_view", { result: h(18), receiver: h(16), descriptor: null });
}
function upload(connection: GpuConnection, control: string) {
  record(connection, "device.get_queue", { result: h(19), receiver: h(3) });
  record(connection, "queue.write_buffer", {
    receiver: h(19),
    buffer: h(4),
    buffer_offset: 0,
    data: bytes([
      -1, -1, 0.2, 0, 0, 3, -1, 0.2, 1, 0, -1, 3, 0.2, 0, 1, -1, -1, 0.8, 0, 0, 3, -1, 0.8, 1, 0,
      -1, 3, 0.8, 0, 1,
    ]),
  });
  record(connection, "queue.write_buffer", {
    receiver: h(19),
    buffer: h(5),
    buffer_offset: 0,
    data: new Uint8Array(new Uint16Array([0, 1, 2, 0]).buffer),
  });
  const colors = new Uint8Array(512);
  colors.set(bytes([1, 0, 0, 1]));
  colors.set(bytes([0, 1, 0, 1]), 256);
  record(connection, "queue.write_buffer", {
    receiver: h(19),
    buffer: h(6),
    buffer_offset: 0,
    data: colors,
  });
  record(connection, "queue.write_texture", {
    receiver: h(19),
    destination: { texture: h(7), mip_level: 0, origin: { x: 0, y: 0, z: 0 }, aspect: 0 },
    data:
      control === "black-texture"
        ? new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
        : new Uint8Array(16).fill(255),
    data_layout: { offset: 0, bytes_per_row: 8, rows_per_image: 2 },
    write_size: { width: 2, height: 2, depth_or_array_layers: 1 },
  });
}
function draw(connection: GpuConnection) {
  record(connection, "device.create_command_encoder", {
    result: h(20),
    receiver: h(3),
    descriptor: null,
  });
  const call = (name: string, input: unknown) => encodeGpuCommand(gpuStream, name, input);
  send(
    connection,
    blob(20, [
      call("command_encoder.begin_render_pass", {
        result: h(21),
        descriptor: {
          next_in_chain: [],
          label: "",
          color_attachments: [
            {
              next_in_chain: [],
              view: h(17),
              depth_slice: 0xffffffff,
              resolve_target: null,
              load_op: 2,
              store_op: 1,
              clear_value: { r: 0, g: 0, b: 1, a: 1 },
            },
          ],
          depth_stencil_attachment: depthStencil(h(18)),
          occlusion_query_set: null,
          timestamp_writes: null,
        },
      }),
      call("render_pass_encoder.set_pipeline", { pipeline: h(14) }),
      call("render_pass_encoder.set_vertex_buffer", {
        slot: 0,
        buffer: h(4),
        offset: 0,
        size: 0xffffffffffffffffn,
      }),
      call("render_pass_encoder.set_index_buffer", {
        buffer: h(5),
        format: 1,
        offset: 0,
        size: 0xffffffffffffffffn,
      }),
      call("render_pass_encoder.set_bind_group", {
        group_index: 0,
        group: h(12),
        dynamic_offsets: [0],
      }),
      call("render_pass_encoder.draw_indexed", {
        index_count: 3,
        instance_count: 1,
        first_index: 0,
        base_vertex: 0,
        first_instance: 0,
      }),
      call("render_pass_encoder.set_bind_group", {
        group_index: 0,
        group: h(12),
        dynamic_offsets: [256],
      }),
      call("render_pass_encoder.draw_indexed", {
        index_count: 3,
        instance_count: 1,
        first_index: 0,
        base_vertex: 3,
        first_instance: 0,
      }),
      call("render_pass_encoder.end", {}),
      call("command_encoder.finish", { result: h(22), descriptor: null }),
    ]),
  );
  record(connection, "queue.submit", { receiver: h(19), commands: [h(22)] });
}
async function pixels(connection: GpuConnection, device: object): Promise<number[]> {
  const buffer = nativeObject(nativeCall(device, "createBuffer", [{ size: 512, usage: 9 }]));
  try {
    const encoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
    nativeCall(encoder, "copyTextureToBuffer", [
      { texture: connection.replay.handles.native(h(15), "texture") },
      { buffer, bytesPerRow: 256 },
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    ]);
    nativeCall(nativeObject(Reflect.get(device, "queue")), "submit", [
      [nativeObject(nativeCall(encoder, "finish", []))],
    ]);
    await nativeCall(buffer, "mapAsync", [1]);
    const range = nativeCall(buffer, "getMappedRange", []);
    if (!(range instanceof ArrayBuffer)) throw new Error("Missing native readback range");
    return Array.from(new Uint8Array(range, 0, 4));
  } finally {
    destroyNative(buffer);
  }
}
async function nativeValidation(connection: GpuConnection, replies: RecordRing) {
  record(connection, "device.push_error_scope", { receiver: h(3), filter: 1 });
  create(connection, "buffer", 23, bufferDescriptor(0, 0));
  if (connection.replay.handles.get(h(23), "buffer").kind !== "native")
    throw new Error("Invalid native buffer became JS exception placeholder");
  create(connection, "bind_group", 24, {
    next_in_chain: [],
    label: "",
    layout: h(9),
    entries: [
      {
        next_in_chain: [],
        binding: 2,
        buffer: h(23),
        offset: 0,
        size: 16,
        sampler: null,
        texture_view: null,
      },
    ],
  });
  if (connection.replay.handles.get(h(24), "bind_group").kind !== "native")
    throw new Error("Dependent invalid bind group became JS exception placeholder");
  record(connection, "device.pop_error_scope", { receiver: h(3), token: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const scratch = new Uint8Array(replies.capacity);
  const result = replies.readInto(scratch);
  if (result.kind !== "record") throw new Error("Missing native scope result");
  const view = new DataView(scratch.buffer);
  const kind = gpuStream.completions.find((entry) => entry.name === "error-scope")?.kind;
  if (
    view.getUint16(0, true) !== kind ||
    view.getInt32(12, true) !== 0 ||
    view.getUint32(20, true) !== enumeration("error_type", "validation")
  )
    throw new Error("Native scope did not report validation");
  if (replies.readInto(scratch).kind !== "empty")
    throw new Error("Unexpected call exception or uncaptured error");
  return {
    nativeInvalidCreation: true,
    dependentNativeInvalidCreation: true,
    errorScopeValidation: true,
  };
}
/** @browserEntry Bounded native lowering control, never a compiled guest acceptance fixture. */
export async function sceneNativeControl(control = "normal") {
  const gpu = nativeObject(Reflect.get(navigator, "gpu"));
  const adapter = nativeObject(
    await nativeCall(gpu, "requestAdapter", [{ forceFallbackAdapter: true }]),
  );
  const info: unknown = Reflect.get(adapter, "info");
  if (!info || typeof info !== "object" || Reflect.get(info, "architecture") !== "swiftshader")
    throw new Error("Native control requires designated SwiftShader");
  const device = nativeObject(await nativeCall(adapter, "requestDevice", []));
  const credit = new ServiceCredit();
  const replies = new RecordRing(new SharedArrayBuffer(64 + 4096), 16);
  const connection = new GpuConnection(
    new RecordRing(new SharedArrayBuffer(64 + 4096), 8),
    replies,
    { root: gpu },
    credit,
  );
  try {
    connection.replay.handles.reserve(h(3), "device");
    connection.replay.handles.bind(h(3), "device", { kind: "native", value: device });
    nativeCall(device, "pushErrorScope", ["validation"]);
    resources(connection, control);
    upload(connection, control);
    draw(connection);
    const pixel = await pixels(connection, device);
    const error = await nativeCall(device, "popErrorScope", []);
    if (error)
      throw new Error(
        `Native scene lowering validation: ${Reflect.get(nativeObject(error), "message")}`,
      );
    const expectedPixel =
      control === "no-depth"
        ? "0,255,0,255"
        : control === "black-texture"
          ? "0,0,0,255"
          : "255,0,0,255";
    if (pixel.join(",") !== expectedPixel)
      throw new Error(`Depth/texture control ${control} pixels ${pixel}`);
    const invalid = await nativeValidation(connection, replies);
    connection.close();
    if (credit.used !== 0) throw new Error("Native control retained credit");
    return { kind: "native-lowering-control", compiledGuest: false, control, pixel, ...invalid };
  } finally {
    connection.close();
    destroyNative(device);
  }
}
