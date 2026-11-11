import { nativeCall, nativeObject, destroyNative } from "../../../browser/gpu/lowering.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import type { GpuConnection } from "../../../browser/gpu/scheduler.js";
import {
  blob,
  nativeRig,
  bundleDescriptor,
  call,
  create,
  encoded,
  h,
  publish,
  release,
  renderDescriptor,
} from "./bundle-query-fixture.js";
import { bufferDescriptor, textureDescriptor } from "./scene-fixture.js";
import expected from "./expected.json";

function words(values: number[]) {
  return new Uint8Array(new Uint32Array(values).buffer);
}
const shader = `
@group(0) @binding(0) var<uniform> color: vec4f;
@vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0, 1); }
@fragment fn fs() -> @location(0) vec4f { return color; }`;

function resources(connection: GpuConnection, immediate: boolean) {
  call(connection, "device.get_queue", { result: h(4), receiver: h(3) });
  create(connection, "buffer", 5, bufferDescriptor(24, 40));
  create(connection, "buffer", 6, bufferDescriptor(8, 24));
  create(connection, "buffer", 7, bufferDescriptor(40, 264));
  create(connection, "buffer", 8, bufferDescriptor(16, 72));
  call(connection, "device.create_shader_module", {
    result: h(9),
    receiver: h(3),
    descriptor: {
      next_in_chain: [
        {
          sType: 2,
          value: {
            code: immediate
              ? "requires immediate_address_space; var<immediate> settings: vec4f;\n" +
                shader.replace("return color;", "return color * settings;")
              : shader,
          },
        },
      ],
      label: "bundle color",
    },
  });
  const pipeline = expected.vectors.find(
    (entry) => entry.command === "device.create_render_pipeline",
  )?.input.descriptor;
  if (!pipeline) throw new Error("Baseline pipeline descriptor missing");
  create(connection, "render_pipeline", 10, {
    ...pipeline,
    layout: null,
    vertex: {
      next_in_chain: [],
      module: h(9),
      entry_point: "vs",
      constants: [],
      buffers: [
        {
          next_in_chain: [],
          step_mode: 1,
          array_stride: 8,
          attributes: [{ next_in_chain: [], format: 29, offset: 0, shader_location: 0 }],
        },
      ],
    },
    fragment: {
      next_in_chain: [],
      module: h(9),
      entry_point: "fs",
      constants: [],
      targets: [{ next_in_chain: [], format: 22, blend: null, write_mask: 15 }],
    },
  });
  call(connection, "render_pipeline.get_bind_group_layout", {
    result: h(11),
    receiver: h(10),
    group_index: 0,
  });
  create(connection, "bind_group", 12, {
    next_in_chain: [],
    label: "red",
    layout: h(11),
    entries: [
      {
        next_in_chain: [],
        binding: 0,
        buffer: h(8),
        offset: 0,
        size: 16,
        sampler: null,
        texture_view: null,
      },
    ],
  });
  const vertex = new Uint8Array(new Float32Array([-1, -1, 3, -1, -1, 3]).buffer);
  const index = new Uint8Array(new Uint16Array([0, 1, 2, 0]).buffer);
  const color = new Uint8Array(new Float32Array([1, 0, 0, 1]).buffer);
  for (const { buffer, data } of [
    { buffer: 5, data: vertex },
    { buffer: 6, data: index },
    { buffer: 7, data: words([3, 1, 0, 0]) },
    { buffer: 8, data: color },
  ])
    call(connection, "queue.write_buffer", {
      receiver: h(4),
      buffer: h(buffer),
      buffer_offset: 0,
      data,
    });
  // Indexed indirect has a fifth u32 field and uses its own 20-byte initialized span.
  call(connection, "queue.write_buffer", {
    receiver: h(4),
    buffer: h(7),
    buffer_offset: 16,
    data: words([3, 1, 0, 0, 0]),
  });
  create(connection, "texture", 16, textureDescriptor(22, 17));
  call(connection, "texture.create_view", { result: h(17), receiver: h(16), descriptor: null });
  create(connection, "query_set", 15, { next_in_chain: [], label: "occlusion", type: 1, count: 2 });
  create(connection, "buffer", 18, bufferDescriptor(16, 516));
}
function drawCall(control: string): Uint8Array {
  if (control === "indexed")
    return encoded("render_bundle_encoder.draw_indexed", {
      index_count: 3,
      instance_count: 1,
      first_index: 0,
      base_vertex: 0,
      first_instance: 0,
    });
  if (control === "indirect")
    return encoded("render_bundle_encoder.draw_indirect", {
      indirect_buffer: h(7),
      indirect_offset: 0,
    });
  if (control === "indexed-indirect")
    return encoded("render_bundle_encoder.draw_indexed_indirect", {
      indirect_buffer: h(7),
      indirect_offset: 16,
    });
  return encoded("render_bundle_encoder.draw", {
    vertex_count: 3,
    instance_count: 1,
    first_vertex: 0,
    first_instance: 0,
  });
}
function bundle(connection: GpuConnection, control: string) {
  create(connection, "render_bundle_encoder", 13, bundleDescriptor());
  publish(
    connection,
    blob(
      0x1002,
      13,
      [
        encoded("render_bundle_encoder.set_label", { label: "reused" }),
        encoded("render_bundle_encoder.push_debug_group", { group_label: "bundle" }),
        encoded("render_bundle_encoder.insert_debug_marker", { marker_label: "draw" }),
        encoded("render_bundle_encoder.set_pipeline", { pipeline: h(10) }),
        encoded("render_bundle_encoder.set_bind_group", {
          group_index: 0,
          group: h(12),
          dynamic_offsets: [],
        }),
        encoded("render_bundle_encoder.set_vertex_buffer", {
          slot: 0,
          buffer: h(5),
          offset: 0,
          size: 0xffffffffffffffffn,
        }),
        encoded("render_bundle_encoder.set_index_buffer", {
          buffer: h(6),
          format: 1,
          offset: 0,
          size: 0xffffffffffffffffn,
        }),
      ].concat(
        control === "immediate" || control === "zero-immediates"
          ? [
              encoded("render_bundle_encoder.set_immediates", {
                offset: 0,
                data: new Uint8Array(
                  new Float32Array(control === "zero-immediates" ? [0, 0, 0, 0] : [1, 1, 1, 1])
                    .buffer,
                ),
              }),
            ]
          : [],
        [
          drawCall(control),
          encoded("render_bundle_encoder.pop_debug_group"),
          encoded("render_bundle_encoder.finish", {
            result: h(14),
            descriptor: { next_in_chain: [], label: "draw red" },
          }),
        ],
      ),
    ),
  );
  for (const id of [5, 6, 7, 8]) release(connection, "buffer", id);
  release(connection, "render_pipeline", 10);
  release(connection, "bind_group", 12);
  release(connection, "bind_group_layout", 11);
  release(connection, "render_bundle_encoder", 13);
}
function render(connection: GpuConnection, control: string) {
  create(connection, "command_encoder", 20, null);
  const records: Uint8Array[] = [];
  for (let index = 0; index < 2; index++) {
    records.push(
      encoded("command_encoder.begin_render_pass", {
        result: h(21 + index),
        descriptor: renderDescriptor(),
      }),
    );
    if (control !== "no-query")
      records.push(encoded("render_pass_encoder.begin_occlusion_query", { query_index: index }));
    records.push(
      encoded("render_pass_encoder.execute_bundles", {
        bundles: control === "no-execute" ? [] : [h(14)],
      }),
    );
    if (control !== "no-query") records.push(encoded("render_pass_encoder.end_occlusion_query"));
    records.push(encoded("render_pass_encoder.end"));
  }
  if (control !== "no-resolve")
    records.push(
      encoded("command_encoder.resolve_query_set", {
        query_set: h(15),
        first_query: 0,
        query_count: 2,
        destination: h(18),
        destination_offset: 0,
      }),
    );
  records.push(encoded("command_encoder.finish", { result: h(23), descriptor: null }));
  publish(connection, blob(0x1001, 20, records));
  release(connection, "render_bundle", 14);
  release(connection, "query_set", 15);
  call(connection, "queue.submit", { receiver: h(4), commands: [h(23)] });
}
async function observe(device: object, source: object, texture: object) {
  const readback = nativeObject(nativeCall(device, "createBuffer", [{ size: 1024, usage: 9 }]));
  try {
    const encoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
    nativeCall(encoder, "copyBufferToBuffer", [source, 0, readback, 0, 16]);
    nativeCall(encoder, "copyTextureToBuffer", [
      { texture },
      { buffer: readback, offset: 256, bytesPerRow: 256 },
      { width: 2, height: 2, depthOrArrayLayers: 1 },
    ]);
    nativeCall(nativeObject(Reflect.get(device, "queue")), "submit", [
      [nativeCall(encoder, "finish", [])],
    ]);
    await nativeCall(readback, "mapAsync", [1]);
    const range: unknown = nativeCall(readback, "getMappedRange", []);
    if (!(range instanceof ArrayBuffer)) throw new Error("Trusted-host query readback missing");
    return {
      queries: Array.from(new BigUint64Array(range, 0, 2), String),
      pixel: Array.from(new Uint8Array(range, 256, 4)),
    };
  } finally {
    destroyNative(readback);
  }
}
function noReplies(replies: RecordRing) {
  if (replies.readInto(new Uint8Array(replies.capacity)).kind !== "empty")
    throw new Error("Unexpected native bundle/query completion");
}
async function validationControls(connection: GpuConnection, device: object, replies: RecordRing) {
  nativeCall(device, "pushErrorScope", ["validation"]);
  create(connection, "query_set", 30, {
    next_in_chain: [],
    label: "invalid count",
    type: 1,
    count: 8193,
  });
  const invalidQuery = connection.replay.handles.get(h(30), "query_set").kind === "native";
  const queryError = await nativeCall(device, "popErrorScope", []);
  noReplies(replies);
  if (!invalidQuery || !isValidation(queryError))
    throw new Error("Native invalid query was replaced with a JS exception");
  nativeCall(device, "pushErrorScope", ["validation"]);
  create(connection, "render_bundle_encoder", 31, { ...bundleDescriptor(), sample_count: 3 });
  publish(
    connection,
    blob(0x1002, 31, [
      encoded("render_bundle_encoder.finish", { result: h(32), descriptor: null }),
    ]),
  );
  const invalidBundle = connection.replay.handles.get(h(32), "render_bundle").kind === "native";
  const bundleError = await nativeCall(device, "popErrorScope", []);
  noReplies(replies);
  if (!invalidBundle || !isValidation(bundleError))
    throw new Error("Invalid encoder did not finish to an owned native invalid bundle");
  create(connection, "query_set", 33, { next_in_chain: [], label: "destroy", type: 1, count: 1 });
  call(connection, "query_set.destroy", { receiver: h(33) });
  nativeCall(device, "pushErrorScope", ["validation"]);
  create(connection, "command_encoder", 34, null);
  publish(
    connection,
    blob(0x1001, 34, [
      encoded("command_encoder.resolve_query_set", {
        query_set: h(33),
        first_query: 0,
        query_count: 1,
        destination: h(18),
        destination_offset: 0,
      }),
      encoded("command_encoder.finish", { result: h(35), descriptor: null }),
    ]),
  );
  call(connection, "queue.submit", { receiver: h(4), commands: [h(35)] });
  const destroyedError = await nativeCall(device, "popErrorScope", []);
  noReplies(replies);
  if (!isValidation(destroyedError))
    throw new Error("Destroyed query did not reach native submission validation");
  return {
    invalidQueryNative: invalidQuery,
    invalidBundleNative: invalidBundle,
    queryDestroy: true,
    destroyedQuerySubmissionValidation: true,
  };
}
/** Native wire replay only. Mapping is an explicit trusted-host observation, not guest G2 support. */
export async function bundleQueryNativeControl(control: string) {
  const gpu = nativeObject(Reflect.get(navigator, "gpu"));
  const adapter = nativeObject(
    await nativeCall(gpu, "requestAdapter", [{ forceFallbackAdapter: true }]),
  );
  if (Reflect.get(nativeObject(Reflect.get(adapter, "info")), "architecture") !== "swiftshader")
    throw new Error("Bundle/query controls require SwiftShader");
  const timestamp = control === "timestamp" || control === "no-timestamp";
  const hasTimestamp =
    nativeCall(nativeObject(Reflect.get(adapter, "features")), "has", ["timestamp-query"]) === true;
  if (timestamp && !hasTimestamp)
    return {
      kind: "native-lowering-control",
      compiledGuest: false,
      control,
      status: "unavailable",
      reason: "timestamp-query feature absent",
    };
  const device = nativeObject(
    await nativeCall(adapter, "requestDevice", [
      { requiredFeatures: timestamp ? ["timestamp-query"] : [] },
    ]),
  );
  const { connection, credit, replies } = nativeRig(gpu, device);
  try {
    if (timestamp) return await timestampControl(connection, device, replies, control);
    const availability = immediateAvailability(gpu, device);
    const immediate = ["immediate", "zero-immediates", "no-immediates"].includes(control);
    if (immediate && !availability.supported)
      return {
        kind: "native-lowering-control",
        compiledGuest: false,
        control,
        status: "unavailable",
        availability,
      };
    nativeCall(device, "pushErrorScope", ["validation"]);
    resources(connection, immediate);
    bundle(connection, control);
    const source = connection.replay.handles.native(h(18), "buffer");
    const texture = connection.replay.handles.native(h(16), "texture");
    render(connection, control);
    const observation = await observe(device, source, texture);
    const error = await nativeCall(device, "popErrorScope", []);
    if (control === "no-immediates") {
      const message = error && typeof error === "object" ? Reflect.get(error, "message") : "";
      if (
        !isValidation(error) ||
        typeof message !== "string" ||
        !message.includes("immediate data")
      )
        throw new Error("Missing immediate data did not fail native validation");
      noReplies(replies);
      return {
        kind: "native-lowering-control",
        compiledGuest: false,
        guestMapping: false,
        control,
        status: "passed-negative-control",
        nativeValidation: true,
        message,
      };
    }
    if (error)
      throw new Error(
        `Bundle/query native validation: ${Reflect.get(nativeObject(error), "message")}`,
      );
    noReplies(replies);
    const expectedPixel =
      control === "no-execute"
        ? "0,0,255,255"
        : control === "zero-immediates"
          ? "0,0,0,0"
          : "255,0,0,255";
    if (observation.pixel.join(",") !== expectedPixel)
      throw new Error(`Bundle pixel control ${control}: ${observation.pixel}`);
    const visible = !["no-execute", "no-query", "no-resolve"].includes(control);
    if (observation.queries.some((value) => BigInt(value) > 0n !== visible))
      throw new Error(`Query control ${control}: ${observation.queries}`);
    const validation =
      control === "direct" ? await validationControls(connection, device, replies) : null;
    const compute =
      control === "direct" ? await computeLayoutControl(connection, device, replies) : null;
    const immediateErrors = immediate
      ? await immediateValidation(connection, device, replies, availability.maxImmediateSize)
      : null;
    connection.close();
    if (credit.used) throw new Error("Native bundle/query control retained credit");
    return {
      kind: "native-lowering-control",
      compiledGuest: false,
      guestMapping: false,
      control,
      status: "passed",
      reusedPasses: 2,
      ...observation,
      validation,
      optional: { availability, timestampQuery: "not-requested" },
      compute,
      immediateErrors,
    };
  } finally {
    connection.close();
    destroyNative(device);
  }
}

