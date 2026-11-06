import { nativeCall, nativeObject } from "../../../browser/gpu/lowering.js";
import { GpuSurfaces } from "../../../browser/gpu/surfaces.js";
import type { RecordRing } from "../../../browser/gpu/ring.js";
import type { GpuConnection } from "../../../browser/gpu/scheduler.js";
import {
  nativeRig,
  call,
  create,
  encoded,
  h,
  release,
  renderDescriptor,
} from "./bundle-query-fixture.js";
import { bufferDescriptor, textureDescriptor, depthState, depthStencil } from "./scene-fixture.js";
import { assertBytes, bind, readback, replies, submit } from "./copy-draw-fixture.js";
import baseline from "./expected.json";

const size = { width: 2, height: 2, depth_or_array_layers: 2 };
const origin = (x = 0, y = 0) => ({ x, y, z: 0 });
const textureInfo = (id: number, x = 0, y = 0) => ({
  texture: h(id),
  mip_level: 0,
  origin: origin(x, y),
  aspect: 1,
});
function bufferInfo(id: number, offset: number, rows: number) {
  return { layout: { offset, bytes_per_row: 256, rows_per_image: rows }, buffer: h(id) };
}
function copyRecords(control: string) {
  const records: Uint8Array[] = [];
  if (control !== "no-buffer-copy")
    records.push(
      encoded("command_encoder.copy_buffer_to_buffer", {
        source: h(5),
        source_offset: 16,
        destination: h(7),
        destination_offset: 8,
        size: 8,
      }),
    );
  if (control !== "no-clear")
    records.push(encoded("command_encoder.clear_buffer", { buffer: h(7), offset: 12, size: 4 }));
  if (control !== "no-buffer-texture")
    records.push(
      encoded("command_encoder.copy_buffer_to_texture", {
        source: bufferInfo(5, 16, 3),
        destination: textureInfo(8, 1, 1),
        copy_size: size,
      }),
    );
  if (control !== "no-texture-copy")
    records.push(
      encoded("command_encoder.copy_texture_to_texture", {
        source: textureInfo(8, 1, 1),
        destination: textureInfo(9),
        copy_size: size,
      }),
    );
  if (control !== "no-texture-buffer")
    records.push(
      encoded("command_encoder.copy_texture_to_buffer", {
        source: textureInfo(9),
        destination: bufferInfo(6, 32, 4),
        copy_size: size,
      }),
    );
  return records;
}
function pattern(changed: boolean): number[] {
  return Array.from({ length: 32 }, (_, i) => (changed ? 111 : 21) + i);
}
function copyExpected(control: string) {
  const values = pattern(control === "changed-copy-input");
  const texture = new Uint8Array(2048);
  if (!["no-buffer-texture", "no-texture-copy", "no-texture-buffer"].includes(control))
    for (let row = 0; row < 4; row++)
      texture.set(
        values.slice(row * 8, row * 8 + 8),
        32 + (row % 2) * 256 + Math.floor(row / 2) * 1024,
      );
  const buffer = new Uint8Array(32).fill(123);
  if (control !== "no-buffer-copy") buffer.set(values.slice(0, 8), 8);
  if (control !== "no-clear") buffer.fill(0, 12, 16);
  return { texture: Array.from(texture), buffer: Array.from(buffer) };
}
async function copies(connection: GpuConnection, device: object, control: string) {
  for (const [id, bytes] of [
    [5, 2048],
    [6, 2048],
    [7, 32],
  ])
    create(connection, "buffer", id!, bufferDescriptor(bytes, 12));
  for (const id of [8, 9])
    create(connection, "texture", id, {
      ...textureDescriptor(22, 3),
      size: { width: 4, height: 4, depth_or_array_layers: 2 },
    });
  const values = pattern(control === "changed-copy-input");
  const upload = new Uint8Array(2048).fill(199);
  for (let row = 0; row < 4; row++)
    upload.set(
      values.slice(row * 8, row * 8 + 8),
      16 + (row % 2) * 256 + Math.floor(row / 2) * 768,
    );
  call(connection, "queue.write_buffer", {
    receiver: h(4),
    buffer: h(5),
    buffer_offset: 0,
    data: upload,
  });
  call(connection, "queue.write_buffer", {
    receiver: h(4),
    buffer: h(7),
    buffer_offset: 0,
    data: new Uint8Array(32).fill(123),
  });
  submit(connection, copyRecords(control));
  release(connection, "buffer", 5);
  const actual = {
    texture: await readback(device, connection.replay.handles.native(h(6), "buffer"), 2048),
    buffer: await readback(device, connection.replay.handles.native(h(7), "buffer"), 32),
  };
  const expected = copyExpected(control);
  assertBytes(actual.texture, expected.texture, control);
  assertBytes(actual.buffer, expected.buffer, control);
  return {
    status: "passed",
    sampledRows: [32, 288, 1056, 1312].map((at) => actual.texture.slice(at, at + 8)),
    buffer: actual.buffer,
    allPaddingChecked: true,
  };
}
function pipeline(connection: GpuConnection, immediate: boolean) {
  const code = `${immediate ? "requires immediate_address_space; var<immediate> color: vec4f;" : ""}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[i], 0.5, 1);
}
@fragment fn fs() -> @location(0) vec4f { return ${immediate ? "color" : "vec4f(1, 1, 1, 1)"}; }`;
  call(connection, "device.create_shader_module", {
    result: h(5),
    receiver: h(3),
    descriptor: { next_in_chain: [{ sType: 2, value: { code } }], label: "copy/draw" },
  });
  const original = baseline.vectors.find(
    (entry) => entry.command === "device.create_render_pipeline",
  )?.input.descriptor;
  if (!original) throw new Error("Missing pipeline base");
  const stencil = {
    ...depthState(47),
    depth_compare: 2,
    stencil_front: { compare: 3, fail_op: 1, depth_fail_op: 1, pass_op: 1 },
    stencil_back: { compare: 3, fail_op: 1, depth_fail_op: 1, pass_op: 1 },
  };
  create(connection, "render_pipeline", 6, {
    ...original,
    vertex: { next_in_chain: [], module: h(5), entry_point: "vs", constants: [], buffers: [] },
    depth_stencil: stencil,
    fragment: {
      next_in_chain: [],
      module: h(5),
      entry_point: "fs",
      constants: [],
      targets: [
        {
          next_in_chain: [],
          format: 22,
          write_mask: 15,
          blend: {
            color: { operation: 1, src_factor: 12, dst_factor: 1 },
            alpha: { operation: 1, src_factor: 2, dst_factor: 1 },
          },
        },
      ],
    },
  });
}
function drawResources(connection: GpuConnection, immediate: boolean) {
  pipeline(connection, immediate);
  create(connection, "buffer", 7, bufferDescriptor(48, 264));
  create(connection, "buffer", 8, bufferDescriptor(8, 24));
  call(connection, "queue.write_buffer", {
    receiver: h(4),
    buffer: h(7),
    buffer_offset: 0,
    data: new Uint8Array(new Uint32Array([0, 3, 1, 0, 0, 0, 3, 1, 0, 0, 0, 0]).buffer),
  });
  call(connection, "queue.write_buffer", {
    receiver: h(4),
    buffer: h(8),
    buffer_offset: 0,
    data: new Uint8Array(new Uint16Array([0, 1, 2, 0]).buffer),
  });
  for (const [id, format, usage] of [
    [9, 22, 17],
    [11, 47, 16],
  ]) {
    create(connection, "texture", id!, {
      ...textureDescriptor(format, usage),
      size: { width: 4, height: 4, depth_or_array_layers: 1 },
    });
    call(connection, "texture.create_view", {
      result: h(id! + 1),
      receiver: h(id!),
      descriptor: null,
    });
  }
}
function drawRecords(control: string, immediate: boolean) {
  const depth = {
    ...depthStencil(h(12)),
    depth_clear_value: 0.4,
    stencil_load_op: 2,
    stencil_store_op: 1,
    stencil_clear_value: 7,
  };
  const descriptor = { ...renderDescriptor(10, null), depth_stencil_attachment: depth };
  const records = [
    encoded("command_encoder.push_debug_group", { group_label: "copy/draw" }),
    encoded("command_encoder.insert_debug_marker", { marker_label: "pass" }),
    encoded("command_encoder.begin_render_pass", { result: h(21), descriptor }),
    encoded("render_pass_encoder.push_debug_group", { group_label: "state" }),
    encoded("render_pass_encoder.insert_debug_marker", { marker_label: "indirect" }),
    encoded("render_pass_encoder.set_pipeline", { pipeline: h(6) }),
    encoded("render_pass_encoder.set_index_buffer", {
      buffer: h(8),
      format: 1,
      offset: 0,
      size: 0xffffffffffffffffn,
    }),
  ];
  if (control !== "no-stencil")
    records.push(
      encoded("render_pass_encoder.set_stencil_reference", {
        reference: control === "changed-stencil" ? 6 : 7,
      }),
    );
  if (control !== "no-blend")
    records.push(
      encoded("render_pass_encoder.set_blend_constant", {
        color:
          control === "changed-blend" ? { r: 0, g: 1, b: 0, a: 1 } : { r: 1, g: 0, b: 0, a: 1 },
      }),
    );
  if (control !== "no-viewport")
    records.push(
      encoded("render_pass_encoder.set_viewport", {
        x: control === "changed-viewport" ? 2 : 0,
        y: 0,
        width: 2,
        height: 4,
        min_depth: control === "changed-depth-range" ? 0.5 : 0,
        max_depth: control === "changed-depth-range" ? 1 : 0.5,
      }),
    );
  if (control !== "no-scissor")
    records.push(
      encoded("render_pass_encoder.set_scissor_rect", {
        x: control === "changed-scissor" ? 0 : 1,
        y: 1,
        width: 2,
        height: 2,
      }),
    );
  if (immediate)
    records.push(
      encoded("render_pass_encoder.set_immediates", {
        offset: 0,
        data: new Uint8Array(
          new Float32Array(control === "zero-immediates" ? [0, 0, 0, 1] : [1, 1, 1, 1]).buffer,
        ),
      }),
    );
  if (control !== "no-draw")
    records.push(
      encoded(
        `render_pass_encoder.${control === "indexed-indirect" ? "draw_indexed_indirect" : "draw_indirect"}`,
        { indirect_buffer: h(7), indirect_offset: control === "indexed-indirect" ? 24 : 4 },
      ),
    );
  return records.concat([
    encoded("render_pass_encoder.pop_debug_group"),
    encoded("render_pass_encoder.end"),
    encoded("command_encoder.pop_debug_group"),
  ]);
}
function drawExpected(control: string): number[] {
  const result = new Uint8Array(1024);
  for (let pixel = 0; pixel < 16; pixel++) {
    const x = pixel % 4,
      y = Math.floor(pixel / 4);
    const visible =
      !["no-draw", "no-stencil", "changed-stencil", "no-viewport", "changed-depth-range"].includes(
        control,
      ) &&
      x >= (control === "changed-viewport" ? 2 : 0) &&
      x < (control === "changed-viewport" ? 4 : 2) &&
      (control === "no-scissor" ||
        (x >= (control === "changed-scissor" ? 0 : 1) &&
          x < (control === "changed-scissor" ? 2 : 3) &&
          y >= 1 &&
          y < 3));
    const color = !visible
      ? [0, 0, 255, 255]
      : ["no-blend", "zero-immediates"].includes(control)
        ? [0, 0, 0, 255]
        : control === "changed-blend"
          ? [0, 255, 0, 255]
          : [255, 0, 0, 255];
    result.set(color, y * 256 + x * 4);
  }
  return Array.from(result);
}
async function draws(
  connection: GpuConnection,
  device: object,
  control: string,
  immediate: boolean,
  ring: RecordRing,
) {
  drawResources(connection, immediate);
  submit(connection, drawRecords(control, immediate));
  release(connection, "buffer", 7);
  release(connection, "buffer", 8);
  release(connection, "render_pipeline", 6);
  replies(ring, true);
  const pixels = await readback(
    device,
    connection.replay.handles.native(h(9), "texture"),
    1024,
    true,
  );
  assertBytes(pixels, drawExpected(control), control);
  return {
    status: "passed",
    pixels: Array.from({ length: 4 }, (_, row) => pixels.slice(row * 256, row * 256 + 16)),
    allPaddingChecked: true,
  };
}
function availability(gpu: object, device: object) {
  const encoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
  const pass = nativeObject(nativeCall(encoder, "beginRenderPass", [{ colorAttachments: [] }]));
  const method = typeof Reflect.get(pass, "setImmediates");
  const maxImmediateSize: unknown = Reflect.get(
    nativeObject(Reflect.get(device, "limits")),
    "maxImmediateSize",
  );
  const language =
    nativeCall(nativeObject(Reflect.get(gpu, "wgslLanguageFeatures")), "has", [
      "immediate_address_space",
    ]) === true;
  nativeCall(pass, "end", []);
  nativeCall(encoder, "finish", []);
  return {
    method,
    maxImmediateSize: typeof maxImmediateSize === "number" ? maxImmediateSize : null,
    language,
  };
}

