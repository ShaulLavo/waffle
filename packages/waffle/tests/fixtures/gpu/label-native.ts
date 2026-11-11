import type { ObjectKind } from "../../../browser/gpu/handles.js";
import { nativeCall, nativeObject } from "../../../browser/gpu/lowering.js";
import { GpuSurfaces } from "../../../browser/gpu/surfaces.js";
import type { Handle } from "../../../browser/gpu/protocol.js";
import type { GpuConnection } from "../../../browser/gpu/scheduler.js";
import type { RecordRing } from "../../../browser/gpu/ring.js";
import {
  blob,
  call,
  encoded,
  h,
  nativeRig,
  publish,
  renderDescriptor,
} from "./bundle-query-fixture.js";

type LabeledObject = { kind: ObjectKind; handle: Handle; native: object };
const label = "λ猫 GPU label";
const code = `override mask: u32;
@compute @workgroup_size(1) fn cs() { _ = mask; }
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i), 0, 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }`;

function bind(
  connection: GpuConnection,
  kind: ObjectKind,
  native: object,
  id: number,
): LabeledObject {
  const handle = h(id);
  connection.replay.handles.reserve(handle, kind);
  connection.replay.handles.bind(handle, kind, { kind: "native", value: native });
  return { kind, handle, native };
}
function resources(connection: GpuConnection, device: object): LabeledObject[] {
  const create = (method: string, descriptor: object) =>
    nativeObject(nativeCall(device, method, [descriptor]));
  const layout = create("createBindGroupLayout", { entries: [] });
  const pipelineLayout = create("createPipelineLayout", { bindGroupLayouts: [] });
  const shader = create("createShaderModule", { code });
  const texture = create("createTexture", { size: [4, 4], format: "rgba8unorm", usage: 16 });
  const bundleEncoder = create("createRenderBundleEncoder", { colorFormats: ["rgba8unorm"] });
  const objects: readonly (readonly [ObjectKind, object])[] = [
    ["queue", nativeObject(Reflect.get(device, "queue"))],
    ["bind_group_layout", layout],
    ["bind_group", create("createBindGroup", { layout, entries: [] })],
    ["pipeline_layout", pipelineLayout],
    ["shader_module", shader],
    ["buffer", create("createBuffer", { size: 16, usage: 8 })],
    [
      "compute_pipeline",
      create("createComputePipeline", {
        layout: pipelineLayout,
        compute: { module: shader, entryPoint: "cs", constants: { mask: 1 } },
      }),
    ],
    [
      "render_pipeline",
      create("createRenderPipeline", {
        layout: pipelineLayout,
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      }),
    ],
    ["texture", texture],
    ["texture_view", nativeObject(nativeCall(texture, "createView", []))],
    ["sampler", create("createSampler", {})],
    ["query_set", create("createQuerySet", { type: "occlusion", count: 1 })],
    ["render_bundle", nativeObject(nativeCall(bundleEncoder, "finish", []))],
    ["command_encoder", create("createCommandEncoder", {})],
  ];
  const deviceObject: LabeledObject = { kind: "device", handle: h(3), native: device };
  return [deviceObject].concat(
    objects.map(([kind, native], index) => bind(connection, kind, native, index + 4)),
  );
}
function find(objects: readonly LabeledObject[], kind: ObjectKind): LabeledObject {
  const found = objects.find((object) => object.kind === kind);
  if (!found) throw new Error(`Missing native label object: ${kind}`);
  return found;
}
function reflect(object: LabeledObject, value: string): void {
  if (Reflect.get(object.native, "label") !== value)
    throw new Error(`Native label did not reflect: ${object.kind}`);
}
function ordinaryLabels(connection: GpuConnection, objects: readonly LabeledObject[]) {
  const evidence: string[] = [];
  for (const object of objects) {
    if (object.kind === "command_encoder") continue;
    call(connection, `${object.kind}.set_label`, { receiver: object.handle, label });
    reflect(object, label);
    call(connection, `${object.kind}.set_label`, { receiver: object.handle, label: "" });
    reflect(object, "");
    evidence.push(object.kind);
  }
  return evidence;
}
function encoderLabels(connection: GpuConnection, objects: readonly LabeledObject[]) {
  const encoder = find(objects, "command_encoder");
  const view = find(objects, "texture_view");
  const descriptor = renderDescriptor(view.handle.id, null);
  publish(
    connection,
    blob(0x1001, encoder.handle.id, [
      encoded("command_encoder.set_label", { label }),
      encoded("command_encoder.begin_render_pass", { result: h(30), descriptor }),
      encoded("render_pass_encoder.set_label", { label }),
      encoded("render_pass_encoder.end"),
      encoded("command_encoder.finish", { result: h(31), descriptor: null }),
    ]),
  );
  const pass: LabeledObject = {
    kind: "render_pass_encoder",
    handle: h(30),
    native: connection.replay.handles.native(h(30), "render_pass_encoder"),
  };
  const commands: LabeledObject = {
    kind: "command_buffer",
    handle: h(31),
    native: connection.replay.handles.native(h(31), "command_buffer"),
  };
  reflect(encoder, label);
  reflect(pass, label);
  call(connection, "command_buffer.set_label", { receiver: commands.handle, label });
  reflect(commands, label);
  call(connection, "command_buffer.set_label", { receiver: commands.handle, label: "" });
  reflect(commands, "");
  return [encoder.kind, pass.kind, commands.kind];
}
function replyKinds(replies: RecordRing) {
  const kinds: number[] = [];
  const output = new Uint8Array(replies.capacity);
  for (let turn = 0; turn < 100; turn++) {
    if (replies.readInto(output).kind !== "record") return kinds;
    kinds.push(new DataView(output.buffer).getUint16(0, true));
  }
  throw new Error("Label control reply bound exceeded");
}
async function invalidIdentities(
  connection: GpuConnection,
  device: object,
  replies: RecordRing,
  shader: LabeledObject,
) {
  nativeCall(device, "pushErrorScope", ["validation"]);
  call(connection, "device.create_buffer", {
    result: h(40),
    receiver: h(3),
    descriptor: {
      next_in_chain: [],
      label: "invalid",
      usage: 0,
      size: 16,
      mapped_at_creation: false,
    },
  });
  const invalid = connection.replay.handles.native(h(40), "buffer");
  call(connection, "buffer.set_label", { receiver: h(40), label });
  reflect({ kind: "buffer", handle: h(40), native: invalid }, label);
  if (connection.replay.handles.native(h(40), "buffer") !== invalid)
    throw new Error("Invalid native identity replaced during labeling");
  const validation = await nativeCall(device, "popErrorScope", []);
  if (!validation || nativeObject(validation).constructor.name !== "GPUValidationError")
    throw new Error("Invalid native buffer was not validated natively");
  if (replyKinds(replies).length) throw new Error("Invalid native became a call exception");
  nativeCall(device, "pushErrorScope", ["validation"]);
  call(connection, "device.create_compute_pipeline", {
    result: h(41),
    receiver: h(3),
    descriptor: {
      next_in_chain: [],
      label: "exception",
      layout: null,
      compute: {
        next_in_chain: [],
        module: shader.handle,
        entry_point: "cs",
        constants: [{ next_in_chain: [], key: "mask", value: Infinity }],
      },
    },
  });
  const before = connection.replay.handles.get(h(41), "compute_pipeline");
  call(connection, "compute_pipeline.set_label", { receiver: h(41), label });
  const after = connection.replay.handles.get(h(41), "compute_pipeline");
  const scope = await nativeCall(device, "popErrorScope", []);
  const exceptions = replyKinds(replies);
  if (
    before.kind !== "exception" ||
    after !== before ||
    scope !== null ||
    exceptions.join(",") !== "8,8"
  )
    throw new Error("JavaScript exception placeholder became a native object during labeling");
  return { invalidNative: true, exceptionPlaceholder: true, exceptions };
}
function virtualSurface(connection: GpuConnection, device: object) {
  const surfaces = new GpuSurfaces();
  const canvas = new OffscreenCanvas(4, 4);
  surfaces.register(7);
  surfaces.attach([{ id: 7, canvas }]);
  const owner = surfaces.connection([7], connection.completions);
  const reference = owner.create(7, "initial", h(50));
  const snapshot = JSON.stringify(surfaces.snapshot());
  const deviceLabel = Reflect.get(device, "label");
  try {
    bind(connection, "surface", reference, 50);
    call(connection, "surface.set_label", { receiver: h(50), label });
    if (
      Reflect.get(reference, "label") !== label ||
      canvas.width !== 4 ||
      canvas.height !== 4 ||
      Reflect.get(device, "label") !== deviceLabel ||
      JSON.stringify(surfaces.snapshot()) !== snapshot ||
      Object.hasOwn(canvas, "label")
    )
      throw new Error("Virtual surface label mutated native authority");
    return {
      kind: "waffle-surface-reference-adaptation",
      nativeSurface: false,
      label: Reflect.get(reference, "label"),
      unchangedPresentation: true,
    };
  } finally {
    owner.dispose();
    surfaces.dispose(7);
  }
}

