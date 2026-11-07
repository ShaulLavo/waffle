import { gpuStream, gpuObjectKinds } from "../../../browser/gpu/generated/tables.js";
import { nativeCall, nativeObject } from "../../../browser/gpu/lowering.js";
import { GpuConnection } from "../../../browser/gpu/scheduler.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { LogicalAppend } from "../../../browser/gpu/transport.js";
import { ServiceCredit } from "../../../browser/gpu/protocol.js";
import { encodeGpuCommand } from "../../../tooling/gpu-stream-layout.js";
import { bufferDescriptor, layoutEntry } from "./scene-fixture.js";

const identity = (id: number) => ({ id, generation: 1 });
const outputBytes = 64;
const patternMask = 0x1234;
function encoded(name: string, fields: unknown = {}) {
  return encodeGpuCommand(gpuStream, name, fields);
}
function publish(connection: GpuConnection, bytes: Uint8Array) {
  const append = new LogicalAppend(connection.commands, bytes);
  let completed = false;
  try {
    for (let turns = 0; turns < 10000; turns++) {
      const state = append.advance();
      connection.slice();
      if (connection.state.kind !== "ready") throw new Error("Compute stream closed");
      if (state === "done") {
        completed = true;
        return;
      }
    }
    throw new Error("Compute publication exceeded its bound");
  } finally {
    if (!completed) append.cancel();
  }
}
function call(connection: GpuConnection, name: string, fields: unknown) {
  publish(connection, encoded(name, fields));
}
function create(connection: GpuConnection, name: string, id: number, descriptor: unknown) {
  call(connection, `device.create_${name}`, {
    result: identity(id),
    receiver: identity(3),
    descriptor,
  });
}
function commands(connection: GpuConnection, records: readonly Uint8Array[], encoder = 10) {
  const size = records.reduce((sum, record) => sum + record.byteLength, 0);
  const bytes = new Uint8Array(Math.ceil((20 + size) / 8) * 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x1001, true);
  view.setUint32(4, bytes.byteLength, true);
  view.setUint32(8, encoder, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, size, true);
  let offset = 20;
  for (const record of records) {
    bytes.set(record, offset);
    offset += record.byteLength;
  }
  publish(connection, bytes);
}
function release(connection: GpuConnection, kind: keyof typeof gpuObjectKinds, id: number) {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x1000, true);
  view.setUint32(4, 24, true);
  view.setUint32(8, gpuObjectKinds[kind], true);
  view.setUint32(12, id, true);
  view.setUint32(16, 1, true);
  publish(connection, bytes);
}
function shader(immediate: boolean): string {
  const declaration = immediate
    ? "requires immediate_address_space; var<immediate> settings: vec4u;"
    : "override mask: u32;";
  const expression = immediate
    ? "((id.x + 1u) * settings.y + settings.z) ^ settings.x ^ settings.w"
    : "((id.x + 1u) * 17u) ^ mask";
  return `${declaration}
@group(0) @binding(0) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  output[id.x] = ${expression};
}`;
}
function computeDescriptor(layout: ReturnType<typeof identity> | null, value: number) {
  return {
    next_in_chain: [],
    label: "invalid-control",
    layout,
    compute: {
      next_in_chain: [],
      module: identity(5),
      entry_point: "main",
      constants: [{ next_in_chain: [], key: "mask", value }],
    },
  };
}
async function pipelineErrors(connection: GpuConnection, device: object, replies: RecordRing) {
  nativeCall(device, "pushErrorScope", ["validation"]);
  create(connection, "compute_pipeline", 31, computeDescriptor(identity(7), -1));
  const invalidNative =
    connection.replay.handles.get(identity(31), "compute_pipeline").kind === "native";
  const validation = await nativeCall(device, "popErrorScope", []);
  if (
    !invalidNative ||
    !validation ||
    nativeObject(validation).constructor.name !== "GPUValidationError" ||
    replyKinds(replies).length
  )
    throw new Error("Invalid compute pipeline was replaced with a call exception");
  nativeCall(device, "pushErrorScope", ["validation"]);
  create(connection, "compute_pipeline", 32, computeDescriptor(identity(7), Infinity));
  const exception =
    connection.replay.handles.get(identity(32), "compute_pipeline").kind === "exception";
  const webidlScope = await nativeCall(device, "popErrorScope", []);
  const kinds = replyKinds(replies);
  if (!exception || webidlScope !== null || kinds.length !== 1 || kinds[0] !== 8)
    throw new Error("Nonfinite compute constant did not report the native WebIDL exception");
  return { invalidNative, webidlException: exception };
}
function resources(connection: GpuConnection, immediate: boolean, explicit: boolean) {
  create(connection, "buffer", 4, bufferDescriptor(outputBytes, 132));
  call(connection, "device.get_queue", { result: identity(12), receiver: identity(3) });
  call(connection, "device.create_shader_module", {
    result: identity(5),
    receiver: identity(3),
    descriptor: {
      label: "pattern",
      next_in_chain: [{ sType: 2, value: { code: shader(immediate) } }],
    },
  });
  const entry = layoutEntry();
  entry.visibility = 4;
  entry.buffer.type = 3;
  entry.buffer.min_binding_size = outputBytes;
  create(connection, "bind_group_layout", 6, {
    next_in_chain: [],
    label: "storage",
    entries: [entry],
  });
  if (explicit)
    create(connection, "pipeline_layout", 7, {
      next_in_chain: [],
      label: "explicit",
      bind_group_layouts: [identity(6)],
      immediate_size: immediate ? 16 : 0,
    });
  create(connection, "compute_pipeline", 8, {
    next_in_chain: [],
    label: "pattern",
    layout: explicit ? identity(7) : null,
    compute: {
      next_in_chain: [],
      module: identity(5),
      entry_point: "main",
      constants: immediate ? [] : [{ next_in_chain: [], key: "mask", value: patternMask }],
    },
  });
  // Auto layout identities are queried only by the trusted observation harness.
  // This is not a newly selected guest get-bind-group-layout operation.
  const layout = explicit
    ? connection.replay.handles.native(identity(6), "bind_group_layout")
    : nativeObject(
        nativeCall(
          connection.replay.handles.native(identity(8), "compute_pipeline"),
          "getBindGroupLayout",
          [0],
        ),
      );
  if (!explicit) {
    release(connection, "bind_group_layout", 6);
    connection.replay.handles.reserve({ id: 6, generation: 2 }, "bind_group_layout");
    connection.replay.handles.bind({ id: 6, generation: 2 }, "bind_group_layout", {
      kind: "native",
      value: layout,
    });
  }
  create(connection, "bind_group", 9, {
    next_in_chain: [],
    label: "output",
    layout: { id: 6, generation: explicit ? 1 : 2 },
    entries: [
      {
        next_in_chain: [],
        binding: 0,
        buffer: identity(4),
        offset: 0,
        size: 0xffffffffffffffffn,
        sampler: null,
        texture_view: null,
      },
    ],
  });
  create(connection, "command_encoder", 10, null);
}
function computeCommands(control: string, immediate: boolean) {
  const dispatch =
    control === "indirect"
      ? encoded("compute_pass_encoder.dispatch_workgroups_indirect", {
          indirect_buffer: identity(14),
          indirect_offset: 4,
        })
      : encoded("compute_pass_encoder.dispatch_workgroups", {
          workgroupCountX: 16,
          workgroupCountY: 1,
          workgroupCountZ: 1,
        });
  const records = [
    encoded("command_encoder.begin_compute_pass", {
      result: identity(11),
      descriptor: { next_in_chain: [], label: "pattern", timestamp_writes: null },
    }),
    encoded("compute_pass_encoder.set_label", { label: "compute-pattern" }),
    encoded("compute_pass_encoder.push_debug_group", { group_label: "pattern" }),
    encoded("compute_pass_encoder.insert_debug_marker", { marker_label: "dispatch" }),
    encoded("compute_pass_encoder.set_pipeline", { pipeline: identity(8) }),
    encoded("compute_pass_encoder.set_bind_group", {
      group_index: 0,
      group: identity(9),
      dynamic_offsets: [],
    }),
  ];
  if (immediate)
    records.push(
      encoded("compute_pass_encoder.set_immediates", {
        offset: 0,
        data: new Uint8Array(new Uint32Array([patternMask, 17, 3, 5]).buffer),
      }),
    );
  if (control !== "no-dispatch") records.push(dispatch);
  return records.concat([
    encoded("compute_pass_encoder.pop_debug_group"),
    encoded("compute_pass_encoder.end"),
    encoded("command_encoder.finish", { result: identity(13), descriptor: null }),
  ]);
}
async function observe(device: object, source: object): Promise<number[]> {
  const readback = nativeObject(
    nativeCall(device, "createBuffer", [{ size: outputBytes, usage: 9 }]),
  );
  try {
    const encoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
    nativeCall(encoder, "copyBufferToBuffer", [source, 0, readback, 0, outputBytes]);
    nativeCall(nativeObject(Reflect.get(device, "queue")), "submit", [
      [nativeCall(encoder, "finish", [])],
    ]);
    await nativeCall(readback, "mapAsync", [1]);
    const range: unknown = nativeCall(readback, "getMappedRange", []);
    if (!(range instanceof ArrayBuffer)) throw new Error("Trusted host readback returned no bytes");
    return Array.from(new Uint32Array(range));
  } finally {
    nativeCall(readback, "unmap", []);
    nativeCall(readback, "destroy", []);
  }
}
function replyKinds(replies: RecordRing): number[] {
  const kinds: number[] = [];
  const bytes = new Uint8Array(replies.capacity);
  for (let i = 0; i < 100; i++) {
    const result = replies.readInto(bytes);
    if (result.kind !== "record") return kinds;
    kinds.push(new DataView(bytes.buffer).getUint16(0, true));
  }
  throw new Error("Native control reply bound exceeded");
}
async function immediateErrors(
  connection: GpuConnection,
  device: object,
  replies: RecordRing,
  limit: number,
) {
  const results: { name: string; exception: boolean; validation: boolean }[] = [];
  const cases = [
    { name: "byte-length", offset: 0, data: [1, 2, 3] },
    { name: "offset-alignment", offset: 1, data: [1, 2, 3, 4] },
    { name: "range", offset: limit, data: [1, 2, 3, 4] },
  ];
  for (const [index, item] of cases.entries()) {
    const encoder = 20 + index * 3;
    nativeCall(device, "pushErrorScope", ["validation"]);
    create(connection, "command_encoder", encoder, null);
    commands(
      connection,
      [
        encoded("command_encoder.begin_compute_pass", {
          result: identity(encoder + 1),
          descriptor: null,
        }),
        encoded("compute_pass_encoder.set_immediates", { offset: item.offset, data: item.data }),
        encoded("compute_pass_encoder.end"),
        encoded("command_encoder.finish", { result: identity(encoder + 2), descriptor: null }),
      ],
      encoder,
    );
    const error = await nativeCall(device, "popErrorScope", []);
    const kinds = replyKinds(replies);
    const exception = kinds.length === 1 && kinds[0] === 8;
    const validation =
      error !== null && nativeObject(error).constructor.name === "GPUValidationError";
    if (kinds.length && !exception) throw new Error("Unexpected immediate completion");
    if (exception !== (item.name === "byte-length") || validation !== (item.name !== "byte-length"))
      throw new Error(`Wrong immediate error classification: ${item.name}`);
    results.push({ name: item.name, exception, validation });
    release(connection, "command_encoder", encoder);
    release(connection, "compute_pass_encoder", encoder + 1);
    release(connection, "command_buffer", encoder + 2);
  }
  return results;
}
/** Native lowering controls only. Trusted host mapping observes shader writes. */
export async function computeNativeControl(control: string) {
  const gpu = nativeObject(Reflect.get(navigator, "gpu"));
  const adapter = nativeObject(
    await nativeCall(gpu, "requestAdapter", [{ forceFallbackAdapter: true }]),
  );
  const info = nativeObject(Reflect.get(adapter, "info"));
  if (Reflect.get(info, "architecture") !== "swiftshader")
    throw new Error("Compute control requires actual SwiftShader");
  const device = nativeObject(await nativeCall(adapter, "requestDevice", []));
  const credit = new ServiceCredit();
  const replies = new RecordRing(new SharedArrayBuffer(64 + 4096), 16);
  const connection = new GpuConnection(
    new RecordRing(new SharedArrayBuffer(64 + 4096), 8),
    replies,
    { root: gpu },
    credit,
  );
  connection.replay.handles.reserve(identity(3), "device");
  connection.replay.handles.bind(identity(3), "device", { kind: "native", value: device });
  try {
    const probeEncoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
    const probePass = nativeObject(nativeCall(probeEncoder, "beginComputePass", []));
    const method = typeof Reflect.get(probePass, "setImmediates");
    const limit: unknown = Reflect.get(
      nativeObject(Reflect.get(device, "limits")),
      "maxImmediateSize",
    );
    const availability = {
      method,
      maxImmediateSize: typeof limit === "number" ? limit : null,
      wgslImmediateAddressSpace: nativeCall(
        nativeObject(Reflect.get(gpu, "wgslLanguageFeatures")),
        "has",
        ["immediate_address_space"],
      ),
    };
    nativeCall(probePass, "end", []);
    nativeCall(probeEncoder, "finish", []);
    const immediate = control.startsWith("immediate-");
    if (
      immediate &&
      (method !== "function" ||
        typeof limit !== "number" ||
        limit < 16 ||
        availability.wgslImmediateAddressSpace !== true)
    )
      return {
        kind: "native-lowering-control",
        compiledGuest: false,
        control,
        availability,
        status: "unavailable",
      };
    nativeCall(device, "pushErrorScope", ["validation"]);
    resources(connection, immediate, control !== "immediate-auto" && control !== "auto");
    if (control === "indirect") {
      create(connection, "buffer", 14, bufferDescriptor(16, 264));
      call(connection, "queue.write_buffer", {
        receiver: identity(12),
        buffer: identity(14),
        buffer_offset: 0,
        data: new Uint8Array(new Uint32Array([0, 16, 1, 1]).buffer),
      });
    }
    const source = connection.replay.handles.native(identity(4), "buffer");
    commands(connection, computeCommands(control, immediate));
    // Native commands/bind groups must retain ordinary resources after guest handles drop.
    release(connection, "buffer", 4);
    release(connection, "compute_pipeline", 8);
    release(connection, "bind_group", 9);
    if (control === "indirect") release(connection, "buffer", 14);
    call(connection, "queue.submit", { receiver: identity(12), commands: [identity(13)] });
    const values = await observe(device, source);
    const error = await nativeCall(device, "popErrorScope", []);
    if (error)
      throw new Error(`Native compute validation: ${Reflect.get(nativeObject(error), "message")}`);
    if (replyKinds(replies).length) throw new Error("Unexpected compute call exception");
    const expected = Array.from({ length: 16 }, (_, i) =>
      control === "no-dispatch"
        ? 0
        : immediate
          ? ((i + 1) * 17 + 3) ^ patternMask ^ 5
          : ((i + 1) * 17) ^ patternMask,
    );
    if (values.some((value, i) => value !== expected[i]))
      throw new Error(`Shader pattern mismatch for ${control}: ${values}`);
    const errors =
      immediate && typeof limit === "number"
        ? await immediateErrors(connection, device, replies, limit)
        : [];
    const pipelineValidation =
      !immediate && control === "direct" ? await pipelineErrors(connection, device, replies) : null;
    connection.close();
    if (credit.used) throw new Error("Compute control retained connection credit");
    return {
      kind: "native-lowering-control",
      compiledGuest: false,
      control,
      availability,
      status: "passed",
      values,
      errors,
      pipelineValidation,
    };
  } finally {
    connection.close();
  }
}
