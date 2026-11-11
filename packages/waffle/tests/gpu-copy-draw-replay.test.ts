import { expect, test } from "bun:test";
import { GPU_TERMINAL } from "../browser/gpu/protocol.ts";
import { LogicalAppend } from "../browser/gpu/transport.ts";
import { DescriptorLowering } from "../browser/gpu/lowering.ts";
import { blob, encoded, h, release } from "./fixtures/gpu/bundle-query-fixture.ts";
import { drain, rig, send, RecordingTarget } from "./fixtures/gpu/core-fixture.ts";
import expected from "./fixtures/gpu/copy-draw-expected.json";

function recording() {
  const target = new RecordingTarget();
  const calls: { receiver: object; member: string; args: unknown[] }[] = [];
  const buffer = {};
  const texture = {};
  const secondBuffer = {};
  const commands = {};
  const { connection, credit, replies } = rig(target, 4096);
  const bind = (
    id: number,
    kind: Parameters<typeof connection.replay.handles.reserve>[1],
    value: object,
  ) => {
    connection.replay.handles.reserve(h(id), kind);
    connection.replay.handles.bind(h(id), kind, { kind: "native", value });
  };
  const capture = (receiver: object, member: string, result?: unknown) => {
    Reflect.set(receiver, member, function (this: object, ...args: unknown[]) {
      calls.push({ receiver: this, member, args });
      return result;
    });
  };
  bind(4, "buffer", buffer);
  bind(5, "texture", texture);
  bind(6, "command_encoder", target.encoder);
  bind(7, "buffer", secondBuffer);
  bind(9, "texture_view", target.view);
  bind(10, "texture", texture);
  for (const member of [
    "copyBufferToBuffer",
    "copyBufferToTexture",
    "copyTextureToBuffer",
    "copyTextureToTexture",
    "clearBuffer",
    "pushDebugGroup",
    "popDebugGroup",
    "insertDebugMarker",
  ])
    capture(target.encoder, member);
  for (const member of [
    "setImmediates",
    "drawIndirect",
    "drawIndexedIndirect",
    "pushDebugGroup",
    "popDebugGroup",
    "insertDebugMarker",
    "setStencilReference",
    "setBlendConstant",
    "setViewport",
    "setScissorRect",
    "end",
  ])
    capture(target.pass, member);
  capture(target.encoder, "beginRenderPass", target.pass);
  capture(target.encoder, "finish", commands);
  capture(buffer, "destroy");
  capture(texture, "destroy");
  return { target, connection, credit, replies, calls, buffer, secondBuffer, texture, commands };
}
function passStart() {
  return encoded("command_encoder.begin_render_pass", {
    result: h(8),
    descriptor: {
      next_in_chain: [],
      label: "",
      color_attachments: [],
      depth_stencil_attachment: null,
      occlusion_query_set: null,
      timestamp_writes: null,
    },
  });
}
function finish() {
  return encoded("command_encoder.finish", { result: h(11), descriptor: null });
}
function vectors(start: number, end: number) {
  return expected.vectors.slice(start, end).map((vector) => encoded(vector.command, vector.input));
}