/** Trusted native-object reflection, not compiled guest acceptance. */
export async function labelNativeControl(control: string) {
  if (control !== "labels") throw new Error(`Unknown label control: ${control}`);
  const gpu = nativeObject(Reflect.get(navigator, "gpu"));
  const adapter = nativeObject(
    await nativeCall(gpu, "requestAdapter", [{ forceFallbackAdapter: true }]),
  );
  if (Reflect.get(nativeObject(Reflect.get(adapter, "info")), "architecture") !== "swiftshader")
    throw new Error("Labels require designated SwiftShader");
  const device = nativeObject(await nativeCall(adapter, "requestDevice", []));
  const { connection, credit, replies } = nativeRig(gpu, device);
  try {
    nativeCall(device, "pushErrorScope", ["validation"]);
    const objects = resources(connection, device);
    const reflected = ordinaryLabels(connection, objects).concat(
      encoderLabels(connection, objects),
    );
    const validation = await nativeCall(device, "popErrorScope", []);
    if (
      validation ||
      replyKinds(replies).length ||
      reflected.length !== 17 ||
      new Set(reflected).size !== 17
    )
      throw new Error(`Native label inventory or validation failed: ${reflected}`);
    const errors = await invalidIdentities(
      connection,
      device,
      replies,
      find(objects, "shader_module"),
    );
    const surface = virtualSurface(connection, device);
    if (connection.state.kind !== "ready" || replyKinds(replies).length)
      throw new Error("Label connection did not survive native controls");
    connection.close();
    if (credit.used) throw new Error("Labels retained connection credit");
    return {
      control,
      kind: "native-lowering-control",
      compiledGuest: false,
      status: "passed",
      adapter: "swiftshader",
      reflected,
      errors,
      surface,
    };
  } finally {
    connection.close();
  }
}
