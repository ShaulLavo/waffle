import { WireReader } from "../../../browser/gpu/codec.js";
import { nativeCall, nativeObject } from "../../../browser/gpu/lowering.js";
import type { GpuConnection } from "../../../browser/gpu/scheduler.js";
import type { ObjectKind } from "../../../browser/gpu/handles.js";
import type { RecordRing } from "../../../browser/gpu/ring.js";
import { blob, call, create, encoded, h, publish } from "./bundle-query-fixture.js";

export function bind(connection: GpuConnection, id: number, kind: ObjectKind, value: object): void {
  connection.replay.handles.reserve(h(id), kind);
  connection.replay.handles.bind(h(id), kind, { kind: "native", value });
}
export function submit(
  connection: GpuConnection,
  records: readonly Uint8Array[],
  encoder = 20,
): void {
  create(connection, "command_encoder", encoder, null);
  publish(
    connection,
    blob(
      0x1001,
      encoder,
      records.concat([
        encoded("command_encoder.finish", { result: h(encoder + 2), descriptor: null }),
      ]),
    ),
  );
  call(connection, "queue.submit", { receiver: h(4), commands: [h(encoder + 2)] });
}
export function replies(ring: RecordRing, rejectExceptions = false): number[] {
  const result: number[] = [];
  const bytes = new Uint8Array(ring.capacity);
  for (let i = 0; i < 100; i++) {
    const entry = ring.readInto(bytes);
    if (entry.kind !== "record") return result;
    const kind = new DataView(bytes.buffer).getUint16(0, true);
    if (kind === 8 && rejectExceptions) {
      const reader = new WireReader(bytes.subarray(0, entry.bytes), 16);
      throw new Error(`Native call exception at opcode ${reader.u32()}: ${reader.type("string")}`);
    }
    result.push(kind);
  }
  throw new Error("Copy/draw reply bound exceeded");
}
export async function readback(
  device: object,
  source: object,
  size: number,
  texture = false,
): Promise<number[]> {
  const buffer = nativeObject(nativeCall(device, "createBuffer", [{ size, usage: 9 }]));
  try {
    const encoder = nativeObject(nativeCall(device, "createCommandEncoder", []));
    if (texture)
      nativeCall(encoder, "copyTextureToBuffer", [
        { texture: source },
        { buffer, bytesPerRow: 256 },
        [4, 4, 1],
      ]);
    else nativeCall(encoder, "copyBufferToBuffer", [source, 0, buffer, 0, size]);
    nativeCall(nativeObject(Reflect.get(device, "queue")), "submit", [
      [nativeCall(encoder, "finish", [])],
    ]);
    await nativeCall(buffer, "mapAsync", [1]);
    const range: unknown = nativeCall(buffer, "getMappedRange", []);
    if (!(range instanceof ArrayBuffer)) throw new Error("Trusted readback returned no bytes");
    return Array.from(new Uint8Array(range));
  } finally {
    nativeCall(buffer, "destroy", []);
  }
}
export function assertBytes(
  actual: readonly number[],
  expected: readonly number[],
  control: string,
): void {
  const index = actual.findIndex((byte, i) => byte !== expected[i]);
  if (actual.length !== expected.length || index !== -1)
    throw new Error(
      `${control} readback differs at ${index}: ${actual[index]} versus ${expected[index]}`,
    );
}
