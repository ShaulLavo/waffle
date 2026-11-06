import { expect, test } from "bun:test";
import { GPU_TERMINAL } from "../browser/gpu/protocol.ts";
import { LogicalAppend } from "../browser/gpu/transport.ts";
import {
  blob,
  bundleDescriptor,
  call,
  create,
  encoded,
  h,
  release,
  renderDescriptor,
} from "./fixtures/gpu/bundle-query-fixture.ts";
import {
  drain,
  openDevice,
  RecordingTarget,
  rig,
  send,
  words,
} from "./fixtures/gpu/core-fixture.ts";

function recording() {
  const target = new RecordingTarget();
  const calls: { receiver: object; member: string; args: unknown[] }[] = [];
  const native = {
    encoder: {},
    bundle: {},
    query: {},
    pipeline: {},
    layout: {},
    buffer: {},
    group: {},
  };
  function capture(receiver: object, member: string, value?: unknown) {
    Reflect.set(receiver, member, function (this: object, ...args: unknown[]) {
      calls.push({ receiver: this, member, args });
      return value;
    });
  }
  capture(target.device, "createRenderBundleEncoder", native.encoder);
  capture(target.device, "createQuerySet", native.query);
  capture(native.encoder, "finish", native.bundle);
  capture(native.pipeline, "getBindGroupLayout", native.layout);
  for (const member of [
    "setPipeline",
    "setBindGroup",
    "setImmediates",
    "draw",
    "drawIndexed",
    "drawIndirect",
    "drawIndexedIndirect",
    "insertDebugMarker",
    "popDebugGroup",
    "pushDebugGroup",
    "setVertexBuffer",
    "setIndexBuffer",
  ])
    capture(native.encoder, member);
  capture(target.pass, "executeBundles");
  capture(target.pass, "beginOcclusionQuery");
  capture(target.pass, "endOcclusionQuery");
  capture(target.encoder, "resolveQuerySet");
  capture(native.query, "destroy");
  return { target, native, calls };
}
function bind(
  connection: ReturnType<typeof rig>["connection"],
  id: number,
  kind: Parameters<ReturnType<typeof rig>["connection"]["replay"]["handles"]["reserve"]>[1],
  value: object,
) {
  connection.replay.handles.reserve(h(id), kind);
  connection.replay.handles.bind(h(id), kind, { kind: "native", value });
}
function b(name: string, fields: unknown = {}) {
  return encoded(`render_bundle_encoder.${name}`, fields);
}
const finish = () =>
  b("finish", { result: h(10), descriptor: { next_in_chain: [], label: "finished" } });

function bundleCalls() {
  return [
    b("set_label", { label: "renamed" }),
    b("push_debug_group", { group_label: "group" }),
    b("insert_debug_marker", { marker_label: "λ" }),
    b("set_pipeline", { pipeline: h(5) }),
    b("set_bind_group", { group_index: 2, group: h(8), dynamic_offsets: [256, 512] }),
    b("set_vertex_buffer", { slot: 1, buffer: h(9), offset: 8, size: 0xffffffffffffffffn }),
    b("set_index_buffer", { buffer: h(9), format: 1, offset: 0, size: 12 }),
    b("set_immediates", { offset: 4, data: [1, 2, 3, 4] }),
    b("draw", { vertex_count: 3, instance_count: 2, first_vertex: 1, first_instance: 0 }),
    b("draw_indexed", {
      index_count: 3,
      instance_count: 2,
      first_index: 1,
      base_vertex: -2,
      first_instance: 0,
    }),
    b("draw_indirect", { indirect_buffer: h(9), indirect_offset: 4294967296 }),
    b("draw_indexed_indirect", { indirect_buffer: h(9), indirect_offset: 24 }),
    b("set_bind_group", { group_index: 2, group: null, dynamic_offsets: [] }),
    b("set_vertex_buffer", { slot: 1, buffer: null, offset: 0, size: 0xffffffffffffffffn }),
    b("pop_debug_group"),
    finish(),
  ];
}