test("copy, draw, state and debug commands preserve native receivers and identities one step at a time", () => {
  const { target, connection, credit, replies, calls, buffer, secondBuffer, texture, commands } =
    recording();
  const copy = encoded("command_encoder.copy_buffer_to_buffer", {
    source: h(4),
    source_offset: 8,
    destination: h(7),
    destination_offset: 16,
    size: 24,
  });
  const records = [copy].concat(vectors(1, 8), [passStart()], vectors(8, 18), [
    encoded("render_pass_encoder.end"),
    finish(),
  ]);
  const writer = new LogicalAppend(connection.commands, blob(0x1001, 6, records));
  try {
    expect(writer.advance()).toBe("done");
    for (let i = 0; i < records.length + 3; i++) {
      const count = calls.length;
      connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
      expect(calls.length - count).toBeLessThanOrEqual(1);
    }
    const bufferInfo = { buffer, offset: 8, bytesPerRow: 256, rowsPerImage: 4 };
    const textureInfo = { texture, mipLevel: 2, origin: { x: 3, y: 4, z: 1 }, aspect: "all" };
    const size = { width: 2, height: 3, depthOrArrayLayers: 1 };
    expect(calls.slice(0, 8).map((entry) => [entry.member, entry.args])).toEqual([
      ["copyBufferToBuffer", [buffer, 8, secondBuffer, 16, 24]],
      ["copyBufferToTexture", [bufferInfo, textureInfo, size]],
      ["copyTextureToBuffer", [textureInfo, bufferInfo, size]],
      ["copyTextureToTexture", [textureInfo, textureInfo, size]],
      ["clearBuffer", [buffer, 8, 16]],
      ["insertDebugMarker", ["λ"]],
      ["popDebugGroup", []],
      ["pushDebugGroup", ["copy"]],
    ]);
    expect(calls.slice(9, 19).map((entry) => [entry.member, entry.args])).toEqual([
      ["setImmediates", [4, new Uint8Array([1, 2, 3, 4])]],
      ["drawIndirect", [buffer, 4294967296]],
      ["drawIndexedIndirect", [buffer, 24]],
      ["insertDebugMarker", ["λ"]],
      ["popDebugGroup", []],
      ["pushDebugGroup", ["draw"]],
      ["setStencilReference", [7]],
      ["setBlendConstant", [{ r: 1, g: 0.5, b: 0.25, a: 1 }]],
      ["setViewport", [1, 2, 3, 4, 0.25, 0.75]],
      ["setScissorRect", [1, 2, 3, 4]],
    ]);
    expect(calls.slice(0, 9).every((entry) => entry.receiver === target.encoder)).toBe(true);
    expect(calls.slice(9, 20).every((entry) => entry.receiver === target.pass)).toBe(true);
    expect(connection.replay.handles.native(h(11), "command_buffer")).toBe(commands);
    expect(connection.replay.busy).toBe(false);
    expect(drain(replies)).toHaveLength(0);
  } finally {
    writer.cancel();
    connection.close();
  }
  expect(credit.used).toBe(0);
});

test("copy layout flattening omits strides, clear whole-size omits only size, and destroy is not release", () => {
  const { connection, calls, buffer, texture } = recording();
  try {
    const lower = new DescriptorLowering(connection.replay.handles);
    expect(
      lower.dictionary("texel_copy_buffer_info", {
        layout: { offset: 4294967296n, bytes_per_row: 0xffffffff, rows_per_image: 0xffffffff },
        buffer: h(4),
      }),
    ).toEqual({ buffer, offset: 4294967296 });
    send(
      connection,
      blob(0x1001, 6, [
        encoded("command_encoder.clear_buffer", {
          buffer: h(4),
          offset: 4,
          size: 0xffffffffffffffffn,
        }),
      ]),
    );
    expect(calls.at(-1)?.args).toEqual([buffer, 4, undefined]);
    for (const vector of expected.vectors.slice(18))
      send(connection, encoded(vector.command, vector.input));
    expect(calls.slice(-2).map((entry) => [entry.receiver, entry.member])).toEqual([
      [buffer, "destroy"],
      [texture, "destroy"],
    ]);
    expect(connection.replay.handles.native(h(4), "buffer")).toBe(buffer);
    expect(connection.replay.handles.native(h(5), "texture")).toBe(texture);
    release(connection, "buffer", 4);
    release(connection, "texture", 5);
    release(connection, "texture", 10);
    expect(calls.filter((entry) => entry.member === "destroy")).toHaveLength(2);
  } finally {
    connection.close();
  }
});

for (const name of ["source_offset", "destination_offset", "size"]) {
  test(`copy rejects lossy ${name} before native invocation`, () => {
    const { connection, calls, credit } = recording();
    try {
      send(
        connection,
        blob(0x1001, 6, [
          encoded("command_encoder.copy_buffer_to_buffer", {
            source: h(4),
            source_offset: 0,
            destination: h(7),
            destination_offset: 0,
            size: 4,
            [name]: 0x20000000000000n,
          }),
        ]),
      );
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      expect(calls).toHaveLength(0);
      expect(credit.used).toBe(0);
    } finally {
      connection.close();
    }
  });
}

test("invalid objects stay native and real exceptions remain call exceptions without releasing aliases", () => {
  const { connection, target, calls, replies, texture } = recording();
  try {
    Reflect.set(target.encoder, "copyTextureToTexture", () => {
      throw new TypeError("WebIDL conversion");
    });
    send(connection, blob(0x1001, 6, vectors(3, 4)));
    expect(
      drain(replies).map((bytes) =>
        new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true),
      ),
    ).toEqual([8]);
    expect(connection.state.kind).toBe("ready");
    expect(connection.replay.handles.get(h(5), "texture").kind).toBe("native");
    send(connection, encoded("texture.destroy", { receiver: h(10) }));
    expect(calls.at(-1)?.receiver).toBe(texture);
    expect(connection.replay.handles.native(h(5), "texture")).toBe(texture);
  } finally {
    connection.close();
  }
});

