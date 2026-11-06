import { describe, expect, test } from "bun:test";
import expected from "./fixtures/gpu/expected.json";
import { decodeCall, safeGpuNumber, wireObject, type WireObject } from "../browser/gpu/codec.ts";
import { DescriptorLowering } from "../browser/gpu/lowering.ts";
import { HandleTable } from "../browser/gpu/handles.ts";
import { GPU_TERMINAL, checkedSpan } from "../browser/gpu/protocol.ts";
import { GpuScheduler } from "../browser/gpu/scheduler.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import {
  command,
  drain,
  encodeBlob,
  handle,
  joinRecords,
  openDevice,
  RecordingTarget,
  rig,
  ROOT,
  send,
  settle,
  words,
} from "./fixtures/gpu/core-fixture.ts";

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replaceAll(" ", ""), "hex"));
}
function vector(name: string): Uint8Array {
  const entry = expected.vectors.find((entry) => entry.command === name);
  if (!entry) throw new Error("Missing independent golden vector");
  return hex(entry.hex);
}
function passDescriptor() {
  return {
    next_in_chain: [],
    label: "",
    color_attachments: [],
    depth_stencil_attachment: null,
    occlusion_query_set: null,
    timestamp_writes: null,
  };
}
function renderBlob(draws = 1): Uint8Array {
  const begin = command("command_encoder.begin_render_pass", {
    result: handle(10),
    descriptor: passDescriptor(),
  });
  const draw = vector("render_pass_encoder.draw");
  const repeated = new Uint8Array(draw.byteLength * draws);
  for (let index = 0; index < draws; index++) repeated.set(draw, index * draw.byteLength);
  return encodeBlob(
    9,
    joinRecords(
      begin,
      command("render_pass_encoder.set_pipeline", { pipeline: handle(7) }),
      repeated,
      command("render_pass_encoder.end", {}),
      command("command_encoder.finish", { result: handle(11), descriptor: null }),
    ),
  );
}
async function prepareEncoder(
  target: RecordingTarget,
  connection: ReturnType<typeof rig>["connection"],
) {
  await openDevice(connection);
  send(connection, vector("device.create_shader_module"));
  send(connection, vector("device.create_render_pipeline"));
  send(
    connection,
    command("device.create_command_encoder", {
      result: handle(9),
      receiver: handle(3),
      descriptor: null,
    }),
  );
  expect(connection.state.kind).toBe("ready");
  expect(target.calls.some((entry) => entry.member === "createCommandEncoder")).toBe(true);
}

