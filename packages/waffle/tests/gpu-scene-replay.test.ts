import { expect, test } from "bun:test";
import { decodeCall } from "../browser/gpu/codec.ts";
import { DescriptorLowering } from "../browser/gpu/lowering.ts";
import { GpuProtocolError, GPU_TERMINAL } from "../browser/gpu/protocol.ts";
import type { GpuConnection } from "../browser/gpu/scheduler.ts";
import {
  command,
  drain,
  encodeBlob,
  handle,
  joinRecords,
  openDevice,
  RecordingTarget,
  rig,
  send,
  words,
} from "./fixtures/gpu/core-fixture.ts";
import {
  bufferDescriptor,
  depthState,
  depthStencil,
  layoutEntry,
  samplerDescriptor,
  textureDescriptor,
} from "./fixtures/gpu/scene-fixture.ts";

function sceneTarget() {
  const target = new RecordingTarget();
  const calls: { receiver: object; member: string; args: unknown[] }[] = [];
  const native = {
    buffer: {},
    texture: {},
    sampler: {},
    layout: {},
    pipelineLayout: {},
    group: {},
    view: {},
  };
  const capture = (receiver: object, member: string, value?: unknown) => {
    Reflect.set(receiver, member, function (this: object, ...args: unknown[]) {
      calls.push({ receiver: this, member, args });
      return value;
    });
  };
  capture(target.device, "createBuffer", native.buffer);
  capture(target.device, "createTexture", native.texture);
  capture(target.device, "createSampler", native.sampler);
  capture(target.device, "createBindGroupLayout", native.layout);
  capture(target.device, "createPipelineLayout", native.pipelineLayout);
  capture(target.device, "createBindGroup", native.group);
  capture(native.texture, "createView", native.view);
  capture(native.buffer, "destroy");
  capture(native.texture, "destroy");
  capture(target.queue, "writeBuffer");
  capture(target.queue, "writeTexture");
  for (const member of ["setBindGroup", "setVertexBuffer", "setIndexBuffer", "drawIndexed"])
    capture(target.pass, member);
  return { target, native, calls };
}
function create(connection: GpuConnection, name: string, id: number, descriptor: unknown) {
  send(
    connection,
    command(`device.create_${name}`, {
      result: handle(id),
      receiver: handle(3),
      descriptor,
    }),
  );
}
function last(calls: ReturnType<typeof sceneTarget>["calls"], member: string) {
  const found = calls.findLast((entry) => entry.member === member);
  if (!found) throw new Error(`Missing call ${member}`);
  return found;
}
function member(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") throw new Error("Missing native dictionary");
  return Reflect.get(value, name);
}

