import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { expect, test } from "bun:test";
import { GpuConnection } from "../browser/gpu/scheduler.ts";
import { gpuObjectKinds, gpuStream } from "../browser/gpu/generated/tables.ts";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.ts";
import { PayloadDirectory } from "../browser/gpu/payload.ts";
import { WireReader } from "../browser/gpu/codec.ts";
import { compilationMessages } from "../browser/gpu/metadata.ts";
import { ServiceCredit } from "../browser/gpu/protocol.ts";
import { encodeGpuPrivate } from "../tooling/gpu-stream-layout.ts";
import {
  command,
  deferred,
  drain,
  handle,
  ring,
  send,
  settle,
  words,
} from "./fixtures/gpu/core-fixture.ts";

class NativeBuffer {
  readonly bytes = new Uint8Array(32);
  view: ArrayBuffer | undefined;
  mapped: boolean;
  pending = deferred<void>();
  mode = 0;
  offset = 0;
  length = 32;
  maps = 0;
  ranges = 0;
  unmaps = 0;
  destroys = 0;
  constructor(mapped = false) {
    this.mapped = mapped;
  }
  mapAsync(mode: number, offset: number, size = 32 - offset): Promise<void> {
    this.maps++;
    if (
      (mode !== 1 && mode !== 2) ||
      offset % 8 ||
      size % 4 ||
      offset > 32 ||
      size > 32 - offset ||
      this.mapped
    )
      return Promise.reject(new DOMException("native validation", "OperationError"));
    this.mode = mode;
    this.offset = offset;
    this.length = size;
    return this.pending.promise;
  }
  fulfill(): void {
    this.mapped = true;
    this.pending.resolve();
  }
  getMappedRange(offset: number, length: number): ArrayBuffer {
    this.ranges++;
    if (!this.mapped) throw new Error("Native buffer is not mapped");
    if (this.view) throw new Error("Overlapping native range");
    return (this.view = this.bytes.slice(offset, offset + length).buffer);
  }
  unmap(): void {
    this.unmaps++;
    this.invalidate();
  }
  invalidate(): void {
    if (this.view) {
      this.bytes.set(new Uint8Array(this.view), this.offset);
      structuredClone(this.view, { transfer: [this.view] });
    }
    this.view = undefined;
    this.mapped = false;
  }
  destroy(): void {
    this.destroys++;
    this.invalidate();
  }
}
function setup(mapped = false, heapLimit?: number) {
  const buffer = new NativeBuffer(mapped);
  const buffers = [buffer];
  const compilation = deferred<unknown>();
  const shader = { getCompilationInfo: () => compilation.promise };
  const work = deferred<void>();
  const queue = { onSubmittedWorkDone: () => work.promise };
  const lost = deferred<unknown>();
  const listeners = new Set<unknown>();
  const device = {
    queue,
    lost: lost.promise,
    features: new Set(["depth-clip-control"]),
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 1048576 },
    createBuffer: () => buffer,
    createShaderModule: () => shader,
    destroy: () => {
      for (const buffer of buffers) buffer.invalidate();
    },
    addEventListener: (_name: string, listener: unknown) => listeners.add(listener),
    removeEventListener: (_name: string, listener: unknown) => listeners.delete(listener),
  };
  const info = Object.create({
    vendor: "native",
    architecture: "cpu",
    device: "actual",
    description: "",
    subgroupMinSize: 4,
    subgroupMaxSize: 32,
  });
  const adapter = {
    info,
    features: new Set(["depth-clip-control", "shader-f16"]),
    limits: Object.create({ maxTextureDimension2D: 8192, maxBufferSize: 2097152 }),
    requestDevice: () => Promise.resolve(device),
  };
  const root = {
    wgslLanguageFeatures: new Set(["uniform_buffer_standard_layout"]),
    requestAdapter: () => Promise.resolve(adapter),
  };
  const backing = new SharedArrayBuffer(gpuPayloadLayout.byteLength);
  const commands = ring(65536),
    replies = ring(65536, 16),
    credit = new ServiceCredit(heapLimit);
  const connection = new GpuConnection(commands, replies, { root }, credit, { access: serviceAccess(),
    arena: new Uint8Array(backing),
  });
  const publish = (name: string, input: unknown) => send(connection, command(name, input));
  const directory = new PayloadDirectory(backing);
  const copy = (identity: { id: number; generation: number }, length: number) => {
    const output = new Uint8Array(length);
    expect(
      directory.copyOnce(
        identity,
        output,
        () => commands.terminal()?.reason,
        (reason) => {
          connection.close(reason);
          return commands.terminal()?.reason ?? 0;
        },
      ),
    ).toBe(0);
    return output;
  };
  const responses = () =>
    drain(replies).map((bytes) => {
      const view = new DataView(bytes.buffer);
      const kind = view.getUint16(0, true);
      const layout = gpuStream.completions.find((entry) => entry.kind === kind);
      if (!layout) throw new Error("Unknown response");
      return {
        kind,
        token: view.getUint32(8, true),
        bridge: view.getInt32(12, true),
        fields: new WireReader(bytes, 16).fields(layout.fields),
      };
    });
  const create = () =>
    publish("device.create_buffer", {
      result: handle(4),
      receiver: handle(3),
      descriptor: {
        next_in_chain: [],
        label: "native",
        usage: 6,
        size: 32,
        mapped_at_creation: mapped,
      },
    });
  return {
    buffer,
    buffers,
    device,
    shader,
    adapter,
    compilation,
    work,
    queue,
    lost,
    listeners,
    backing,
    connection,
    credit,
    publish,
    copy,
    responses,
    create,
  };
}
async function opened(mapped = false, heapLimit?: number) {
  const rig = setup(mapped, heapLimit);
  rig.publish("instance.request_adapter", {
    result: handle(2),
    token: 1,
    receiver: handle(1),
    options: null,
  });
  await settle();
  rig.publish("adapter.request_device", {
    result: handle(3),
    token: 2,
    receiver: handle(2),
    descriptor: null,
  });
  await settle();
  rig.responses();
  rig.create();
  return rig;
}
function mappedHandle(response: ReturnType<ReturnType<typeof setup>["responses"]>[number]) {
  const payload = response.fields.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload instanceof Uint8Array ||
    typeof payload.id !== "number" ||
    typeof payload.generation !== "number"
  )
    throw new Error("Missing payload handle");
  return { id: payload.id, generation: payload.generation };
}
function map(
  rig: ReturnType<typeof setup>,
  token = 3,
  mode = 2,
  offset = 0,
  size = 0xffffffffffffffffn,
) {
  rig.publish("buffer.map_async", { token, receiver: handle(4), mode, offset, size });
}
function writes(rig: ReturnType<typeof setup>, ranges: unknown[]) {
  send(
    rig.connection,
    encodeGpuPrivate(gpuStream, "buffer-unmap-writes", { buffer: handle(4), ranges }),
  );
}
test("read/write maps snapshot actual initial bytes, cache one range and preserve native identity/usage", async () => {
  const rig = await opened();
  try {
    rig.buffer.bytes.fill(17);
    map(rig);
    rig.buffer.fulfill();
    await settle();
    const reply = rig.responses()[0];
    if (!reply) throw new Error("Missing map result");
    expect(reply).toMatchObject({
      kind: 16,
      bridge: 0,
      token: 3,
      fields: { status: 1, length: 32 },
    });
    expect(Array.from(rig.copy(mappedHandle(reply), 32))).toEqual(Array(32).fill(17));
    writes(rig, [{ offset: 8, data: [1, 2, 3, 4] }]);
    expect(rig.buffer.ranges).toBe(1);
    expect(rig.buffer.unmaps).toBe(1);
    expect(Array.from(rig.buffer.bytes.slice(8, 12))).toEqual([1, 2, 3, 4]);
    expect(rig.connection.replay.handles.native(handle(4), "buffer")).toBe(rig.buffer);
    rig.buffer.pending = deferred<void>();
    map(rig, 4, 1);
    rig.buffer.fulfill();
    await settle();
    const read = rig.responses()[0];
    if (!read) throw new Error("Missing read result");
    const output = rig.copy(mappedHandle(read), 32);
    output.fill(99);
    rig.publish("buffer.unmap", { receiver: handle(4) });
    expect(Array.from(rig.buffer.bytes.slice(8, 12))).toEqual([1, 2, 3, 4]);
    expect(rig.connection.state.kind).toBe("ready");
  } finally {
    rig.connection.close();
  }
});
test("mapped-at-creation zeroes accept aligned partial writes without changing native usage", async () => {
  const rig = await opened(true);
  try {
    writes(rig, [{ offset: 8, data: [7, 8, 9, 10] }]);
    expect(Array.from(rig.buffer.bytes)).toEqual(
      Array(8).fill(0).concat([7, 8, 9, 10], Array(20).fill(0)),
    );
    expect(rig.buffer.maps).toBe(0);
    expect(rig.buffer.ranges).toBe(1);
  } finally {
    rig.connection.close();
  }
});
for (const ranges of [
  [
    { offset: 0, data: [1, 2, 3, 4] },
    { offset: 4, data: [5, 6, 7, 8] },
  ],
  [
    { offset: 0, data: [1, 2, 3, 4] },
    { offset: 40, data: [5, 6, 7, 8] },
  ],
  [
    { offset: 8, data: [1, 2, 3, 4] },
    { offset: 0, data: [5, 6, 7, 8] },
  ],
  [{ offset: 0, data: [1, 2, 3] }],
])
  test(`write transaction validates all ranges before any copy ${JSON.stringify(ranges)}`, async () => {
    const rig = await opened(true);
    try {
      writes(rig, ranges);
      expect(rig.connection.state).toEqual({ kind: "terminal", reason: 2 });
      expect(rig.buffer.ranges).toBe(0);
      expect(Array.from(rig.buffer.bytes)).toEqual(Array(32).fill(0));
    } finally {
      rig.connection.close();
    }
  });