test("wrong contexts, stale objects, malformed spans and padding terminate only the sender", () => {
  const immediate = encoded("render_pass_encoder.set_immediates", {
    offset: 0,
    data: [1, 2, 3, 4],
  });
  new DataView(immediate.buffer).setUint32(12, 0xffffffff, true);
  const marker = encoded("command_encoder.insert_debug_marker", { marker_label: "a" });
  marker[15] = 1;
  const cases = [
    vectors(0, 1)[0]!,
    blob(0x1001, 6, [passStart(), vectors(0, 1)[0]!]),
    blob(0x1001, 6, [passStart(), immediate]),
    blob(0x1001, 6, [marker]),
    blob(0x1001, 6, [
      encoded("command_encoder.clear_buffer", { buffer: h(4, 2), offset: 0, size: 4 }),
    ]),
    blob(0x1001, 6, [
      passStart(),
      encoded("render_pass_encoder.draw_indirect", { indirect_buffer: h(5), indirect_offset: 0 }),
    ]),
    blob(0x1002, 6, [encoded("render_pass_encoder.pop_debug_group")]),
  ];
  for (const bytes of cases) {
    const { connection, credit } = recording();
    const other = rig(new RecordingTarget());
    try {
      send(connection, bytes);
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      expect(connection.replay.busy).toBe(false);
      expect(credit.used).toBe(0);
      expect(other.connection.state.kind).toBe("ready");
    } finally {
      connection.close();
      other.connection.close();
    }
  }
});

test("large render-immediate spans survive chunk transport and close cancels a suspended render pass", () => {
  const { connection, calls, credit } = recording();
  try {
    const data = new Uint8Array(8192).fill(19);
    send(
      connection,
      blob(0x1001, 6, [
        passStart(),
        encoded("render_pass_encoder.set_immediates", { offset: 0, data }),
        encoded("render_pass_encoder.end"),
      ]),
    );
    expect(calls.find((entry) => entry.member === "setImmediates")?.args).toEqual([0, data]);
    const writer = new LogicalAppend(
      connection.commands,
      blob(0x1001, 6, [
        encoded("command_encoder.clear_buffer", { buffer: h(4), offset: 0, size: 4 }),
        encoded("command_encoder.push_debug_group", { group_label: "suspended" }),
        encoded("command_encoder.pop_debug_group"),
      ]),
    );
    expect(writer.advance()).toBe("done");
    connection.slice({ bytes: 1, milliseconds: 1, now: () => 0 });
    expect(connection.replay.busy).toBe(true);
    const before = calls.length;
    connection.close();
    writer.cancel();
    expect(connection.slice().kind).toBe("terminal");
    expect(calls).toHaveLength(before);
  } finally {
    connection.close();
  }
  expect(credit.used).toBe(0);
});

for (const name of ["copy-offset", "clear-offset", "indirect-offset"]) {
  test(`checked u64 conversion rejects ${name} without using a whole-size fallback`, () => {
    const { connection, calls } = recording();
    try {
      const value = 0xffffffffffffffffn;
      const records =
        name === "copy-offset"
          ? [
              encoded("command_encoder.copy_buffer_to_texture", {
                source: {
                  layout: { offset: value, bytes_per_row: 256, rows_per_image: 1 },
                  buffer: h(4),
                },
                destination: {
                  texture: h(5),
                  mip_level: 0,
                  origin: { x: 0, y: 0, z: 0 },
                  aspect: 1,
                },
                copy_size: { width: 1, height: 1, depth_or_array_layers: 1 },
              }),
            ]
          : name === "clear-offset"
            ? [
                encoded("command_encoder.clear_buffer", {
                  buffer: h(4),
                  offset: value,
                  size: value,
                }),
              ]
            : [
                passStart(),
                encoded("render_pass_encoder.draw_indirect", {
                  indirect_buffer: h(4),
                  indirect_offset: value,
                }),
              ];
      send(connection, blob(0x1001, 6, records));
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      expect(calls.every((entry) => entry.member === "beginRenderPass")).toBe(true);
    } finally {
      connection.close();
    }
  });
}