test("creation dictionaries preserve native object identities through explicit layouts and resource unions", async () => {
  const { target, native, calls } = sceneTarget();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    create(connection, "buffer", 4, bufferDescriptor());
    create(connection, "texture", 5, textureDescriptor());
    create(connection, "sampler", 6, samplerDescriptor());
    const entries = [layoutEntry(0), layoutEntry(1), layoutEntry(2), layoutEntry(3)];
    entries[0]!.buffer = {
      next_in_chain: [],
      type: 2,
      has_dynamic_offset: true,
      min_binding_size: 16,
    };
    entries[1]!.sampler.type = 1;
    entries[2]!.texture.sample_type = 2;
    entries[3]!.storage_texture = { next_in_chain: [], access: 2, format: 22, view_dimension: 2 };
    create(connection, "bind_group_layout", 7, { next_in_chain: [], label: "", entries });
    create(connection, "pipeline_layout", 8, {
      next_in_chain: [],
      label: "",
      bind_group_layouts: [handle(7)],
      immediate_size: 0,
    });
    send(
      connection,
      command("texture.create_view", { result: handle(10), receiver: handle(5), descriptor: null }),
    );
    const base = {
      next_in_chain: [],
      binding: 0,
      buffer: null,
      offset: 0xffffffffffffffffn,
      size: 0xffffffffffffffffn,
      sampler: null,
      texture_view: null,
    };
    create(connection, "bind_group", 9, {
      next_in_chain: [],
      label: "",
      layout: handle(7),
      entries: [
        { ...base, buffer: handle(4), offset: 8 },
        { ...base, binding: 1, sampler: handle(6) },
        { ...base, binding: 2, texture_view: handle(10) },
      ],
    });
    expect(connection.state.kind).toBe("ready");
    expect(last(calls, "createBuffer")).toEqual({
      receiver: target.device,
      member: "createBuffer",
      args: [{ label: "", usage: 40, size: 64, mappedAtCreation: false }],
    });
    expect(last(calls, "createTexture").args).toEqual([
      {
        label: "",
        usage: 6,
        dimension: "2d",
        size: { width: 2, height: 2, depthOrArrayLayers: 1 },
        format: "rgba8unorm",
        mipLevelCount: 1,
        sampleCount: 1,
        viewFormats: [],
      },
    ]);
    expect(last(calls, "createSampler").args).toEqual([
      { label: "", lodMinClamp: 0, lodMaxClamp: 32, maxAnisotropy: 1 },
    ]);
    expect(last(calls, "createBindGroupLayout").args).toEqual([
      {
        label: "",
        entries: [
          {
            binding: 0,
            visibility: 2,
            buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
          },
          { binding: 1, visibility: 2, sampler: {} },
          { binding: 2, visibility: 2, texture: { sampleType: "float", multisampled: false } },
          {
            binding: 3,
            visibility: 2,
            storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "2d" },
          },
        ],
      },
    ]);
    const pipelineLayout = last(calls, "createPipelineLayout").args[0];
    expect(pipelineLayout).toEqual({
      label: "",
      bindGroupLayouts: [native.layout],
      immediateSize: 0,
    });
    if (!pipelineLayout || typeof pipelineLayout !== "object")
      throw new Error("Missing layout dictionary");
    const layouts: unknown = Reflect.get(pipelineLayout, "bindGroupLayouts");
    if (!Array.isArray(layouts)) throw new Error("Missing layout array");
    expect(layouts[0]).toBe(native.layout);
    const group = last(calls, "createBindGroup").args[0];
    expect(group).toEqual({
      label: "",
      layout: native.layout,
      entries: [
        { binding: 0, resource: { buffer: native.buffer, offset: 8 } },
        { binding: 1, resource: native.sampler },
        { binding: 2, resource: native.view },
      ],
    });
    const groupEntries = member(group, "entries");
    if (!Array.isArray(groupEntries)) throw new Error("Missing binding entries");
    expect(member(group, "layout")).toBe(native.layout);
    expect(member(member(groupEntries[0], "resource"), "buffer")).toBe(native.buffer);
    expect(member(groupEntries[1], "resource")).toBe(native.sampler);
    expect(member(groupEntries[2], "resource")).toBe(native.view);
    expect(connection.replay.handles.native(handle(9), "bind_group")).toBe(native.group);
  } finally {
    connection.close(GPU_TERMINAL.closed);
  }
});

test("queue uploads pass byte spans, destination identity and declared copy sentinels exactly", async () => {
  const { target, native, calls } = sceneTarget();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    create(connection, "buffer", 4, bufferDescriptor());
    create(connection, "texture", 5, textureDescriptor());
    send(connection, command("device.get_queue", { result: handle(10), receiver: handle(3) }));
    send(
      connection,
      command("queue.write_buffer", {
        receiver: handle(10),
        buffer: handle(4),
        buffer_offset: 8,
        data: [1, 2, 3, 4],
      }),
    );
    send(
      connection,
      command("queue.write_texture", {
        receiver: handle(10),
        destination: { texture: handle(5), mip_level: 1, origin: { x: 2, y: 3, z: 4 }, aspect: 0 },
        data: [7, 8, 9],
        data_layout: { offset: 1, bytes_per_row: 0xffffffff, rows_per_image: 0xffffffff },
        write_size: { width: 1, height: 1, depth_or_array_layers: 1 },
      }),
    );
    expect(last(calls, "writeBuffer")).toEqual({
      receiver: target.queue,
      member: "writeBuffer",
      args: [native.buffer, 8, new Uint8Array([1, 2, 3, 4])],
    });
    const texture = last(calls, "writeTexture");
    expect(texture.receiver).toBe(target.queue);
    expect(texture.args).toEqual([
      { texture: native.texture, mipLevel: 1, origin: { x: 2, y: 3, z: 4 } },
      new Uint8Array([7, 8, 9]),
      { offset: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    ]);
    expect(last(calls, "writeBuffer").args[0]).toBe(native.buffer);
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close(GPU_TERMINAL.closed);
  }
});