async function readBuffer(device: object, source: object, size: number): Promise<ArrayBuffer> {
  const readback = nativeObject(nativeCall(device, "createBuffer", [{ size, usage: 9 }]));
  try {
    const encoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
    nativeCall(encoder, "copyBufferToBuffer", [source, 0, readback, 0, size]);
    nativeCall(nativeObject(Reflect.get(device, "queue")), "submit", [
      [nativeCall(encoder, "finish", [])],
    ]);
    await nativeCall(readback, "mapAsync", [1]);
    const range: unknown = nativeCall(readback, "getMappedRange", []);
    if (!(range instanceof ArrayBuffer))
      throw new Error("Native trusted-host observation returned no range");
    return range.slice(0);
  } finally {
    destroyNative(readback);
  }
}
async function computeLayoutControl(
  connection: GpuConnection,
  device: object,
  replies: RecordRing,
) {
  nativeCall(device, "pushErrorScope", ["validation"]);
  create(connection, "buffer", 40, bufferDescriptor(4, 132));
  call(connection, "device.create_shader_module", {
    result: h(41),
    receiver: h(3),
    descriptor: {
      next_in_chain: [
        {
          sType: 2,
          value: {
            code: "@group(0) @binding(0) var<storage, read_write> output: u32; @compute @workgroup_size(1) fn main() { output = 42u; }",
          },
        },
      ],
      label: "auto compute",
    },
  });
  create(connection, "compute_pipeline", 42, {
    next_in_chain: [],
    label: "auto",
    layout: null,
    compute: { next_in_chain: [], module: h(41), entry_point: "main", constants: [] },
  });
  call(connection, "compute_pipeline.get_bind_group_layout", {
    result: h(43),
    receiver: h(42),
    group_index: 0,
  });
  create(connection, "bind_group", 44, {
    next_in_chain: [],
    label: "output",
    layout: h(43),
    entries: [
      {
        next_in_chain: [],
        binding: 0,
        buffer: h(40),
        offset: 0,
        size: 4,
        sampler: null,
        texture_view: null,
      },
    ],
  });
  create(connection, "command_encoder", 45, null);
  publish(
    connection,
    blob(0x1001, 45, [
      encoded("command_encoder.begin_compute_pass", { result: h(46), descriptor: null }),
      encoded("compute_pass_encoder.set_pipeline", { pipeline: h(42) }),
      encoded("compute_pass_encoder.set_bind_group", {
        group_index: 0,
        group: h(44),
        dynamic_offsets: [],
      }),
      encoded("compute_pass_encoder.dispatch_workgroups", {
        workgroupCountX: 1,
        workgroupCountY: 1,
        workgroupCountZ: 1,
      }),
      encoded("compute_pass_encoder.end"),
      encoded("command_encoder.finish", { result: h(47), descriptor: null }),
    ]),
  );
  const source = connection.replay.handles.native(h(40), "buffer");
  release(connection, "buffer", 40);
  release(connection, "compute_pipeline", 42);
  release(connection, "bind_group_layout", 43);
  release(connection, "bind_group", 44);
  call(connection, "queue.submit", { receiver: h(4), commands: [h(47)] });
  const observed = new Uint32Array(await readBuffer(device, source, 4))[0];
  const error = await nativeCall(device, "popErrorScope", []);
  noReplies(replies);
  if (observed !== 42 || error)
    throw new Error("Guest-selected automatic compute layout did not bind shader output");
  return { wireLayoutResult: true, observed, compiledGuest: false, trustedHostReadback: true };
}
function immediateAvailability(gpu: object, device: object) {
  const encoder = nativeObject(
    nativeCall(device, "createRenderBundleEncoder", [{ colorFormats: ["rgba8unorm"] }]),
  );
  const method = typeof Reflect.get(encoder, "setImmediates") === "function";
  const limit: unknown = Reflect.get(
    nativeObject(Reflect.get(device, "limits")),
    "maxImmediateSize",
  );
  const languageFeature =
    nativeCall(nativeObject(Reflect.get(gpu, "wgslLanguageFeatures")), "has", [
      "immediate_address_space",
    ]) === true;
  nativeCall(encoder, "finish", []);
  const maxImmediateSize = typeof limit === "number" ? limit : 0;
  return {
    method,
    maxImmediateSize,
    languageFeature,
    supported: method && maxImmediateSize >= 16 && languageFeature,
  };
}
async function immediateValidation(
  connection: GpuConnection,
  device: object,
  replies: RecordRing,
  limit: number,
) {
  const results: { name: string; exception: boolean; validation: boolean }[] = [];
  const cases = [
    { name: "byte-length", offset: 0, data: new Uint8Array(3) },
    { name: "offset-alignment", offset: 1, data: new Uint8Array(4) },
    { name: "range", offset: limit, data: new Uint8Array(4) },
  ];
  for (const [index, item] of cases.entries()) {
    const id = 50 + index * 2;
    nativeCall(device, "pushErrorScope", ["validation"]);
    create(connection, "render_bundle_encoder", id, bundleDescriptor());
    publish(
      connection,
      blob(0x1002, id, [
        encoded("render_bundle_encoder.set_immediates", { offset: item.offset, data: item.data }),
        encoded("render_bundle_encoder.finish", { result: h(id + 1), descriptor: null }),
      ]),
    );
    const error = await nativeCall(device, "popErrorScope", []);
    const failure = immediateFailure(replies, error, item.name === "byte-length");
    results.push({ name: item.name, ...failure });
  }
  return results;
}
async function timestampControl(
  connection: GpuConnection,
  device: object,
  replies: RecordRing,
  control: string,
) {
  nativeCall(device, "pushErrorScope", ["validation"]);
  call(connection, "device.get_queue", { result: h(4), receiver: h(3) });
  create(connection, "query_set", 40, {
    next_in_chain: [],
    label: "timestamps",
    type: 2,
    count: 2,
  });
  create(connection, "buffer", 41, bufferDescriptor(16, 516));
  create(connection, "command_encoder", 42, null);
  publish(
    connection,
    blob(0x1001, 42, [
      encoded("command_encoder.begin_compute_pass", {
        result: h(43),
        descriptor: {
          next_in_chain: [],
          label: "timestamp",
          timestamp_writes:
            control === "no-timestamp"
              ? null
              : {
                  next_in_chain: [],
                  query_set: h(40),
                  beginning_of_pass_write_index: 0,
                  end_of_pass_write_index: 1,
                },
        },
      }),
      encoded("compute_pass_encoder.end"),
      encoded("command_encoder.resolve_query_set", {
        query_set: h(40),
        first_query: 0,
        query_count: 2,
        destination: h(41),
        destination_offset: 0,
      }),
      encoded("command_encoder.finish", { result: h(44), descriptor: null }),
    ]),
  );
  release(connection, "query_set", 40);
  call(connection, "queue.submit", { receiver: h(4), commands: [h(44)] });
  const values = new BigUint64Array(
    await readBuffer(device, connection.replay.handles.native(h(41), "buffer"), 16),
  );
  const error = await nativeCall(device, "popErrorScope", []);
  noReplies(replies);
  if (
    error ||
    Array.from(values).some((value) => value > 0n !== (control === "timestamp")) ||
    values[1]! < values[0]!
  )
    throw new Error(`Native timestamp control failed: ${values}`);
  return {
    kind: "native-lowering-control",
    compiledGuest: false,
    guestMapping: false,
    trustedHostReadback: true,
    control,
    status: "passed",
    values: Array.from(values, String),
  };
}

function isValidation(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && error.constructor.name === "GPUValidationError"
  );
}

function immediateFailure(replies: RecordRing, error: unknown, throws: boolean) {
  const bytes = new Uint8Array(replies.capacity);
  const reply = replies.readInto(bytes);
  const exception = reply.kind === "record" && new DataView(bytes.buffer).getUint16(0, true) === 8;
  const validation = isValidation(error);
  noReplies(replies);
  if (exception !== throws || validation === throws)
    throw new Error("Wrong native bundle immediate failure class");
  return { exception, validation };
}
