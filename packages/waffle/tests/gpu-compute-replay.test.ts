import { expect, test } from "bun:test";
import { decodeCall } from "../browser/gpu/codec.ts";
import { DescriptorLowering } from "../browser/gpu/lowering.ts";
import { GPU_TERMINAL } from "../browser/gpu/protocol.ts";
import { LogicalAppend } from "../browser/gpu/transport.ts";
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

function computeTarget() {
  const target = new RecordingTarget();
  const calls: { receiver: object; member: string; args: unknown[] }[] = [];
  const native = { pipeline: {}, group: {}, indirect: {}, layout: {}, query: {}, pass: {} };
  function capture(receiver: object, member: string, value?: unknown) {
    Reflect.set(receiver, member, function (this: object, ...args: unknown[]) {
      calls.push({ receiver: this, member, args });
      return value;
    });
  }
  capture(target.device, "createComputePipeline", native.pipeline);
  capture(target.encoder, "beginComputePass", native.pass);
  for (const member of [
    "setPipeline",
    "setBindGroup",
    "setImmediates",
    "dispatchWorkgroups",
    "dispatchWorkgroupsIndirect",
    "pushDebugGroup",
    "popDebugGroup",
    "insertDebugMarker",
    "end",
  ])
    capture(native.pass, member);
  return { target, native, calls };
}
function bind(
  connection: ReturnType<typeof rig>["connection"],
  id: number,
  kind: Parameters<ReturnType<typeof rig>["connection"]["replay"]["handles"]["reserve"]>[1],
  value: object,
) {
  connection.replay.handles.reserve(handle(id), kind);
  connection.replay.handles.bind(handle(id), kind, { kind: "native", value });
}
function pipeline(layout: { id: number; generation: number } | null = null) {
  return {
    next_in_chain: [],
    label: "compute",
    layout,
    compute: {
      next_in_chain: [],
      module: handle(4),
      entry_point: null,
      constants: [{ next_in_chain: [], key: "scale", value: -2.5 }],
    },
  };
}
function createPipeline(
  connection: ReturnType<typeof rig>["connection"],
  descriptor: unknown = pipeline(),
) {
  send(
    connection,
    command("device.create_compute_pipeline", {
      result: handle(5),
      receiver: handle(3),
      descriptor,
    }),
  );
}
function encoder(connection: ReturnType<typeof rig>["connection"]) {
  send(
    connection,
    command("device.create_command_encoder", {
      result: handle(6),
      receiver: handle(3),
      descriptor: null,
    }),
  );
}
function compute(name: string, fields: unknown = {}) {
  return command(`compute_pass_encoder.${name}`, fields);
}
function begin(descriptor: unknown = null) {
  return command("command_encoder.begin_compute_pass", { result: handle(7), descriptor });
}

test("compute descriptors preserve exact native identities, constants, auto layout and timestamp sentinels", async () => {
  const { target, native, calls } = computeTarget();
  const { connection } = rig(target, 4096);
  try {
    await openDevice(connection);
    bind(connection, 4, "shader_module", target.shader);
    createPipeline(connection);
    expect(calls[0]).toEqual({
      receiver: target.device,
      member: "createComputePipeline",
      args: [
        {
          label: "compute",
          layout: "auto",
          compute: { module: target.shader, constants: { scale: -2.5 } },
        },
      ],
    });
    const original = pipeline(handle(8));
    const descriptor = { ...original, compute: { ...original.compute, entry_point: "main" } };
    bind(connection, 8, "pipeline_layout", native.layout);
    send(connection, words(0x1000, [21, 5, 1]));
    send(
      connection,
      command("device.create_compute_pipeline", {
        result: handle(5, 2),
        receiver: handle(3),
        descriptor,
      }),
    );
    expect(calls[1]?.args).toEqual([
      {
        label: "compute",
        layout: native.layout,
        compute: { module: target.shader, entryPoint: "main", constants: { scale: -2.5 } },
      },
    ]);
    expect(Reflect.get(Object(calls[1]?.args[0]), "layout")).toBe(native.layout);
    bind(connection, 11, "query_set", native.query);
    encoder(connection);
    send(
      connection,
      encodeBlob(
        6,
        joinRecords(
          begin({
            next_in_chain: [],
            label: "timestamps",
            timestamp_writes: {
              next_in_chain: [],
              query_set: handle(11),
              beginning_of_pass_write_index: 0xffffffff,
              end_of_pass_write_index: 0,
            },
          }),
          compute("end"),
        ),
      ),
    );
    expect(calls[2]?.args).toEqual([
      { label: "timestamps", timestampWrites: { querySet: native.query, endOfPassWriteIndex: 0 } },
    ]);
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close();
  }
});

