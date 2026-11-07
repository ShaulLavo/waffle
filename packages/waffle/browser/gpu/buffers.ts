import { safeGpuNumber, wireArray, wireBytes, wireObject, type WireObject } from "./codec.js";
import { gpuWholeMapSize, gpuStream } from "./generated/tables.js";
import { nativeCall } from "./lowering.js";
import type { CompletionOwner } from "./completions.js";
import { GpuCallError, GpuProtocolError, GpuResourceError } from "./protocol.js";

type Mode = "read" | "write";
type MapState =
  | { kind: "unmapped" | "destroyed" | "released" }
  | { kind: "pending"; epoch: number }
  | {
      kind: "mapped";
      epoch: number;
      mode: Mode;
      offset: number;
      length: number;
      view: Uint8Array | undefined;
    };
interface BufferRecord {
  readonly native: object;
  readonly device: object;
  readonly size: number;
  readonly originalUsage: bigint;
  state: MapState;
  epoch: number;
}
interface MapOperation {
  readonly record: BufferRecord;
  readonly epoch: number | undefined;
  readonly mode: number;
  readonly offset: number;
  readonly size: number | undefined;
  readonly token: number;
}
/** Native identities remain in HandleTable. Aliases share one mapping lifetime. */
export class BufferMaps {
  readonly #records = new Map<object, BufferRecord>();
  readonly #devices = new Map<object, Set<BufferRecord>>();
  register(native: object, device: object, descriptor: WireObject): void {
    if (this.#records.has(native)) return;
    const size = integer(descriptor.size);
    if (typeof descriptor.usage !== "bigint")
      throw new GpuProtocolError("Invalid original buffer usage");
    const record: BufferRecord = {
      native,
      device,
      size,
      originalUsage: descriptor.usage,
      epoch: 0,
      state:
        descriptor.mapped_at_creation === true
          ? { kind: "mapped", epoch: 0, mode: "write", offset: 0, length: size, view: undefined }
          : { kind: "unmapped" },
    };
    this.#records.set(native, record);
    let records = this.#devices.get(device);
    if (!records) {
      records = new Set();
      this.#devices.set(device, records);
    }
    records.add(record);
  }
  map(native: object, fields: WireObject, owner: CompletionOwner): void {
    const record = this.#record(native);
    const offset = integer(fields.offset);
    const size = fields.size === gpuWholeMapSize ? undefined : integer(fields.size);
    const mode = integer(fields.mode);
    const token = typeof fields.token === "number" ? fields.token : invalidMap();
    const op: MapOperation = {
      record,
      epoch: record.state.kind === "unmapped" ? nextEpoch(record) : undefined,
      mode,
      offset,
      size,
      token,
    };
    owner.start(
      token,
      () => {
        if (op.epoch !== undefined) record.state = { kind: "pending", epoch: op.epoch };
        return Promise.resolve(
          nativeCall(
            native,
            "mapAsync",
            size === undefined ? [mode, offset] : [mode, offset, size],
          ),
        );
      },
      (sink) => mapSuccess(sink, op),
      (sink, error) => mapFailure(sink, op, error),
      ignore,
    );
  }
  unmap(native: object): void {
    const record = this.#record(native);
    nativeCall(native, "unmap", []);
    record.state = { kind: "unmapped" };
  }
  writes(native: object, value: WireObject): void {
    const record = this.#record(native);
    const ranges = wireArray(value.ranges).map((range) => {
      const fields = wireObject(range);
      return { offset: integer(fields.offset), data: wireBytes(fields.data) };
    });
    const state = record.state;
    if (ranges.length && (state.kind !== "mapped" || state.mode !== "write"))
      throw new GpuProtocolError("Writes require an active native write mapping");
    if (state.kind !== "mapped") {
      this.unmap(native);
      return;
    }
    let end = state.offset;
    for (const range of ranges) {
      if (
        range.offset % 8 ||
        range.data.byteLength % 4 ||
        range.offset < end ||
        range.offset < state.offset ||
        range.offset - state.offset > state.length ||
        range.data.byteLength > state.length - (range.offset - state.offset)
      )
        throw new GpuProtocolError("Invalid complete mapped write ranges");
      end = range.offset + range.data.byteLength;
    }
    if (ranges.length) {
      const view = mappedView(record, state);
      for (const range of ranges) view.set(range.data, range.offset - state.offset);
    }
    nativeCall(native, "unmap", []);
    record.state = { kind: "unmapped" };
  }
  destroyed(native: object): void {
    this.#record(native).state = { kind: "destroyed" };
  }
  deviceDestroyed(device: object): void {
    for (const record of this.#devices.get(device) ?? []) record.state = { kind: "unmapped" };
  }
  release(native: object): void {
    const record = this.#records.get(native);
    if (!record) return;
    try {
      if (record.state.kind === "mapped" || record.state.kind === "pending")
        nativeCall(native, "unmap", []);
    } finally {
      record.state = { kind: "released" };
      this.#records.delete(native);
      const records = this.#devices.get(record.device);
      records?.delete(record);
      if (records?.size === 0) this.#devices.delete(record.device);
    }
  }
  dispose(): void {
    for (const record of this.#records.values()) record.state = { kind: "released" };
    this.#records.clear();
    this.#devices.clear();
  }
  snapshot() {
    return {
      records: this.#records.size,
      views: Array.from(this.#records.values()).filter(
        (record) => record.state.kind === "mapped" && record.state.view !== undefined,
      ).length,
    };
  }
  #record(native: object): BufferRecord {
    const record = this.#records.get(native);
    if (!record) throw new GpuProtocolError("Unknown native buffer identity");
    return record;
  }
}
function integer(value: unknown): number {
  if (typeof value !== "bigint") throw new GpuProtocolError("Invalid buffer integer");
  return safeGpuNumber(value);
}
function invalidMap(): never {
  throw new GpuProtocolError("Invalid map token");
}
function nextEpoch(record: BufferRecord): number {
  if (record.epoch === Number.MAX_SAFE_INTEGER) throw new GpuResourceError("Map epochs exhausted");
  return ++record.epoch;
}
function current(op: MapOperation): boolean {
  return (
    op.epoch !== undefined &&
    op.record.state.kind === "pending" &&
    op.record.state.epoch === op.epoch
  );
}
function mappedView(
  record: BufferRecord,
  state: Extract<MapState, { kind: "mapped" }>,
): Uint8Array {
  if (state.view) return state.view;
  const range = nativeCall(record.native, "getMappedRange", [state.offset, state.length]);
  if (!(range instanceof ArrayBuffer) || range.byteLength !== state.length)
    throw new GpuCallError("Native mapped range has incorrect length");
  return (state.view = new Uint8Array(range));
}
function mapSuccess(owner: CompletionOwner, op: MapOperation): void {
  if (!current(op)) {
    mapResult(owner, op, "aborted", "Mapping was canceled");
    return;
  }
  const { record, offset, mode } = op;
  const length = op.size ?? record.size - offset;
  if (
    (mode !== 1 && mode !== 2) ||
    offset > record.size ||
    length < 0 ||
    length > record.size - offset
  )
    throw new GpuCallError("Invalid successful native map result");
  const state: Extract<MapState, { kind: "mapped" }> = {
    kind: "mapped",
    epoch: op.epoch ?? invalidMap(),
    mode: mode === 1 ? "read" : "write",
    offset,
    length,
    view: undefined,
  };
  record.state = state;
  let handle;
  try {
    handle = owner.fillPayload(length, (destination) => destination.set(mappedView(record, state)));
  } catch (error) {
    if (!(error instanceof GpuCallError)) throw error;
    owner.publish("map-result", op.token, -28, {
      status: gpuStream.enums["enum.map_async_status"].error,
      message: error.message,
      payload: null,
      length: 0,
    });
    return;
  }
  if (!handle) return;
  owner.publish("map-result", op.token, 0, {
    status: gpuStream.enums["enum.map_async_status"].success,
    message: "",
    payload: { ...handle },
    length,
  });
}
function mapFailure(owner: CompletionOwner, op: MapOperation, error: unknown): void {
  if (!current(op) && op.epoch !== undefined) {
    mapResult(owner, op, "aborted", "Mapping was canceled");
    return;
  }
  if (current(op)) op.record.state = { kind: "unmapped" };
  mapResult(
    owner,
    op,
    error instanceof DOMException && error.name === "AbortError" ? "aborted" : "error",
    message(error),
  );
}
function mapResult(
  owner: CompletionOwner,
  op: MapOperation,
  status: "aborted" | "error",
  message: string,
): void {
  owner.publish("map-result", op.token, 0, {
    status: gpuStream.enums["enum.map_async_status"][status],
    message,
    payload: null,
    length: 0,
  });
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Native map failed";
}
function ignore(): void {}