test("all bundle commands retain exact receivers and finish ownership across bounded slices", async () => {
  const { target, native, calls } = recording();
  const { connection, credit, replies } = rig(target, 4096);
  try {
    await openDevice(connection);
    drain(replies);
    create(connection, "render_bundle_encoder", 6, bundleDescriptor());
    expect(calls[0]?.args).toEqual([
      {
        label: "bundle",
        colorFormats: ["rgba8unorm"],
        sampleCount: 1,
        depthReadOnly: false,
        stencilReadOnly: false,
      },
    ]);
    bind(connection, 5, "render_pipeline", native.pipeline);
    bind(connection, 8, "bind_group", native.group);
    bind(connection, 9, "buffer", native.buffer);
    const writer = new LogicalAppend(connection.commands, blob(0x1002, 6, bundleCalls()));
    expect(writer.advance()).toBe("done");
    for (let turn = 0; turn < 20; turn++)
      connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
    expect(connection.replay.busy).toBe(false);
    expect(Reflect.get(native.encoder, "label")).toBe("renamed");
    expect(connection.replay.handles.native(h(10), "render_bundle")).toBe(native.bundle);
    expect(
      calls
        .filter((entry) => entry.receiver === native.encoder)
        .map((entry) => [entry.member, entry.args]),
    ).toEqual([
      ["pushDebugGroup", ["group"]],
      ["insertDebugMarker", ["λ"]],
      ["setPipeline", [native.pipeline]],
      ["setBindGroup", [2, native.group, [256, 512]]],
      ["setVertexBuffer", [1, native.buffer, 8, undefined]],
      ["setIndexBuffer", [native.buffer, "uint16", 0, 12]],
      ["setImmediates", [4, new Uint8Array([1, 2, 3, 4])]],
      ["draw", [3, 2, 1, 0]],
      ["drawIndexed", [3, 2, 1, -2, 0]],
      ["drawIndirect", [native.buffer, 4294967296]],
      ["drawIndexedIndirect", [native.buffer, 24]],
      ["setBindGroup", [2, null, []]],
      ["setVertexBuffer", [1, null, 0, undefined]],
      ["popDebugGroup", []],
      ["finish", [{ label: "finished" }]],
    ]);
    release(connection, "render_bundle_encoder", 6);
    release(connection, "buffer", 9);
    release(connection, "bind_group", 8);
    release(connection, "render_pipeline", 5);
    expect(connection.replay.handles.native(h(10), "render_bundle")).toBe(native.bundle);
    expect(drain(replies)).toHaveLength(0);
  } finally {
    connection.close();
  }
  expect(credit.used).toBe(0);
});

test("query resources and implicit pipeline layouts are guest-owned identities", async () => {
  const { target, native, calls } = recording();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    bind(connection, 5, "render_pipeline", native.pipeline);
    bind(connection, 6, "compute_pipeline", native.pipeline);
    bind(connection, 9, "buffer", native.buffer);
    bind(connection, 17, "texture_view", target.view);
    for (const { id, receiver, pipeline } of [
      { id: 7, receiver: 5, pipeline: "render" },
      { id: 8, receiver: 6, pipeline: "compute" },
    ])
      call(connection, `${pipeline}_pipeline.get_bind_group_layout`, {
        result: h(id),
        receiver: h(receiver),
        group_index: 2,
      });
    expect(connection.replay.handles.native(h(7), "bind_group_layout")).toBe(native.layout);
    expect(connection.replay.handles.native(h(8), "bind_group_layout")).toBe(native.layout);
    create(connection, "query_set", 15, {
      next_in_chain: [],
      label: "visibility",
      type: 1,
      count: 2,
    });
    create(connection, "command_encoder", 20, null);
    send(
      connection,
      blob(0x1001, 20, [
        encoded("command_encoder.begin_render_pass", {
          result: h(21),
          descriptor: renderDescriptor(),
        }),
        encoded("render_pass_encoder.begin_occlusion_query", { query_index: 1 }),
        encoded("render_pass_encoder.execute_bundles", { bundles: [] }),
        encoded("render_pass_encoder.end_occlusion_query"),
        encoded("render_pass_encoder.end"),
        encoded("command_encoder.resolve_query_set", {
          query_set: h(15),
          first_query: 0,
          query_count: 2,
          destination: h(9),
          destination_offset: 4294967296,
        }),
        encoded("command_encoder.finish", { result: h(22), descriptor: null }),
      ]),
    );
    expect(calls.map((entry) => [entry.member, entry.args])).toEqual([
      ["getBindGroupLayout", [2]],
      ["getBindGroupLayout", [2]],
      ["createQuerySet", [{ label: "visibility", type: "occlusion", count: 2 }]],
      ["beginOcclusionQuery", [1]],
      ["executeBundles", [[]]],
      ["endOcclusionQuery", []],
      ["resolveQuerySet", [native.query, 0, 2, native.buffer, 4294967296]],
    ]);
    call(connection, "query_set.destroy", { receiver: h(15) });
    expect(calls.at(-1)).toEqual({ receiver: native.query, member: "destroy", args: [] });
    expect(connection.replay.handles.native(h(15), "query_set")).toBe(native.query);
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close();
  }
});

for (const records of [
  [encoded("compute_pass_encoder.end")],
  [encoded("render_pass_encoder.end")],
  [encoded("command_encoder.finish", { result: h(10), descriptor: null })],
  [blob(0x1002, 6, [])],
  [finish(), b("pop_debug_group")],
]) {
  test("wrong-kind or closed bundle commands fail only their connection", async () => {
    const { target } = recording();
    const { connection, credit } = rig(target);
    const other = rig(new RecordingTarget());
    try {
      await openDevice(connection);
      create(connection, "render_bundle_encoder", 6, bundleDescriptor());
      send(connection, blob(0x1002, 6, records));
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      expect(connection.replay.busy).toBe(false);
      expect(credit.used).toBe(0);
      expect(other.connection.state.kind).toBe("ready");
    } finally {
      connection.close();
      other.connection.close();
    }
  });
}