test("all ordinary compute commands reach their real receiver with exact arguments across one-command slices", async () => {
  const { target, native, calls } = computeTarget();
  const { connection, credit } = rig(target, 4096);
  try {
    await openDevice(connection);
    bind(connection, 4, "shader_module", target.shader);
    bind(connection, 8, "bind_group", native.group);
    bind(connection, 9, "buffer", native.indirect);
    createPipeline(connection);
    encoder(connection);
    const bytes = encodeBlob(
      6,
      joinRecords(
        begin(),
        compute("set_label", { label: "active" }),
        compute("push_debug_group", { group_label: "work" }),
        compute("insert_debug_marker", { marker_label: "λ" }),
        compute("set_pipeline", { pipeline: handle(5) }),
        compute("set_bind_group", {
          group_index: 2,
          group: handle(8),
          dynamic_offsets: [256, 512],
        }),
        compute("set_immediates", { offset: 4, data: [7, 8, 9, 10] }),
        compute("dispatch_workgroups", {
          workgroupCountX: 2,
          workgroupCountY: 3,
          workgroupCountZ: 4,
        }),
        compute("dispatch_workgroups_indirect", {
          indirect_buffer: handle(9),
          indirect_offset: 4294967296,
        }),
        compute("set_bind_group", { group_index: 2, group: null, dynamic_offsets: [] }),
        compute("pop_debug_group"),
        compute("end"),
        command("command_encoder.finish", { result: handle(10), descriptor: null }),
      ),
    );
    const writer = new LogicalAppend(connection.commands, bytes);
    expect(writer.advance()).toBe("done");
    const budgets: number[] = [];
    for (let turn = 0; turn < 40; turn++) {
      const slice = connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
      budgets.push(slice.bytes);
      if (slice.kind === "idle") break;
    }
    expect(connection.replay.busy).toBe(false);
    expect(budgets.length).toBeGreaterThan(12);
    expect(Reflect.get(native.pass, "label")).toBe("active");
    const actions = calls.filter((call) => call.receiver === native.pass);
    expect(actions.map((call) => [call.member, call.args])).toEqual([
      ["pushDebugGroup", ["work"]],
      ["insertDebugMarker", ["λ"]],
      ["setPipeline", [native.pipeline]],
      ["setBindGroup", [2, native.group, [256, 512]]],
      ["setImmediates", [4, new Uint8Array([7, 8, 9, 10])]],
      ["dispatchWorkgroups", [2, 3, 4]],
      ["dispatchWorkgroupsIndirect", [native.indirect, 4294967296]],
      ["setBindGroup", [2, null, []]],
      ["popDebugGroup", []],
      ["end", []],
    ]);
    expect(actions[2]?.args[0]).toBe(native.pipeline);
    expect(actions[3]?.args[1]).toBe(native.group);
    expect(actions[6]?.args[0]).toBe(native.indirect);
    expect(connection.state.kind).toBe("ready");
    send(connection, words(0x1000, [21, 5, 1]));
    send(connection, words(0x1000, [16, 8, 1]));
    send(connection, words(0x1000, [14, 9, 1]));
    expect(() => connection.replay.handles.native(handle(9), "buffer")).toThrow();
  } finally {
    connection.close();
  }
  expect(credit.used).toBe(0);
  expect(target.calls.filter((call) => call.member === "destroy")).toHaveLength(1);
});