async function validationResult(device: object, ring: RecordRing, exception = false) {
  const error = await nativeCall(device, "popErrorScope", []);
  const kinds = replies(ring);
  const validation =
    error !== null && nativeObject(error).constructor.name === "GPUValidationError";
  if (validation === exception || kinds.join(",") !== (exception ? "8" : ""))
    throw new Error(`Wrong native error class: ${validation}, replies ${kinds}`);
  return { validation, callException: exception };
}
async function destroyed(
  connection: GpuConnection,
  device: object,
  ring: RecordRing,
  control: string,
) {
  const surfaces = new GpuSurfaces();
  let source: object;
  try {
    if (control === "destroy-buffer") {
      create(connection, "buffer", 5, bufferDescriptor(16, 12));
      create(connection, "buffer", 7, bufferDescriptor(16, 12));
      source = connection.replay.handles.native(h(5), "buffer");
      bind(connection, 6, "buffer", source);
      call(connection, "buffer.destroy", { receiver: h(6) });
      nativeCall(device, "pushErrorScope", ["validation"]);
      submit(connection, [
        encoded("command_encoder.copy_buffer_to_buffer", {
          source: h(5),
          source_offset: 0,
          destination: h(7),
          destination_offset: 0,
          size: 4,
        }),
      ]);
    } else source = destroyTexture(connection, device, ring, surfaces, control);
    const kind = control === "destroy-buffer" ? "buffer" : "texture";
    if (
      connection.replay.handles.native(h(5), kind) !== source ||
      connection.replay.handles.native(h(6), kind) !== source
    )
      throw new Error("Destroy invalidated guest identity rather than native storage");
    const result = await validationResult(device, ring);
    if (
      connection.replay.handles.get(h(22), "command_buffer").kind !== "native" ||
      connection.state.kind !== "ready"
    )
      throw new Error("Invalid native command buffer became a protocol fault or placeholder");
    return {
      status: "passed",
      ...result,
      aliasesPreserved: true,
      acquiredFrame: control === "destroy-frame",
    };
  } finally {
    surfaces.dispose(1);
  }
}
function destroyTexture(
  connection: GpuConnection,
  device: object,
  ring: RecordRing,
  surfaces: GpuSurfaces,
  control: string,
): object {
  const source = acquiredTexture(connection, surfaces, control === "destroy-frame");
  call(connection, "texture.create_view", { result: h(9), receiver: h(5), descriptor: null });
  replies(ring);
  bind(connection, 6, "texture", source);
  call(connection, "texture.destroy", { receiver: h(6) });
  nativeCall(device, "pushErrorScope", ["validation"]);
  if (control !== "destroy-frame") {
    submit(connection, [
      encoded("command_encoder.begin_render_pass", {
        result: h(21),
        descriptor: renderDescriptor(9, null),
      }),
      encoded("render_pass_encoder.end"),
    ]);
    return source;
  }
  if (surfaces.snapshot().frameTexturesLive !== 0)
    throw new Error("Explicit frame destroy retained its storage");
  call(connection, "surface.get_current_texture", { result: h(13), receiver: h(30), token: 2 });
  if (connection.replay.handles.native(h(13), "texture") === source)
    throw new Error("Destroyed frame was reacquired");
  replies(ring);
  create(connection, "buffer", 7, bufferDescriptor(1024, 12));
  submit(connection, [
    encoded("command_encoder.copy_texture_to_buffer", {
      source: textureInfo(5),
      destination: bufferInfo(7, 0, 4),
      copy_size: { width: 4, height: 4, depth_or_array_layers: 1 },
    }),
  ]);
  return source;
}
function acquiredTexture(connection: GpuConnection, surfaces: GpuSurfaces, frame: boolean): object {
  if (!frame) {
    create(connection, "texture", 5, textureDescriptor(22, 17));
    return connection.replay.handles.native(h(5), "texture");
  }
  surfaces.attach([{ id: 1, canvas: new OffscreenCanvas(4, 4) }]);
  const target = surfaces.connection([1], connection.completions);
  Object.assign(connection.replay.target, { surfaces: target });
  call(connection, "instance.create_surface", {
    result: h(30),
    receiver: h(1),
    descriptor: { next_in_chain: [{ sType: 4096, value: { surface_id: 1 } }], label: "frame" },
  });
  call(connection, "surface.configure", {
    receiver: h(30),
    config: {
      next_in_chain: [],
      device: h(3),
      format: 22,
      usage: 19,
      width: 4,
      height: 4,
      view_formats: [],
      alpha_mode: 1,
      present_mode: 1,
    },
  });
  call(connection, "surface.get_current_texture", { result: h(5), receiver: h(30), token: 1 });
  return connection.replay.handles.native(h(5), "texture");
}
async function frameCopy(connection: GpuConnection, device: object, ring: RecordRing) {
  const surfaces = new GpuSurfaces();
  try {
    const frame = acquiredTexture(connection, surfaces, true);
    call(connection, "surface.get_current_texture", { result: h(6), receiver: h(30), token: 2 });
    if (connection.replay.handles.native(h(6), "texture") !== frame)
      throw new Error("Repeated acquire lost identity");
    if (replies(ring).join(",") !== "3,3") throw new Error("Missing acquired texture replies");
    create(connection, "buffer", 7, bufferDescriptor(1024, 12));
    const upload = new Uint8Array(1024);
    for (let row = 0; row < 4; row++) upload.set(new Uint8Array(16).fill(37 + row), row * 256);
    call(connection, "queue.write_buffer", {
      receiver: h(4),
      buffer: h(7),
      buffer_offset: 0,
      data: upload,
    });
    create(connection, "texture", 8, {
      ...textureDescriptor(22, 3),
      size: { width: 4, height: 4, depth_or_array_layers: 1 },
    });
    nativeCall(device, "pushErrorScope", ["validation"]);
    submit(connection, [
      encoded("command_encoder.copy_buffer_to_texture", {
        source: bufferInfo(7, 0, 4),
        destination: textureInfo(5),
        copy_size: { width: 4, height: 4, depth_or_array_layers: 1 },
      }),
      encoded("command_encoder.copy_texture_to_texture", {
        source: textureInfo(6),
        destination: textureInfo(8),
        copy_size: { width: 4, height: 4, depth_or_array_layers: 1 },
      }),
    ]);
    const errors = replies(ring);
    if (errors.length)
      throw new Error(`Valid acquired-frame copies emitted call exceptions: ${errors}`);
    const observed = await readback(
      device,
      connection.replay.handles.native(h(8), "texture"),
      1024,
      true,
    );
    assertBytes(observed, Array.from(upload), "acquired-frame-copy");
    if (await nativeCall(device, "popErrorScope", []))
      throw new Error("Valid frame copy caused native validation");
    release(connection, "texture", 5);
    if (surfaces.snapshot().frameTexturesLive !== 1)
      throw new Error("First alias release discarded the frame");
    release(connection, "texture", 6);
    if (surfaces.snapshot().frameTexturesLive !== 0)
      throw new Error("Last alias release retained the frame");
    call(connection, "surface.get_current_texture", { result: h(13), receiver: h(30), token: 3 });
    if (connection.replay.handles.native(h(13), "texture") === frame)
      throw new Error("Discarded frame was reacquired");
    replies(ring);
    return {
      status: "passed",
      realNativeIdentity: true,
      repeatedAcquireAliased: true,
      lastHandleDiscarded: true,
      sampledRows: [0, 256, 512, 768].map((at) => observed.slice(at, at + 16)),
    };
  } finally {
    surfaces.dispose(1);
  }
}
async function invalidCalls(
  connection: GpuConnection,
  device: object,
  ring: RecordRing,
  control: string,
) {
  nativeCall(device, "pushErrorScope", ["validation"]);
  if (control === "invalid-copy") {
    create(connection, "buffer", 5, bufferDescriptor(16, 12));
    create(connection, "buffer", 7, bufferDescriptor(16, 12));
    submit(connection, [
      encoded("command_encoder.copy_buffer_to_buffer", {
        source: h(5),
        source_offset: 1,
        destination: h(7),
        destination_offset: 0,
        size: 4,
      }),
    ]);
  } else {
    drawResources(connection, false);
    const descriptor = {
      ...renderDescriptor(10, null),
      depth_stencil_attachment: { ...depthStencil(h(12)), stencil_load_op: 2, stencil_store_op: 1 },
    };
    const rawLimit: unknown = Reflect.get(
      nativeObject(Reflect.get(device, "limits")),
      "maxImmediateSize",
    );
    const limit = typeof rawLimit === "number" ? rawLimit : 0;
    const command = control.startsWith("immediate-invalid-")
      ? encoded("render_pass_encoder.set_immediates", {
          offset: control.endsWith("offset") ? 1 : control.endsWith("range") ? limit : 0,
          data: control.endsWith("length") ? [1, 2, 3] : [1, 2, 3, 4],
        })
      : control === "webidl-viewport"
        ? encoded("render_pass_encoder.set_viewport", {
            x: NaN,
            y: 0,
            width: 2,
            height: 2,
            min_depth: 0,
            max_depth: 1,
          })
        : encoded("render_pass_encoder.set_scissor_rect", { x: 3, y: 0, width: 2, height: 2 });
    submit(connection, [
      encoded("command_encoder.begin_render_pass", { result: h(21), descriptor }),
      command,
      encoded("render_pass_encoder.end"),
    ]);
  }
  const result = await validationResult(
    device,
    ring,
    control === "webidl-viewport" || control === "immediate-invalid-length",
  );
  if (connection.state.kind !== "ready")
    throw new Error("Native validation terminated the protocol");
  return { status: "passed", ...result };
}
/** Trusted-host readback controls. These do not accept compiled guests or expose G2 mapping. */
export async function copyDrawNativeControl(control: string) {
  const gpu = nativeObject(Reflect.get(navigator, "gpu"));
  const adapter = nativeObject(
    await nativeCall(gpu, "requestAdapter", [{ forceFallbackAdapter: true }]),
  );
  if (Reflect.get(nativeObject(Reflect.get(adapter, "info")), "architecture") !== "swiftshader")
    throw new Error("Copy/draw requires designated SwiftShader");
  const adapterLimit: unknown = Reflect.get(
    nativeObject(Reflect.get(adapter, "limits")),
    "maxImmediateSize",
  );
  const wantsImmediates = control.includes("immediate");
  const descriptor =
    wantsImmediates && typeof adapterLimit === "number" && adapterLimit >= 16
      ? { requiredLimits: { maxImmediateSize: 16 } }
      : {};
  const device = nativeObject(await nativeCall(adapter, "requestDevice", [descriptor]));
  const { connection, credit, replies: ring } = nativeRig(gpu, device);
  try {
    const available = availability(gpu, device);
    const immediate = wantsImmediates;
    if (
      immediate &&
      (available.method !== "function" ||
        !available.maxImmediateSize ||
        available.maxImmediateSize < 16 ||
        !available.language)
    )
      return { control, availability: available, status: "unavailable", compiledGuest: false };
    call(connection, "device.get_queue", { result: h(4), receiver: h(3) });
    if (control === "frame-copy")
      return { control, compiledGuest: false, ...(await frameCopy(connection, device, ring)) };
    if (control.startsWith("destroy-"))
      return {
        control,
        compiledGuest: false,
        ...(await destroyed(connection, device, ring, control)),
      };
    if (
      control.startsWith("invalid-") ||
      control.startsWith("webidl-") ||
      control.startsWith("immediate-invalid-")
    )
      return {
        control,
        compiledGuest: false,
        ...(await invalidCalls(connection, device, ring, control)),
      };
    nativeCall(device, "pushErrorScope", ["validation"]);
    const result =
      control.includes("copy") ||
      control.startsWith("no-buffer") ||
      control.startsWith("no-texture") ||
      control === "no-clear"
        ? await copies(connection, device, control)
        : await draws(connection, device, control, immediate, ring);
    const error = await nativeCall(device, "popErrorScope", []);
    if (error)
      throw new Error(
        `Unexpected native validation for ${control}: ${Reflect.get(nativeObject(error), "message")}`,
      );
    if (replies(ring).length) throw new Error(`Unexpected copy/draw completion for ${control}`);
    connection.close();
    if (credit.used) throw new Error("Copy/draw retained service credit");
    return {
      control,
      kind: "native-lowering-control",
      compiledGuest: false,
      availability: available,
      ...result,
    };
  } finally {
    connection.close();
  }
}