for (const action of [
  "unmap",
  "buffer-destroy",
  "buffer-release",
  "device-destroy",
  "device-release",
  "close",
  "revoke",
] as const)
  for (const result of ["resolve", "reject"] as const)
    test(`pending map ${action} then late ${result} does not reacquire a range`, async () => {
      const rig = await opened();
      try {
        map(rig);
        if (action === "unmap") rig.publish("buffer.unmap", { receiver: handle(4) });
        if (action === "buffer-destroy") rig.publish("buffer.destroy", { receiver: handle(4) });
        if (action === "device-destroy") rig.publish("device.destroy", { receiver: handle(3) });
        if (action === "buffer-release" || action === "device-release")
          send(
            rig.connection,
            words(0x1000, [
              action === "buffer-release" ? gpuObjectKinds.buffer : gpuObjectKinds.device,
              action === "buffer-release" ? 4 : 3,
              1,
            ]),
          );
        if (action === "close" || action === "revoke")
          rig.connection.close(action === "close" ? 1 : 4);
        if (result === "resolve") rig.buffer.pending.resolve();
        else rig.buffer.pending.reject(new DOMException("aborted", "AbortError"));
        await settle();
        expect(rig.buffer.ranges).toBe(0);
        expect(rig.connection.replay.snapshot().views).toBe(0);
        const mapReplies = rig.responses().filter((reply) => reply.kind === 16);
        if (action === "close" || action === "revoke") expect(mapReplies).toHaveLength(0);
        else {
          expect(mapReplies).toHaveLength(1);
          expect(mapReplies[0]?.fields).toMatchObject({ status: 4, payload: null, length: 0 });
        }
      } finally {
        rig.connection.close();
        expect(rig.credit.used).toBe(0);
      }
    });
