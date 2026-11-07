import {
  validateFairnessObservation,
  wireCount,
  type ObservationExpectation,
} from "./fairness-validation.js";
import { GpuConnection } from "../../../browser/gpu/scheduler.js";
import { GpuReplay, type ReplayStep } from "../../../browser/gpu/replay.js";
import type { LogicalRecord } from "../../../browser/gpu/transport.js";

interface Cursor {
  readonly bytes: Uint8Array;
  top: number;
  nested: { at: number; end: number } | undefined;
}
interface Aggregate {
  count: number;
  totalMs: number;
  maxMs: number;
}
interface RecordLocation {
  readonly opcode: number;
  readonly length: number;
  readonly kind: "top" | "nested" | "boundary";
}
export interface FairnessSlice {
  readonly connection: number;
  readonly start: number;
  readonly end: number;
  readonly records: number;
  readonly draws: number;
  readonly nativeMs: number;
  readonly longestNativeMs: number;
  readonly firstRecord: number;
  readonly lastRecord: number;
  readonly bytes: number;
  readonly kind: string;
}
interface ConnectionTrace {
  readonly id: number;
  cursor: Cursor | undefined;
  records: number;
  draws: number;
  commandRingBytes: number;
  largeBlob: { bytes: number; draws: number; start: number; end: number | null } | undefined;
}
interface QueueCompletion {
  readonly connection: number;
  readonly start: number;
  settlement: { kind: "pending" } | { kind: "completed" | "rejected"; at: number };
}
export interface FairnessSnapshot {
  readonly at: number;
  readonly epoch: number;
  readonly armed: boolean;
  readonly overflow: boolean;
  readonly slices: readonly FairnessSlice[];
  readonly records: Readonly<Record<string, Aggregate>>;
  readonly native: Readonly<Record<string, Aggregate>>;
  readonly queue: readonly QueueCompletion[];
  readonly presents: readonly { connection: number; at: number; otherLargeDraws: number[] }[];
  readonly blobs: readonly {
    connection: number;
    commandRingBytes: number;
    bytes: number;
    draws: number;
    start: number;
    end: number | null;
  }[];
}
function location(cursor: Cursor): RecordLocation {
  const nested = cursor.nested;
  if (nested && nested.at === nested.end) return { opcode: 0x1001, length: 0, kind: "boundary" };
  const at = nested?.at ?? cursor.top;
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + at);
  return {
    opcode: view.getUint16(0, true),
    length: view.getUint32(4, true),
    kind: nested ? "nested" : "top",
  };
}
function aggregate(values: Record<string, Aggregate>, key: string, duration: number) {
  const item = (values[key] ??= { count: 0, totalMs: 0, maxMs: 0 });
  item.count++;
  item.totalMs += duration;
  item.maxMs = Math.max(item.maxMs, duration);
}