test("nested indexed draw preserves signed values, dynamic offsets, explicit null and whole-size semantics", async () => {
  const { target, native, calls } = sceneTarget();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    create(connection, "bind_group_layout", 7, { next_in_chain: [], label: "", entries: [] });
    create(connection, "buffer", 4, bufferDescriptor());
    create(connection, "bind_group", 9, {
      next_in_chain: [],
      label: "",
      layout: handle(7),
      entries: [],
    });
    send(
      connection,
      command("device.create_command_encoder", {
        result: handle(11),
        receiver: handle(3),
        descriptor: null,
      }),
    );
    send(
      connection,
      encodeBlob(
        11,
        joinRecords(
          command("command_encoder.begin_render_pass", {
            result: handle(12),
            descriptor: {
              next_in_chain: [],
              label: "",
              color_attachments: [],
              depth_stencil_attachment: null,
              occlusion_query_set: null,
              timestamp_writes: null,
            },
          }),
          command("render_pass_encoder.set_bind_group", {
            group_index: 1,
            group: handle(9),
            dynamic_offsets: [256, 512],
          }),
          command("render_pass_encoder.set_vertex_buffer", {
            slot: 2,
            buffer: handle(4),
            offset: 8,
            size: 0xffffffffffffffffn,
          }),
          command("render_pass_encoder.set_index_buffer", {
            buffer: handle(4),
            format: 1,
            offset: 0,
            size: 0,
          }),
          command("render_pass_encoder.draw_indexed", {
            index_count: 6,
            instance_count: 2,
            first_index: 1,
            base_vertex: -3,
            first_instance: 4,
          }),
          command("render_pass_encoder.set_bind_group", {
            group_index: 1,
            group: null,
            dynamic_offsets: [],
          }),
          command("render_pass_encoder.set_vertex_buffer", {
            slot: 2,
            buffer: null,
            offset: 0,
            size: 0xffffffffffffffffn,
          }),
          command("render_pass_encoder.end", {}),
          command("command_encoder.finish", { result: handle(13), descriptor: null }),
        ),
      ),
    );
    const passCalls = calls.filter((entry) => entry.receiver === target.pass);
    expect(passCalls.map((entry) => entry.args)).toEqual([
      [1, native.group, [256, 512]],
      [2, native.buffer, 8, undefined],
      [native.buffer, "uint16", 0, 0],
      [6, 2, 1, -3, 4],
      [1, null, []],
      [2, null, 0, undefined],
    ]);
    expect(passCalls[0]?.args[1]).toBe(native.group);
    expect(passCalls[1]?.args[1]).toBe(native.buffer);
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close(GPU_TERMINAL.closed);
  }
});

test("depth/stencil dictionaries omit only their specified sentinels and retain real zeroes", () => {
  const { target } = sceneTarget();
  const { connection } = rig(target);
  try {
    const table = connection.replay.handles;
    table.reserve(handle(4), "texture_view");
    const view = {};
    table.bind(handle(4), "texture_view", { kind: "native", value: view });
    const lower = new DescriptorLowering(table);
    const depth = {
      ...depthStencil(handle(4)),
      depth_clear_value: NaN,
      depth_read_only: true,
      stencil_load_op: 1,
      stencil_store_op: 1,
    };
    expect(lower.dictionary("render_pass_depth_stencil_attachment", depth)).toEqual({
      view,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthReadOnly: true,
      stencilLoadOp: "load",
      stencilStoreOp: "store",
      stencilClearValue: 0,
      stencilReadOnly: false,
    });
    const state = { ...depthState(), depth_write_enabled: 2 };
    expect(lower.dictionary("depth_stencil_state", state)).toEqual({
      format: "depth24plus",
      depthCompare: "less",
      stencilFront: {},
      stencilBack: {},
      stencilReadMask: 0xffffffff,
      stencilWriteMask: 0xffffffff,
      depthBias: 0,
      depthBiasSlopeScale: 0,
      depthBiasClamp: 0,
    });
  } finally {
    connection.close(GPU_TERMINAL.closed);
  }
});