for (const action of ["device-destroy", "device-release"])
  test(`already fulfilled result held across ${action} reports aborted`, async () => {
    const rig = await opened();
    try {
      map(rig);
      rig.buffer.fulfill();
      if (action === "device-destroy") rig.publish("device.destroy", { receiver: handle(3) });
      else send(rig.connection, words(0x1000, [gpuObjectKinds.device, 3, 1]));
      await settle();
      expect(rig.buffer.ranges).toBe(0);
      expect(rig.responses().find((reply) => reply.kind === 16)?.fields.status).toBe(4);
    } finally {
      rig.connection.close();
    }
  });
test("old map epoch does not reset or unmap a newer successful mapping", async () => {
  const rig = await opened();
  try {
    map(rig);
    const old = rig.buffer.pending;
    rig.publish("buffer.unmap", { receiver: handle(4) });
    rig.buffer.pending = deferred<void>();
    map(rig, 4);
    rig.buffer.fulfill();
    await settle();
    const unmaps = rig.buffer.unmaps,
      ranges = rig.buffer.ranges;
    old.resolve();
    await settle();
    expect(rig.buffer.unmaps).toBe(unmaps);
    expect(rig.buffer.ranges).toBe(ranges);
    expect(rig.responses().map((reply) => [reply.token, reply.fields.status])).toEqual([
      [4, 1],
      [3, 4],
    ]);
    writes(rig, [{ offset: 0, data: [3, 4, 5, 6] }]);
    expect(rig.connection.state.kind).toBe("ready");
  } finally {
    rig.connection.close();
  }
});
test("last buffer release unmaps without destroying; published snapshots survive release", async () => {
  const rig = await opened();
  try {
    map(rig);
    rig.buffer.fulfill();
    await settle();
    const reply = rig.responses()[0];
    if (!reply) throw new Error("Missing mapped result");
    send(rig.connection, words(0x1000, [gpuObjectKinds.buffer, 4, 1]));
    expect(rig.buffer.unmaps).toBe(1);
    expect(rig.buffer.destroys).toBe(0);
    expect(rig.copy(mappedHandle(reply), 32)).toHaveLength(32);
  } finally {
    rig.connection.close();
  }
});
for (const mode of [0, 3, 8])
  test(`invalid raw map mode ${mode} reaches native and emits one map failure`, async () => {
    const rig = await opened();
    try {
      map(rig, 3, mode);
      await settle();
      expect(rig.buffer.maps).toBe(1);
      expect(rig.connection.state.kind).toBe("ready");
      expect(
        rig.responses().map((reply) => [reply.kind, reply.token, reply.fields.status]),
      ).toEqual([[16, 3, 3]]);
    } finally {
      rig.connection.close();
    }
  });
