import { serviceAccess } from "./service-access.js";
import { gpuObjectKinds, gpuStream } from "../../../browser/gpu/generated/tables.js";
import { GpuConnection } from "../../../browser/gpu/scheduler.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { ServiceCredit } from "../../../browser/gpu/protocol.js";
import { LogicalAppend } from "../../../browser/gpu/transport.js";
import { encodeGpuCommand } from "../../../tooling/gpu-stream-layout.js";

export const h = (id: number, generation = 1) => ({ id, generation });
export function encoded(name: string, fields: unknown = {}): Uint8Array {
  return encodeGpuCommand(gpuStream, name, fields);
}
export function blob(
  opcode: 0x1001 | 0x1002,
  encoder: number,
  records: readonly Uint8Array[],
  generation = 1,
): Uint8Array {
  const length = records.reduce((sum, entry) => sum + entry.byteLength, 0);
  const output = new Uint8Array(Math.ceil((20 + length) / 8) * 8);
  const view = new DataView(output.buffer);
  view.setUint16(0, opcode, true);
  view.setUint32(4, output.byteLength, true);
  view.setUint32(8, encoder, true);
  view.setUint32(12, generation, true);
  view.setUint32(16, length, true);
  let at = 20;
  for (const entry of records) {
    output.set(entry, at);
    at += entry.byteLength;
  }
  return output;
}
export function publish(connection: GpuConnection, bytes: Uint8Array): void {
  const writer = new LogicalAppend(connection.commands, bytes);
  let completed = false;
  try {
    for (let turn = 0; turn < 100000; turn++) {
      const state = writer.advance();
      connection.slice();
      if (connection.state.kind !== "ready") throw new Error("Bundle/query connection closed");
      if (state !== "done" || connection.replay.busy) continue;
      completed = true;
      return;
    }
    throw new Error("Bundle/query publication exceeded its bound");
  } finally {
    if (!completed) writer.cancel();
  }
}
export function call(connection: GpuConnection, name: string, fields: unknown = {}): void {
  publish(connection, encoded(name, fields));
}
export function create(
  connection: GpuConnection,
  name: string,
  id: number,
  descriptor: unknown,
): void {
  call(connection, `device.create_${name}`, { result: h(id), receiver: h(3), descriptor });
}
export function release(
  connection: GpuConnection,
  kind: keyof typeof gpuObjectKinds,
  id: number,
): void {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x1000, true);
  view.setUint32(4, 24, true);
  view.setUint32(8, gpuObjectKinds[kind], true);
  view.setUint32(12, id, true);
  view.setUint32(16, 1, true);
  publish(connection, bytes);
}
export function bundleDescriptor() {
  return {
    next_in_chain: [],
    label: "bundle",
    color_formats: [22],
    depth_stencil_format: 0,
    sample_count: 1,
    depth_read_only: false,
    stencil_read_only: false,
  };
}
export function renderDescriptor(view = 17, query: ReturnType<typeof h> | null = h(15)) {
  return {
    next_in_chain: [],
    label: "query",
    color_attachments: [
      {
        next_in_chain: [],
        view: h(view),
        depth_slice: 0xffffffff,
        resolve_target: null,
        load_op: 2,
        store_op: 1,
        clear_value: { r: 0, g: 0, b: 1, a: 1 },
      },
    ],
    depth_stencil_attachment: null,
    occlusion_query_set: query,
    timestamp_writes: null,
  };
}

export function nativeRig(gpu: object, device: object) {
  const credit = new ServiceCredit();
  const replies = new RecordRing(new SharedArrayBuffer(64 + 4096), 16);
  const connection = new GpuConnection(
    new RecordRing(new SharedArrayBuffer(64 + 4096), 8),
    replies,
    { root: gpu },
    credit, { access: serviceAccess() },
  );
  connection.replay.handles.reserve(h(3), "device");
  connection.replay.handles.bind(h(3), "device", { kind: "native", value: device });
  return { connection, credit, replies };
}