test("native invalid creations remain usable native identities, JS exceptions become distinct placeholders", async () => {
  const { target, native, calls } = sceneTarget();
  const { connection, replies } = rig(target, 4096);
  try {
    await openDevice(connection);
    drain(replies);
    create(connection, "buffer", 4, bufferDescriptor(0, 0));
    expect(connection.replay.handles.get(handle(4), "buffer")).toMatchObject({
      kind: "native",
      value: native.buffer,
      objectKind: "buffer",
      generation: 1,
    });
    expect(last(calls, "createBuffer").args).toEqual([
      { label: "", usage: 0, size: 0, mappedAtCreation: false },
    ]);
    Reflect.set(target.device, "createTexture", () => {
      throw new TypeError("native descriptor conversion");
    });
    create(connection, "texture", 5, textureDescriptor());
    expect(connection.replay.handles.get(handle(5), "texture").kind).toBe("exception");
    send(
      connection,
      command("texture.create_view", { result: handle(6), receiver: handle(5), descriptor: null }),
    );
    expect(connection.replay.handles.get(handle(6), "texture_view").kind).toBe("exception");
    expect(connection.state.kind).toBe("ready");
    const errors = drain(replies);
    expect(errors).toHaveLength(2);
    expect(errors.map((entry) => new DataView(entry.buffer).getUint16(0, true))).toEqual([8, 8]);
  } finally {
    connection.close(GPU_TERMINAL.closed);
  }
});

for (const size of [0, 3, 4, 257, 8192]) {
  test(`upload span length ${size} is bounded by bytes rather than decoded-value count`, async () => {
    const { target, calls } = sceneTarget();
    const { connection, credit } = rig(target, 256);
    try {
      await openDevice(connection);
      create(connection, "buffer", 4, bufferDescriptor());
      send(connection, command("device.get_queue", { result: handle(5), receiver: handle(3) }));
      const data = new Uint8Array(size).fill(17);
      send(
        connection,
        command("queue.write_buffer", {
          receiver: handle(5),
          buffer: handle(4),
          buffer_offset: 0,
          data,
        }),
      );
      expect(last(calls, "writeBuffer").args[2]).toEqual(data);
      expect(connection.state.kind).toBe("ready");
      expect(credit.used).toBe(256);
    } finally {
      connection.close(GPU_TERMINAL.closed);
    }
    expect(credit.used).toBe(0);
  });
}