test("metadata uses prototype getters, actual adapter and granted device sets", async () => {
  const rig = await opened();
  try {
    for (const [name, id, token] of [
      ["adapter.get_info", 2, 3],
      ["adapter.get_features", 2, 4],
      ["device.get_features", 3, 5],
      ["adapter.get_limits", 2, 6],
      ["device.get_limits", 3, 7],
      ["instance.get_WGSL_language_features", 1, 8],
      ["device.get_adapter_info", 3, 9],
    ] as const)
      rig.publish(name, { token, receiver: handle(id) });
    const replies = rig.responses();
    expect(replies).toHaveLength(7);
    const decoded = replies.map((reply) => {
      const output = rig.copy(mappedHandle(reply), Number(reply.fields.length));
      return new WireReader(output).type(`struct.query_${reply.fields.opcode}`);
    });
    expect(decoded[0]).toMatchObject({
      returned: 1,
      info: {
        vendor: "native",
        architecture: "cpu",
        vendor_ID: 0,
        device_ID: 0,
        backend_type: 2,
        adapter_type: 4,
      },
    });
    expect(decoded[1]).toMatchObject({ features: { features: [2, 11] } });
    expect(decoded[2]).toMatchObject({ features: { features: [2] } });
    expect(decoded[3]).toMatchObject({
      limits: { max_texture_dimension_2D: 8192, max_buffer_size: 2097152n },
    });
    expect(decoded[4]).toMatchObject({
      limits: {
        max_texture_dimension_2D: 4096,
        max_buffer_size: 1048576n,
        max_immediate_size: 0xffffffff,
      },
    });
    expect(decoded[5]).toMatchObject({ features: { features: [5] } });
    expect(decoded[6]).toMatchObject({
      returned: 1,
      adapter_info: { vendor: "native", architecture: "cpu" },
    });
    expect(rig.connection.replay.handles.native(handle(2), "adapter")).toBe(rig.adapter);
  } finally {
    rig.connection.close();
  }
});
test("queue work completion follows its native promise, including late release and native rejection", async () => {
  const rig = await opened();
  try {
    rig.publish("device.get_queue", { result: handle(5), receiver: handle(3) });
    rig.publish("queue.on_submitted_work_done", { token: 3, receiver: handle(5) });
    expect(rig.responses()).toHaveLength(0);
    send(rig.connection, words(0x1000, [gpuObjectKinds.queue, 5, 1]));
    rig.work.resolve();
    await settle();
    expect(rig.responses()).toMatchObject([
      { kind: 18, token: 3, fields: { status: 1, message: "" } },
    ]);
  } finally {
    rig.connection.close();
  }
});
test("native device loss reads prototype reason/message, does not close a connection and detaches listeners", async () => {
  const rig = await opened();
  try {
    expect(rig.connection.replay.devicesLive).toBe(1);
    expect(rig.listeners.size).toBe(1);
    rig.lost.resolve(Object.create({ reason: "destroyed", message: "native prototype message" }));
    await settle();
    expect(rig.responses()).toMatchObject([
      { kind: 7, fields: { reason: 2, message: "native prototype message" } },
    ]);
    expect(rig.connection.state.kind).toBe("ready");
    expect(rig.connection.replay.devicesLive).toBe(0);
  } finally {
    rig.connection.close();
    expect(rig.listeners.size).toBe(0);
  }
});
test("compilation translates UTF-16 ranges to UTF-8 C byte positions in one bounded pass", () => {
  expect(
    compilationMessages("λ😀\n猫x", [
      { message: "bad", type: "error", lineNum: 2, linePos: 2, offset: 5, length: 1 },
    ]),
  ).toMatchObject([{ line_num: 2n, line_pos: 4n, offset: 10n, length: 1n }]);
  expect(() =>
    compilationMessages("😀", [
      { message: "bad", type: "error", lineNum: 1, linePos: 2, offset: 1, length: 1 },
    ]),
  ).toThrow("surrogate");
  expect(() =>
    compilationMessages("x", [
      { message: "bad", type: "error", lineNum: 2, linePos: 1, offset: 0, length: 1 },
    ]),
  ).toThrow("Inconsistent");
});
for (const mode of ["release", "close", "reject", "oversize"] as const)
  test(`compilation source lifetime and ${mode} settlement`, async () => {
    const rig = await opened();
    try {
      const baseline = rig.credit.used;
      rig.publish("device.create_shader_module", {
        result: handle(5),
        receiver: handle(3),
        descriptor: { next_in_chain: [{ sType: 2, value: { code: "λ😀\n猫x" } }], label: "" },
      });
      expect(rig.credit.used).toBeGreaterThan(0);
      rig.publish("shader_module.get_compilation_info", { token: 3, receiver: handle(5) });
      send(rig.connection, words(0x1000, [gpuObjectKinds.shader_module, 5, 1]));
      expect(rig.credit.used).toBeGreaterThan(0);
      if (mode === "close") {
        rig.connection.close();
        expect(rig.credit.used).toBe(0);
      }
      if (mode === "reject") rig.compilation.reject(new Error("native rejected"));
      else
        rig.compilation.resolve({
          messages:
            mode === "oversize"
              ? [
                  {
                    message: "x".repeat(gpuPayloadLayout.dataBytes),
                    type: "error",
                    lineNum: 0,
                    linePos: 0,
                    offset: 0,
                    length: 0,
                  },
                ]
              : [{ message: "bad", type: "error", lineNum: 2, linePos: 2, offset: 5, length: 1 }],
        });
      await settle();
      expect(rig.credit.used).toBe(mode === "close" || mode === "oversize" ? 0 : baseline);
      const reply = rig.responses().find((reply) => reply.kind === 17);
      if (mode === "close" || mode === "oversize") expect(reply).toBeUndefined();
      else if (mode === "reject")
        expect(reply).toMatchObject({
          bridge: -28,
          fields: { status: 2, payload: null, length: 0 },
        });
      else {
        if (!reply) throw new Error("Missing compilation result");
        expect(
          new WireReader(rig.copy(mappedHandle(reply), Number(reply.fields.length))).type(
            "struct.compilation_info",
          ),
        ).toMatchObject({ messages: [{ message: "bad", offset: 10n, line_pos: 4n }] });
      }
    } finally {
      rig.connection.close();
      expect(rig.credit.used).toBe(0);
    }
  });