/** Observation only. It never changes a budget, command, native argument or replay result. */
export class FairnessObserver {
  #epoch = 0;
  #armed = false;
  #overflow = false;
  #traces: ConnectionTrace[] = [];
  #connections = new WeakMap<GpuReplay, ConnectionTrace>();
  #slices: FairnessSlice[] = [];
  #blobs: {
    connection: number;
    commandRingBytes: number;
    blob: NonNullable<ConnectionTrace["largeBlob"]>;
  }[] = [];
  #records: Record<string, Aggregate> = {};
  #native: Record<string, Aggregate> = {};
  #queue: QueueCompletion[] = [];
  #pending: Promise<void>[] = [];
  #presents: { connection: number; at: number; otherLargeDraws: number[] }[] = [];
  #active:
    | {
        trace: ConnectionTrace;
        records: number;
        draws: number;
        nativeMs: number;
        longestNativeMs: number;
      }
    | undefined;
  constructor(
    readonly now: () => number = () => performance.now(),
    readonly limit = 8192,
    readonly blobThreshold = 4 * 1024 * 1024,
  ) {}
  trace(replay: GpuReplay): ConnectionTrace {
    const found = this.#connections.get(replay);
    if (found) return found;
    const trace: ConnectionTrace = {
      id: this.#traces.length + 1,
      cursor: undefined,
      records: 0,
      draws: 0,
      commandRingBytes: 0,
      largeBlob: undefined,
    };
    this.#connections.set(replay, trace);
    this.#traces.push(trace);
    return trace;
  }
  accept(replay: GpuReplay, record: LogicalRecord): void {
    this.trace(replay).cursor = { bytes: record.bytes, top: 0, nested: undefined };
  }
  step(replay: GpuReplay, action: () => ReplayStep): ReplayStep {
    const trace = this.trace(replay),
      cursor = trace.cursor;
    const record = cursor ? location(cursor) : undefined;
    const start = this.now();
    const result = action();
    const end = this.now();
    if (!cursor || !record || result.kind !== "progress") return result;
    this.#progress(trace, cursor, record, end - start, end, result.presented);
    return result;
  }
  #progress(
    trace: ConnectionTrace,
    cursor: Cursor,
    record: RecordLocation,
    duration: number,
    end: number,
    presented: boolean,
  ) {
    if (record.kind !== "boundary") {
      trace.records++;
      aggregate(this.#records, `${trace.id}:${record.kind}:${record.opcode}`, duration);
    }
    if (record.kind === "nested" && record.opcode === 14) {
      trace.draws++;
      if (trace.largeBlob) trace.largeBlob.draws++;
    }
    if (presented) this.#present(trace, end);
    this.#advance(trace, cursor, record, end);
  }
  #present(trace: ConnectionTrace, at: number) {
    if (this.#presents.length >= this.limit) {
      this.#overflow = true;
      return;
    }
    this.#presents.push({
      connection: trace.id,
      at,
      otherLargeDraws: this.#traces
        .filter((item) => item !== trace && item.largeBlob?.end === null)
        .map((item) => item.largeBlob!.draws),
    });
  }
  #advance(trace: ConnectionTrace, cursor: Cursor, record: RecordLocation, end: number) {
    if (record.kind === "top" && record.opcode === 0x1001) {
      const size = new DataView(
        cursor.bytes.buffer,
        cursor.bytes.byteOffset + cursor.top,
      ).getUint32(16, true);
      cursor.nested = { at: cursor.top + 20, end: cursor.top + 20 + size };
      if (record.length > this.blobThreshold) this.#beginLarge(trace, record.length, end);
      return;
    }
    if (record.kind === "nested" && cursor.nested) {
      cursor.nested.at += record.length;
      return;
    }
    if (record.kind === "boundary") {
      cursor.nested = undefined;
      if (trace.largeBlob?.end === null) trace.largeBlob.end = end;
      cursor.top += new DataView(
        cursor.bytes.buffer,
        cursor.bytes.byteOffset + cursor.top,
      ).getUint32(4, true);
    } else cursor.top += record.length;
    if (cursor.top === cursor.bytes.length) trace.cursor = undefined;
  }
  #beginLarge(trace: ConnectionTrace, bytes: number, start: number) {
    trace.largeBlob = { bytes, draws: 0, start, end: null };
    if (this.#blobs.length >= this.limit) {
      this.#overflow = true;
      return;
    }
    this.#blobs.push({
      connection: trace.id,
      commandRingBytes: trace.commandRingBytes,
      blob: trace.largeBlob,
    });
  }
  slice<T extends { bytes: number; kind: string }>(connection: GpuConnection, action: () => T): T {
    const trace = this.trace(connection.replay),
      start = this.now();
    trace.commandRingBytes = connection.commands.capacity;
    const active = (this.#active = {
      trace,
      records: trace.records,
      draws: trace.draws,
      nativeMs: 0,
      longestNativeMs: 0,
    });
    try {
      const result = action();
      const end = this.now();
      if (trace.records === active.records && result.bytes === 0) return result;
      if (this.#slices.length >= this.limit) {
        this.#overflow = true;
        return result;
      }
      this.#slices.push({
        connection: trace.id,
        start,
        end,
        records: trace.records - active.records,
        draws: trace.draws - active.draws,
        nativeMs: active.nativeMs,
        longestNativeMs: active.longestNativeMs,
        firstRecord: active.records + 1,
        lastRecord: trace.records,
        bytes: result.bytes,
        kind: result.kind,
      });
      return result;
    } finally {
      this.#active = undefined;
    }
  }
  native<T>(name: string, action: () => T): T {
    const start = this.now();
    try {
      return action();
    } finally {
      const duration = this.now() - start;
      aggregate(this.#native, `${this.#active?.trace.id ?? 0}:${name}`, duration);
      if (this.#active) {
        this.#active.nativeMs += duration;
        this.#active.longestNativeMs = Math.max(this.#active.longestNativeMs, duration);
      }
    }
  }
  queueCompletion(action: () => unknown): void {
    if (this.#queue.length >= this.limit) {
      this.#overflow = true;
      return;
    }
    const sample: QueueCompletion = {
      connection: this.#active?.trace.id ?? 0,
      start: this.now(),
      settlement: { kind: "pending" },
    };
    this.#queue.push(sample);
    try {
      const completion: unknown = action();
      if (!(completion instanceof Promise))
        throw new Error("Native queue returned no completion promise");
      const pending = completion.then(
        () => {
          sample.settlement = { kind: "completed", at: this.now() };
        },
        () => {
          sample.settlement = { kind: "rejected", at: this.now() };
        },
      );
      this.#pending.push(pending);
    } catch {
      sample.settlement = { kind: "rejected", at: this.now() };
    }
  }
  async settled(): Promise<FairnessSnapshot> {
    await Promise.all(this.#pending);
    return this.snapshot();
  }
  arm(): FairnessSnapshot {
    const baseline = this.snapshot();
    if (
      !baseline.slices.some((slice) => slice.draws > 0) ||
      !baseline.presents.length ||
      !baseline.queue.length ||
      baseline.queue.some((sample) => sample.settlement.kind !== "completed") ||
      !baseline.slices.some(
        (slice) =>
          ["draw", "finish", "submit", "transferToImageBitmap", "transferFromImageBitmap"].every(
            (name) => (baseline.native[`${slice.connection}:${name}`]?.count ?? 0) > 0,
          ) && baseline.queue.some((sample) => sample.connection === slice.connection),
      ) ||
      baseline.overflow
    )
      throw new Error("Fairness observer positive coverage did not arm in this service realm");
    if (this.#traces.some((trace) => trace.cursor))
      throw new Error("Fairness observer armed during replay");
    this.#epoch++;
    this.#armed = true;
    this.#traces = [];
    this.#connections = new WeakMap();
    this.#slices = [];
    this.#blobs = [];
    this.#records = {};
    this.#native = {};
    this.#presents = [];
    this.#queue = [];
    this.#pending = [];
    return baseline;
  }
  snapshot(): FairnessSnapshot {
    return {
      at: this.now(),
      epoch: this.#epoch,
      armed: this.#armed,
      overflow: this.#overflow,
      slices: this.#slices.slice(),
      records: structuredClone(this.#records),
      native: structuredClone(this.#native),
      queue: structuredClone(this.#queue),
      presents: structuredClone(this.#presents),
      blobs: this.#blobs.map(({ connection, commandRingBytes, blob }) => ({
        connection,
        commandRingBytes,
        ...blob,
      })),
    };
  }
}

/** Test worker only; production modules are unchanged and arguments/results pass through. */
export interface FairnessInstrumentation {
  readonly caps: "on" | "off";
  readonly blobThreshold: number;
}
export function installFairnessObserver(options?: FairnessInstrumentation): FairnessObserver {
  const observer = new FairnessObserver(undefined, undefined, options?.blobThreshold);
  const accept = GpuReplay.prototype.accept,
    step = GpuReplay.prototype.step,
    slice = GpuConnection.prototype.slice;
  GpuReplay.prototype.accept = function (record) {
    accept.call(this, record);
    observer.accept(this, record);
  };
  GpuReplay.prototype.step = function () {
    return observer.step(this, () => step.call(this));
  };
  GpuConnection.prototype.slice = function (budget) {
    const activeBudget =
      options?.caps === "off"
        ? {
            bytes: Number.MAX_SAFE_INTEGER,
            milliseconds: Number.MAX_VALUE,
            now: () => performance.now(),
          }
        : budget;
    return observer.slice(this, () => slice.call(this, activeBudget));
  };
  observeNative(observer, "GPURenderPassEncoder", "draw");
  observeNative(observer, "GPUCommandEncoder", "finish");
  observeNative(observer, "GPUQueue", "submit");
  observeNative(observer, "OffscreenCanvas", "transferToImageBitmap");
  observeNative(observer, "ImageBitmapRenderingContext", "transferFromImageBitmap");
  return observer;
}
function observeNative(observer: FairnessObserver, constructor: string, name: string) {
  const ctor: unknown = Reflect.get(globalThis, constructor);
  if (typeof ctor !== "function") return;
  const prototype: unknown = Reflect.get(ctor, "prototype");
  if (!prototype || typeof prototype !== "object") return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name),
    original: unknown = descriptor?.value;
  if (typeof original !== "function") return;
  const done: unknown =
    name === "submit" ? Reflect.get(prototype, "onSubmittedWorkDone") : undefined;
  Object.defineProperty(prototype, name, {
    ...descriptor,
    value: function (this: object, ...args: unknown[]) {
      const result = observer.native(name, () => Reflect.apply(original, this, args));
      if (typeof done === "function") observer.queueCompletion(() => Reflect.apply(done, this, []));
      return result;
    },
  });
}

export function fairnessMeasurements(
  snapshot: FairnessSnapshot,
  expected: Omit<ObservationExpectation, "phase"> & { readonly peerFrames: number },
) {
  const totals = validateFairnessObservation(snapshot, { ...expected, phase: "complete" });
  if (!snapshot.armed || snapshot.epoch < 1 || snapshot.overflow)
    throw new Error("Missing armed, bounded fairness observation epoch");
  const [blob] = snapshot.blobs;
  if (
    snapshot.blobs.length !== 1 ||
    !blob ||
    blob.draws !== 200000 ||
    blob.commandRingBytes !== 4 * 1024 * 1024 ||
    blob.bytes <= blob.commandRingBytes ||
    blob.end === null
  )
    throw new Error("Expected one completed 200000-draw logical blob larger than its ring");
  const peerIds = expected.connections.filter((id) => id !== blob.connection);
  if (
    peerIds.length !== 1 ||
    expected.peerFrames !== 128 ||
    wireCount(snapshot, blob.connection, 6) !== 1 ||
    wireCount(snapshot, peerIds[0]!, 6) !== expected.peerFrames ||
    totals.get(blob.connection)?.records !== 200023 ||
    totals.get(peerIds[0]!)?.records !== 7 + 20 * expected.peerFrames
  )
    throw new Error("Incomplete compiled large-blob or peer workload observations");
  const slices = snapshot.slices.filter(
    (slice) =>
      slice.connection === blob.connection && slice.end >= blob.start && slice.start <= blob.end!,
  );
  const drawn = slices.reduce((count, slice) => count + slice.draws, 0);
  const drawSlices = slices.filter((slice) => slice.draws > 0);
  if (drawn !== 200000 || drawSlices.length < 10)
    throw new Error("Large logical blob did not resume per record across many replay slices");
  const interleaved = snapshot.presents.filter((present) =>
    present.otherLargeDraws.some((draws) => draws > 0 && draws < 200000),
  );
  if (interleaved.length < 2)
    throw new Error("Peer did not keep presenting inside the large blob's replay interval");
  const heavyPresent = snapshot.presents.find((present) => present.connection === blob.connection);
  if (!heavyPresent) throw new Error("Large blob guest never presented its real frame");
  const peer = snapshot.presents.filter((present) => present.connection !== blob.connection);
  const before = peer.findLastIndex((present) => present.at <= blob.start);
  const after = peer.findIndex((present) => present.at >= heavyPresent.at);
  if (before < 0 || after < before)
    throw new Error("Peer presentations do not bracket the heavy workload");
  const gaps = peer.slice(before + 1, after + 1).map((present, index) => ({
    start: peer[before + index]!.at,
    end: present.at,
    ms: present.at - peer[before + index]!.at,
  }));
  const sliceDurations = slices.map((slice) => slice.end - slice.start);
  const oversize = snapshot.slices
    .filter((slice) => slice.end - slice.start > 8)
    .map((slice) => ({
      ...slice,
      ms: slice.end - slice.start,
      outsideLongestNativeMs: slice.end - slice.start - slice.longestNativeMs,
      classification:
        slice.end - slice.start - slice.longestNativeMs <= 8
          ? "indivisible-browser-call"
          : "replay-or-service-thread-pause",
    }));
  return {
    logicalBytes: blob.bytes,
    commandRingBytes: blob.commandRingBytes,
    draws: drawn,
    replaySlices: slices.length,
    drawSlices: drawSlices.length,
    peerPresentsDuringReplay: interleaved.length,
    replaySpanMs: blob.end - blob.start,
    maxBlobSliceMs: Math.max(...sliceDurations),
    maxSliceMs: Math.max(...snapshot.slices.map((slice) => slice.end - slice.start)),
    maxPeerGapMs: Math.max(0, ...gaps.map((gap) => gap.ms)),
    targets: { sliceMs: 8, peerGapMs: 100 },
    targetStatus: oversize.length === 0 && gaps.every((gap) => gap.ms <= 100) ? "met" : "not-met",
    sliceTargetMet: oversize.length === 0,
    peerGapTargetMet: gaps.every((gap) => gap.ms <= 100),
    oversize,
    gaps: gaps.map((gap) => ({
      ...gap,
      overlappingNativeQueueIntervals: snapshot.queue.filter(
        (queue) =>
          queue.start <= gap.end &&
          queue.settlement.kind !== "pending" &&
          queue.settlement.at >= gap.start,
      ).length,
    })),
    nativeCalls: snapshot.native,
    queueCompletionIntervals: snapshot.queue.map((sample) => ({
      ...sample,
      ms: sample.settlement.kind === "pending" ? null : sample.settlement.at - sample.start,
    })),
    queueExecutionMeasured: false,
    queueCompletionMeasured:
      snapshot.queue.length > 0 &&
      snapshot.queue.every((sample) => sample.settlement.kind === "completed"),
  };
}