for (const mutate of [
  (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(32, 0xffffffff, true),
  (bytes: Uint8Array) => new DataView(bytes.buffer).setBigUint64(24, 1n << 53n, true),
  (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(20, 2, true),
]) {
  test("malformed span, lossy u64 or stale buffer stops only its connection before native upload", async () => {
    const { target, calls } = sceneTarget();
    const { connection, credit } = rig(target, 256);
    try {
      await openDevice(connection);
      create(connection, "buffer", 4, bufferDescriptor());
      send(connection, command("device.get_queue", { result: handle(5), receiver: handle(3) }));
      const bytes = command("queue.write_buffer", {
        receiver: handle(5),
        buffer: handle(4),
        buffer_offset: 0,
        data: [1, 2, 3, 4],
      });
      mutate(bytes);
      send(connection, bytes);
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      expect(calls.some((entry) => entry.member === "writeBuffer")).toBe(false);
      expect(credit.used).toBe(0);
    } finally {
      connection.close(GPU_TERMINAL.closed);
    }
  });
}

test("large dynamic-offset count and nonzero sampler padding fail locally", () => {
  const bytes = command("render_pass_encoder.set_bind_group", {
    group_index: 0,
    group: null,
    dynamic_offsets: [],
  });
  new DataView(bytes.buffer).setUint32(20, 0xffffffff, true);
  expect(() => decodeCall(bytes)).toThrow("array limit");
  const sampler = command("device.create_sampler", {
    result: handle(6),
    receiver: handle(3),
    descriptor: samplerDescriptor(),
  });
  sampler[74] = 1;
  expect(() => decodeCall(sampler)).toThrow(GpuProtocolError);
});

test("ordinary buffer release drops the handle without destroying dependent native resources", async () => {
  const { target, native, calls } = sceneTarget();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    create(connection, "buffer", 4, bufferDescriptor());
    send(connection, words(0x1000, [14, 4, 1]));
    expect(
      calls.filter((entry) => entry.receiver === native.buffer && entry.member === "destroy"),
    ).toHaveLength(0);
  } finally {
    connection.close(GPU_TERMINAL.closed);
  }
  expect(
    calls.filter((entry) => entry.receiver === native.buffer && entry.member === "destroy"),
  ).toHaveLength(0);
  expect(
    target.calls.filter((entry) => entry.receiver === "device" && entry.member === "destroy"),
  ).toHaveLength(1);
});

test("unsupported binding arrays and impossible C resource unions are call errors, not protocol faults", async () => {
  const { target, native, calls } = sceneTarget();
  const { connection, replies } = rig(target, 4096);
  try {
    await openDevice(connection);
    drain(replies);
    const entry = layoutEntry();
    entry.texture.sample_type = 2;
    entry.sampler.type = 2;
    create(connection, "bind_group_layout", 7, { next_in_chain: [], label: "", entries: [entry] });
    // Both arms reach native validation. They must not be guessed into one arm.
    expect(last(calls, "createBindGroupLayout").args).toEqual([
      {
        label: "",
        entries: [
          {
            binding: 0,
            visibility: 2,
            sampler: { type: "filtering" },
            texture: { sampleType: "float", multisampled: false },
          },
        ],
      },
    ]);
    create(connection, "bind_group_layout", 8, {
      next_in_chain: [],
      label: "",
      entries: [{ ...entry, binding_array_size: 2 }],
    });
    expect(connection.replay.handles.get(handle(8), "bind_group_layout").kind).toBe("exception");
    create(connection, "buffer", 4, bufferDescriptor());
    create(connection, "sampler", 5, null);
    const resource = {
      next_in_chain: [],
      binding: 0,
      buffer: handle(4),
      offset: 0,
      size: 0,
      sampler: handle(5),
      texture_view: null,
    };
    create(connection, "bind_group", 9, {
      next_in_chain: [],
      label: "",
      layout: handle(7),
      entries: [resource],
    });
    expect(connection.replay.handles.get(handle(9), "bind_group").kind).toBe("exception");
    create(connection, "bind_group", 10, {
      next_in_chain: [],
      label: "",
      layout: handle(7),
      entries: [{ ...resource, sampler: null }],
    });
    expect(last(calls, "createBindGroup").args).toEqual([
      {
        label: "",
        layout: native.layout,
        entries: [{ binding: 0, resource: { buffer: native.buffer, offset: 0, size: 0 } }],
      },
    ]);
    expect(connection.state.kind).toBe("ready");
    expect(drain(replies)).toHaveLength(2);
  } finally {
    connection.close();
  }
});

test("explicit pipeline layout and depth attachments reach native calls by identity", async () => {
  const { target, native } = sceneTarget();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    create(connection, "bind_group_layout", 7, { next_in_chain: [], label: "", entries: [] });
    create(connection, "pipeline_layout", 8, {
      next_in_chain: [],
      label: "",
      bind_group_layouts: [handle(7)],
      immediate_size: 0,
    });
    create(connection, "texture", 5, textureDescriptor(46, 16));
    send(
      connection,
      command("texture.create_view", { result: handle(6), receiver: handle(5), descriptor: null }),
    );
    send(
      connection,
      command("device.create_shader_module", {
        result: handle(10),
        receiver: handle(3),
        descriptor: { next_in_chain: [{ sType: 2, value: { code: "" } }], label: "" },
      }),
    );
    const baseline = (await import("./fixtures/gpu/expected.json")).default.vectors.find(
      (entry) => entry.command === "device.create_render_pipeline",
    )?.input.descriptor;
    if (!baseline?.vertex) throw new Error("Missing baseline pipeline");
    create(connection, "render_pipeline", 11, {
      ...baseline,
      layout: handle(8),
      vertex: { ...baseline.vertex, module: handle(10) },
      fragment: null,
      depth_stencil: depthState(),
    });
    const pipeline = target.calls.find((entry) => entry.member === "createRenderPipeline")?.args[0];
    expect(pipeline).toMatchObject({
      layout: native.pipelineLayout,
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
        depthBias: 0,
      },
    });
    if (!pipeline || typeof pipeline !== "object") throw new Error("Missing pipeline dictionary");
    expect(Reflect.get(pipeline, "layout")).toBe(native.pipelineLayout);
    send(
      connection,
      command("device.create_command_encoder", {
        result: handle(12),
        receiver: handle(3),
        descriptor: null,
      }),
    );
    send(
      connection,
      encodeBlob(
        12,
        joinRecords(
          command("command_encoder.begin_render_pass", {
            result: handle(13),
            descriptor: {
              next_in_chain: [],
              label: "",
              color_attachments: [],
              depth_stencil_attachment: depthStencil(handle(6)),
              occlusion_query_set: null,
              timestamp_writes: null,
            },
          }),
          command("render_pass_encoder.end", {}),
          command("command_encoder.finish", { result: handle(14), descriptor: null }),
        ),
      ),
    );
    const pass = target.calls.find((entry) => entry.member === "beginRenderPass")?.args[0];
    expect(pass).toEqual({
      label: "",
      colorAttachments: [],
      depthStencilAttachment: {
        view: native.view,
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1,
        depthReadOnly: false,
        stencilClearValue: 0,
        stencilReadOnly: false,
      },
    });
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close();
  }
});