test("a declared unsupported C feature fails the device future once without dropping the request", async () => {
  const rig = await opened();
  let calls = 0;
  rig.adapter.requestDevice = () => {
    calls++;
    return Promise.resolve(rig.device);
  };
  try {
    rig.publish("adapter.request_device", {
      result: handle(6),
      token: 3,
      receiver: handle(2),
      descriptor: {
        next_in_chain: [],
        label: "unsupported feature",
        required_features: [1],
        required_limits: null,
        default_queue: { next_in_chain: [], label: "" },
      },
    });
    expect(calls).toBe(0);
    expect(rig.responses()).toMatchObject([
      {
        kind: 2,
        token: 3,
        bridge: -28,
        fields: { status: gpuStream.enums["enum.request_device_status"].error },
      },
    ]);
    expect(rig.connection.replay.handles.get(handle(6), "device").kind).toBe("exception");
    rig.publish("adapter.has_feature", { token: 4, receiver: handle(2), feature: 1 });
    expect(rig.responses()).toHaveLength(1);
    expect(rig.connection.state.kind).toBe("ready");
  } finally {
    rig.connection.close();
  }
});

test("compilation projection scratch is charged before retaining native message fields", async () => {
  const rig = await opened(false, 66_000);
  let reads = 0;
  try {
    rig.publish("device.create_shader_module", {
      result: handle(5),
      receiver: handle(3),
      descriptor: { next_in_chain: [{ sType: 2, value: { code: "x" } }], label: "" },
    });
    rig.publish("shader_module.get_compilation_info", { token: 3, receiver: handle(5) });
    const native = Object.create({
      get message() {
        reads++;
        return "native";
      },
      type: "error",
      lineNum: 0,
      linePos: 0,
      offset: 0,
      length: 0,
    });
    rig.compilation.resolve({ messages: [native] });
    await settle();
    expect(reads).toBe(0);
    expect(rig.connection.state).toEqual({ kind: "terminal", reason: 3 });
    expect(rig.credit.used).toBe(0);
  } finally {
    rig.connection.close();
  }
});