describe("generated-layout GPU replay", () => {
  test("decodes independently selected golden bytes, not just encoder round trips", () => {
    for (const entry of expected.vectors) {
      const decoded = decodeCall(hex(entry.hex));
      expect(decoded.layout.name).toBe(entry.command);
      const actual: unknown = decoded.fields;
      expect(actual).toEqual(entry.input);
    }
  });
  test("calls actual target root, adapter, queue, WGSL and auto-layout pipeline methods", async () => {
    const target = new RecordingTarget();
    const { connection, credit } = rig(target);
    try {
      send(connection, vector("instance.request_adapter"));
      await settle();
      send(connection, vector("adapter.request_device"));
      await settle();
      send(connection, vector("device.get_queue"));
      send(connection, vector("device.create_shader_module"));
      send(connection, vector("device.create_render_pipeline"));
      expect(connection.state.kind).toBe("ready");
      expect(connection.replay.handles.native(handle(5), "queue")).toBe(target.queue);
      expect(target.calls[0]).toEqual({
        receiver: "gpu",
        member: "requestAdapter",
        args: [undefined],
      });
      expect(target.calls[1]).toEqual({
        receiver: "adapter",
        member: "requestDevice",
        args: [{ label: "", requiredFeatures: [], defaultQueue: { label: "" } }],
      });
      expect(target.calls.find((entry) => entry.member === "createShaderModule")?.args).toEqual([
        { label: "", code: "abc" },
      ]);
      expect(target.calls.find((entry) => entry.member === "createRenderPipeline")?.args).toEqual([
        {
          label: "",
          layout: "auto",
          vertex: { module: target.shader, constants: {}, buffers: [] },
          primitive: {
            topology: "triangle-list",
            frontFace: "ccw",
            cullMode: "none",
            unclippedDepth: false,
          },
          multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
        },
      ]);
      expect(target.listeners.size).toBe(1);
    } finally {
      connection.close();
    }
    expect(credit.used).toBe(0);
    expect(target.listeners.size).toBe(0);
  });
  test("surface grant adapter and explicit acquire/present statuses use golden completions", async () => {
    const target = new RecordingTarget();
    const surface = { id: 7 };
    const calls: unknown[] = [];
    let creditAvailable = false;
    const context = rig({
      root: target.root,
      surfaces: {
        create(id, label) {
          expect(id).toBe(7);
          expect(label).toBe("");
          return surface;
        },
        configure(value, descriptor) {
          expect(value).toBe(surface);
          calls.push(descriptor);
        },
        acquire(value) {
          expect(value).toBe(surface);
          return creditAvailable
            ? { kind: "ready", texture: target.texture, status: 1 }
            : { kind: "await" };
        },
        present() {
          return { kind: "ready", status: 1 };
        },
        unconfigure() {},
        release() {},
      },
    });
    try {
      await openDevice(context.connection);
      drain(context.replies);
      send(context.connection, vector("instance.create_surface"));
      send(
        context.connection,
        command("surface.configure", {
          receiver: handle(4),
          config: {
            next_in_chain: [],
            device: handle(3),
            format: 22,
            usage: 16n,
            width: 640,
            height: 480,
            view_formats: [],
            alpha_mode: 0,
            present_mode: 1,
          },
        }),
      );
      expect(calls).toEqual([
        {
          device: target.device,
          format: "rgba8unorm",
          usage: 17,
          viewFormats: [],
          alphaMode: "opaque",
          width: 640,
          height: 480,
        },
      ]);
      context.connection.replay.handles.reserve(handle(8), "texture");
      context.connection.replay.handles.release(handle(8), "texture");
      send(context.connection, vector("surface.get_current_texture"));
      expect(context.connection.replay.busy).toBe(true);
      expect(drain(context.replies)).toEqual([]);
      creditAvailable = true;
      context.connection.slice();
      send(context.connection, vector("surface.present"));
      const replies = drain(context.replies);
      expect(replies).toEqual(expected.completions.slice(0, 2).map((entry) => hex(entry.hex)));
      expect(context.connection.replay.handles.native(handle(8, 2), "texture")).toBe(
        target.texture,
      );
    } finally {
      context.connection.close();
    }
  });
  test("preserves native invalid objects through real later validation, unlike exception placeholders", async () => {
    const target = new RecordingTarget();
    const invalid = { nativeInvalid: true };
    const validation = new (class GPUValidationError {
      message = "invalid pipeline";
    })();
    Object.assign(target.device, {
      createRenderPipeline: () => invalid,
      popErrorScope: () => Promise.resolve(validation),
    });
    const { connection, replies } = rig(target);
    try {
      await prepareEncoder(target, connection);
      send(connection, vector("device.push_error_scope"));
      send(connection, renderBlob());
      send(connection, command("device.pop_error_scope", { receiver: handle(3), token: 3 }));
      await settle();
      expect(target.calls.find((entry) => entry.member === "setPipeline")?.args).toEqual([invalid]);
      expect(connection.state.kind).toBe("ready");
      const scope = drain(replies).at(-1);
      expect(scope && new DataView(scope.buffer).getUint32(20, true)).toBe(2);
      Object.assign(target.device, {
        createShaderModule() {
          throw new TypeError("bad WGSL input");
        },
      });
      send(
        connection,
        command("device.create_shader_module", {
          ...decodeCall(vector("device.create_shader_module")).fields,
          result: handle(12),
        }),
      );
      expect(connection.replay.handles.get(handle(12), "shader_module").kind).toBe("exception");
      send(
        connection,
        command("device.create_render_pipeline", {
          ...decodeCall(vector("device.create_render_pipeline")).fields,
          result: handle(13),
          descriptor: {
            ...wireObject(decodeCall(vector("device.create_render_pipeline")).fields.descriptor),
            vertex: {
              next_in_chain: [],
              module: handle(12),
              entry_point: null,
              constants: [],
              buffers: [],
            },
          },
        }),
      );
      expect(connection.replay.handles.get(handle(13), "render_pipeline").kind).toBe("exception");
      expect(connection.state.kind).toBe("ready");
    } finally {
      connection.close();
    }
  });
  test("resumes passes and encoders across slices and visits another connection during one large blob", async () => {
    const target = new RecordingTarget();
    const first = rig(target, 4096);
    const otherTarget = new RecordingTarget();
    const second = rig(otherTarget, 256);
    const scheduler = new GpuScheduler();
    try {
      await prepareEncoder(target, first.connection);
      await openDevice(second.connection);
      const bytes = renderBlob(200000);
      const { LogicalAppend } = await import("../browser/gpu/transport.ts");
      const publication = new LogicalAppend(first.commands, bytes);
      scheduler.add(first.connection);
      scheduler.add(second.connection);
      let turns = 0;
      for (; turns < 100000; turns++) {
        const progress = publication.advance();
        scheduler.turn({ bytes: 256, milliseconds: 4, now: () => 0 });
        if (progress === "done") break;
      }
      expect(turns).toBeGreaterThan(1);
      first.connection.slice({ bytes: 256, milliseconds: 4, now: () => 0 });
      send(
        second.connection,
        command("device.get_queue", { receiver: handle(3), result: handle(5) }),
      );
      expect(second.connection.replay.handles.native(handle(5), "queue")).toBe(otherTarget.queue);
      expect(target.calls.filter((entry) => entry.member === "draw").length).toBeLessThan(200000);
      let yields = 0;
      await scheduler.drain(
        async () => {
          yields++;
        },
        { bytes: 256, milliseconds: 4, now: () => 0 },
      );
      expect(yields).toBeGreaterThan(100);
      expect(target.calls.filter((entry) => entry.member === "draw")).toHaveLength(200000);
      expect(target.calls.filter((entry) => entry.member === "beginRenderPass")).toHaveLength(1);
      expect(target.calls.filter((entry) => entry.member === "finish")).toHaveLength(1);
      send(
        first.connection,
        command("device.get_queue", { receiver: handle(3), result: handle(5) }),
      );
      send(
        first.connection,
        command("queue.submit", { receiver: handle(5), commands: [handle(11)] }),
      );
      expect(target.calls.at(-1)).toEqual({
        receiver: "queue",
        member: "submit",
        args: [[target.buffer]],
      });
      expect(first.connection.state.kind).toBe("ready");
    } finally {
      first.connection.close();
      second.connection.close();
    }
    expect(first.credit.used + second.credit.used).toBe(0);
  });
  test("rejects invalid nesting, forged root, unknown opcode and disabled records only locally", () => {
    const bad = [
      command("instance.request_adapter", {
        result: handle(2),
        receiver: handle(1, 2),
        token: 1,
        options: null,
      }),
      vector("render_pass_encoder.draw"),
      words(0x1002, []),
      words(0xffff, []),
    ];
    for (const bytes of bad) {
      const local = rig(new RecordingTarget());
      try {
        expect(() => send(local.connection, bytes)).not.toThrow();
        expect(local.connection.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      } finally {
        local.connection.close();
      }
      expect(local.credit.used).toBe(0);
    }
  });
  test("generation and typed handle lifetimes reserve the root and retain only bounded tombstones", () => {
    const table = new HandleTable({}, () => {}, 8);
    try {
      expect(() => table.release(ROOT, "instance")).toThrow("root");
      table.reserve(handle(2), "adapter");
      expect(() => table.native(handle(2), "adapter")).toThrow("pending");
      table.bind(handle(2), "adapter", { kind: "native", value: {} });
      expect(() => table.native(handle(2), "device")).toThrow();
      table.release(handle(2), "adapter");
      expect(() => table.release(handle(2), "adapter")).toThrow();
      expect(() => table.reserve(handle(2), "adapter")).toThrow("generation");
      table.reserve(handle(2, 2), "adapter");
      expect(table.bind(handle(2), "adapter", { kind: "native", value: {} })).toBe(false);
      expect(() => table.reserve(handle(9), "adapter")).toThrow("limit");
    } finally {
      table.retire();
    }
  });
  test("checked spans, u64 precision and descriptor sentinel policies precede native use", () => {
    expect(() => checkedSpan(8, 9, 0)).toThrow();
    expect(() => checkedSpan(8, 4, Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => checkedSpan(8, 8, 0)).not.toThrow();
    expect(safeGpuNumber(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => safeGpuNumber(9007199254740992n)).toThrow("Lossy");
    const table = new HandleTable({}, () => {});
    const lower = new DescriptorLowering(table);
    try {
      const limits: WireObject = {};
      for (const field of gpuStream.structs.limits.fields)
        limits[field.name] = field.type.startsWith("chain")
          ? []
          : field.type === "uint64"
            ? 0xffffffffffffffffn
            : 0xffffffff;
      expect(lower.dictionary("limits", limits)).toEqual({});
      expect(() =>
        lower.dictionary("limits", { ...limits, max_buffer_size: 9007199254740992n }),
      ).toThrow("Lossy");
      expect(
        lower.dictionary("texture_view_descriptor", {
          next_in_chain: [],
          label: "",
          format: 0,
          dimension: 0,
          base_mip_level: 0,
          mip_level_count: 0xffffffff,
          base_array_layer: 0,
          array_layer_count: 0xffffffff,
          aspect: 0,
          usage: 0n,
        }),
      ).toEqual({ label: "", baseMipLevel: 0, baseArrayLayer: 0 });
    } finally {
      table.retire();
    }
  });
  test("lowers the pinned optional-bool enum to browser booleans, never numeric flags", () => {
    const table = new HandleTable({}, () => {});
    const lower = new DescriptorLowering(table);
    try {
      expect(lower.value("enum.optional_bool", 0)).toBe(false);
      expect(lower.value("enum.optional_bool", 1)).toBe(true);
      expect(lower.value("enum.optional_bool", 2)).toBeUndefined();
    } finally {
      table.retire();
    }
  });
});