test("finished cursors reject later blobs, but released encoder generations can be reused", async () => {
  const { target } = recording();
  const { connection } = rig(target);
  try {
    await openDevice(connection);
    create(connection, "render_bundle_encoder", 6, bundleDescriptor());
    send(connection, blob(0x1002, 6, [finish()]));
    release(connection, "render_bundle_encoder", 6);
    call(connection, "device.create_render_bundle_encoder", {
      result: h(6, 2),
      receiver: h(3),
      descriptor: bundleDescriptor(),
    });
    send(connection, blob(0x1002, 6, [b("pop_debug_group")], 2));
    expect(connection.state.kind).toBe("ready");
    send(connection, blob(0x1002, 6, [b("finish", { result: h(11), descriptor: null })], 2));
    expect(connection.state.kind).toBe("ready");
    send(connection, blob(0x1002, 6, [], 2));
    expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
  } finally {
    connection.close();
  }
});

test("finish exceptions bind dependent results without replacing native validation objects", async () => {
  const { target, native } = recording();
  const { connection, replies } = rig(target);
  try {
    await openDevice(connection);
    drain(replies);
    create(connection, "render_bundle_encoder", 6, bundleDescriptor());
    Reflect.set(native.encoder, "finish", () => {
      throw new TypeError("WebIDL conversion");
    });
    send(connection, blob(0x1002, 6, [finish()]));
    expect(connection.replay.handles.get(h(10), "render_bundle").kind).toBe("exception");
    expect(drain(replies)).toHaveLength(1);
    expect(connection.state.kind).toBe("ready");
    send(connection, blob(0x1002, 6, []));
    expect(connection.state.kind).toBe("terminal");
  } finally {
    connection.close();
  }
});

test("close during a suspended bundle cancels the cursor without finishing or leaking credit", async () => {
  const { target, calls } = recording();
  const { connection, credit } = rig(target, 4096);
  await openDevice(connection);
  create(connection, "render_bundle_encoder", 6, bundleDescriptor());
  const writer = new LogicalAppend(
    connection.commands,
    blob(0x1002, 6, [b("pop_debug_group"), finish()]),
  );
  try {
    expect(writer.advance()).toBe("done");
    connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
    expect(connection.replay.busy).toBe(true);
  } finally {
    connection.close();
    writer.cancel();
  }
  connection.close();
  expect(credit.used).toBe(0);
  expect(calls.map((entry) => entry.member)).toEqual(["createRenderBundleEncoder"]);
});

test("malformed bundle spans, wrong encoder kind, and top-level inner calls close locally", async () => {
  for (const malformed of [
    words(0x1002, [6, 1, 0xffffffff]),
    blob(0x1002, 20, []),
    b("pop_debug_group"),
  ]) {
    const { target } = recording();
    const { connection, credit } = rig(target);
    try {
      await openDevice(connection);
      create(connection, "render_bundle_encoder", 6, bundleDescriptor());
      create(connection, "command_encoder", 20, null);
      send(connection, malformed);
      expect(connection.state.kind).toBe("terminal");
      expect(credit.used).toBe(0);
    } finally {
      connection.close();
    }
  }
});

test("a chunked bundle larger than its ring resumes one command per replay step", async () => {
  const { target, calls } = recording();
  const { connection, credit } = rig(target, 128);
  try {
    await openDevice(connection);
    create(connection, "render_bundle_encoder", 6, bundleDescriptor());
    const records = Array.from({ length: 200 }, () => b("pop_debug_group"));
    send(connection, blob(0x1002, 6, records.concat([finish()])));
    for (let turn = 0; turn < 210 && connection.replay.busy; turn++)
      connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
    expect(connection.replay.busy).toBe(false);
    expect(connection.replay.handles.get(h(10), "render_bundle").kind).toBe("native");
    expect(calls.filter((entry) => entry.member === "popDebugGroup")).toHaveLength(200);
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close();
  }
  expect(credit.used).toBe(0);
});

test("query calls cannot enter compute passes and a released bundle cannot be executed", async () => {
  for (const computePass of [true, false]) {
    const { target } = recording();
    const { connection, credit } = rig(target);
    const other = rig(new RecordingTarget());
    try {
      await openDevice(connection);
      create(connection, "render_bundle_encoder", 6, bundleDescriptor());
      send(connection, blob(0x1002, 6, [finish()]));
      release(connection, "render_bundle", 10);
      create(connection, "command_encoder", 20, null);
      bind(connection, 17, "texture_view", target.view);
      Reflect.set(target.encoder, "beginComputePass", () => ({}));
      send(
        connection,
        blob(0x1001, 20, [
          encoded(
            computePass
              ? "command_encoder.begin_compute_pass"
              : "command_encoder.begin_render_pass",
            { result: h(21), descriptor: computePass ? null : renderDescriptor(17, null) },
          ),
          computePass
            ? encoded("render_pass_encoder.begin_occlusion_query", { query_index: 0 })
            : encoded("render_pass_encoder.execute_bundles", { bundles: [h(10)] }),
        ]),
      );
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      expect(credit.used).toBe(0);
      expect(other.connection.state.kind).toBe("ready");
    } finally {
      connection.close();
      other.connection.close();
    }
  }
});