for (const nested of [
  compute("dispatch_workgroups", { workgroupCountX: 1, workgroupCountY: 1, workgroupCountZ: 1 }),
  joinRecords(begin(), command("render_pass_encoder.end", {})),
  joinRecords(begin(), begin()),
  begin(),
]) {
  test("invalid compute nesting closes only its owner and releases held cursors", async () => {
    const { target } = computeTarget();
    const { connection, credit } = rig(target, 256);
    const other = rig(new RecordingTarget());
    try {
      await openDevice(connection);
      encoder(connection);
      send(connection, encodeBlob(6, nested));
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

test("native invalid pipeline identities and WebIDL exceptions remain different from malformed compute", async () => {
  const { target, native } = computeTarget();
  const { connection, replies } = rig(target, 4096);
  try {
    await openDevice(connection);
    drain(replies);
    bind(connection, 4, "shader_module", target.shader);
    createPipeline(connection);
    expect(connection.replay.handles.native(handle(5), "compute_pipeline")).toBe(native.pipeline);
    Reflect.set(target.device, "createComputePipeline", () => {
      throw new TypeError("native WebIDL conversion");
    });
    send(
      connection,
      command("device.create_compute_pipeline", {
        result: handle(8),
        receiver: handle(3),
        descriptor: pipeline(),
      }),
    );
    expect(connection.replay.handles.get(handle(8), "compute_pipeline").kind).toBe("exception");
    expect(drain(replies)).toHaveLength(1);
    expect(connection.state.kind).toBe("ready");
    const lower = new DescriptorLowering(connection.replay.handles);
    const descriptor = pipeline();
    descriptor.compute.constants.push({ ...descriptor.compute.constants[0]!, value: 3 });
    expect(() => lower.dictionary("compute_pipeline_descriptor", descriptor)).toThrow("duplicate");
    const malformed = compute("dispatch_workgroups_indirect", {
      indirect_buffer: handle(9),
      indirect_offset: 0,
    });
    new DataView(malformed.buffer).setBigUint64(16, 1n << 53n, true);
    expect(decodeCall(malformed).fields.indirect_offset).toBe(1n << 53n);
    encoder(connection);
    bind(connection, 9, "buffer", native.indirect);
    send(connection, encodeBlob(6, joinRecords(begin(), malformed, compute("end"))));
    expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
  } finally {
    connection.close();
  }
});

test("immediate bytes are bounded by their own length and reject truncation locally", async () => {
  const { target, calls } = computeTarget();
  const { connection, credit } = rig(target, 256);
  try {
    await openDevice(connection);
    encoder(connection);
    const span = compute("set_immediates", { offset: 0, data: new Uint8Array(8192).fill(23) });
    send(connection, encodeBlob(6, joinRecords(begin(), span, compute("end"))));
    const call = calls.find((entry) => entry.member === "setImmediates");
    expect(call?.args).toEqual([0, new Uint8Array(8192).fill(23)]);
    new DataView(span.buffer).setUint32(12, 0xffffffff, true);
    expect(() => decodeCall(span)).toThrow();
    expect(connection.state.kind).toBe("ready");
  } finally {
    connection.close();
  }
  expect(credit.used).toBe(0);
});

test("closing while a compute pass is suspended frees the cursor without replaying or ending it", async () => {
  const { target, calls } = computeTarget();
  const { connection, credit } = rig(target, 4096);
  await openDevice(connection);
  encoder(connection);
  const publication = new LogicalAppend(
    connection.commands,
    encodeBlob(
      6,
      joinRecords(
        begin(),
        compute("dispatch_workgroups", {
          workgroupCountX: 1,
          workgroupCountY: 1,
          workgroupCountZ: 1,
        }),
        compute("end"),
      ),
    ),
  );
  try {
    expect(publication.advance()).toBe("done");
    for (let turns = 0; turns < 3; turns++)
      connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
    expect(connection.replay.busy).toBe(true);
    expect(calls.map((entry) => entry.member)).toEqual(["beginComputePass"]);
  } finally {
    connection.close();
  }
  connection.close();
  expect(connection.slice()).toEqual({ kind: "terminal", bytes: 0 });
  expect(credit.used).toBe(0);
  expect(calls.map((entry) => entry.member)).toEqual(["beginComputePass"]);
  expect(target.calls.filter((entry) => entry.member === "destroy")).toHaveLength(1);
});
