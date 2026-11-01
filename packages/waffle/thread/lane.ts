import { readWaitRegistration, type CapturedWaitRegistration } from "../interrupt/wait.ts";
import type { FileStat } from "../core/filesystem.ts";
import {
  atomicsLoad,
  atomicsStore,
  atomicsNotify,
  atomicsWait,
  Int32ArrayConstructor,
  DataViewConstructor,
  dataViewGetBigUint64,
  dataViewSetBigUint64,
  reflectApply,
  sharedArrayBufferByteLength,
  isSharedArrayBuffer,
  wasmMemoryBuffer,
} from "../proc/intrinsics.ts";
import type { CallKey, ThreadKey, ThreadOperation, ThreadResult } from "./protocol.ts";

const post = MessagePort.prototype.postMessage;
const closePort = MessagePort.prototype.close;
const listen = EventTarget.prototype.addEventListener;
const unlisten = EventTarget.prototype.removeEventListener;
const startPort = MessagePort.prototype.start;
const safeInteger = Number.isSafeInteger;
const number = Number;
const bigint = BigInt;
const signedBigInt = BigInt.asIntN;
const floor = Math.floor;
const MAX_SEQUENCE = 0x7fffffff;
export const THREAD_LANE_BYTES = 64;
export type ThreadRequest = ThreadOperation | { kind: "spawn"; startArg: number };
export interface ThreadLaneTransfer {
  readonly port: MessagePort;
  readonly reply: SharedArrayBuffer;
}
interface LaneMessage {
  sequence: number;
  request: ThreadRequest;
}

/** The aggregate owner admits/counts the call before dispatch and settles it after completion. */
export interface ThreadDispatcher {
  dispatch(call: CallKey, request: ThreadRequest): Promise<ThreadResult>;
}

function cells(reply: SharedArrayBuffer): Int32Array {
  if (!isSharedArrayBuffer(reply) || sharedArrayBufferByteLength(reply) !== THREAD_LANE_BYTES)
    throw new TypeError("thread lane requires private shared reply cells");
  return new Int32ArrayConstructor(reply);
}

/** Ports and reply backing are supplied by the owner, never constructed in a guest. */
export function createThreadLaneOwner(
  options: Readonly<{
    thread: ThreadKey;
    lane: ThreadLaneTransfer;
    dispatcher: ThreadDispatcher;
    terminal(): boolean;
    failed(cause: unknown): void;
  }>,
) {
  const { port, reply } = options.lane;
  const words = cells(reply);
  const view = new DataViewConstructor(reply);
  let sequence = 0;
  let phase: "open" | "retired" = "open";
  let pending: Promise<void> | undefined;

  function retire(): Promise<void> {
    if (phase === "retired") return pending ?? Promise.resolve();
    phase = "retired";
    atomicsStore(words, 1, 1);
    atomicsStore(words, 0, -1);
    atomicsNotify(words, 0);
    reflectApply(unlisten, port, ["message", receive]);
    reflectApply(closePort, port, []);
    return pending ?? Promise.resolve();
  }
  function fail(cause: unknown): void {
    void retire();
    options.failed(cause);
  }
  async function answer(message: LaneMessage): Promise<void> {
    try {
      const result = await options.dispatcher.dispatch(
        { thread: options.thread, sequence: message.sequence },
        message.request,
      );
      if (phase !== "open") return;
      if (options.terminal()) {
        void retire();
        return;
      }
      encodeResult(words, view, result);
      atomicsStore(words, 0, message.sequence);
      atomicsNotify(words, 0);
    } catch (error) {
      fail(error);
    }
  }
  function receive(event: MessageEvent<unknown>): void {
    if (phase !== "open") return;
    if (options.terminal()) {
      void retire();
      return;
    }
    const message = parseMessage(event.data);
    if (!message || message.sequence !== sequence + 1 || pending) {
      fail(new Error("invalid, stale or overlapping thread call"));
      return;
    }
    sequence = message.sequence;
    pending = answer(message).finally(() => {
      pending = undefined;
    });
  }
  reflectApply(listen, port, ["message", receive]);
  reflectApply(startPort, port, []);
  return { retire };
}

function parseMessage(value: unknown): LaneMessage | undefined {
  if (!value || typeof value !== "object" || !("sequence" in value) || !("request" in value))
    return;
  if (
    !safeInteger(value.sequence) ||
    number(value.sequence) < 1 ||
    number(value.sequence) > MAX_SEQUENCE
  )
    return;
  const request = parseRequest(value.request);
  if (request) return { sequence: number(value.sequence), request };
}
function unsigned(value: unknown): value is number {
  return typeof value === "number" && safeInteger(value) && value >= 0 && value <= 0xffffffff;
}
function parseRequest(value: unknown): ThreadRequest | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) return;
  if (value.kind === "spawn") {
    if ("startArg" in value && unsigned(value.startArg))
      return { kind: "spawn", startArg: value.startArg };
    return;
  }
  if (!("fd" in value) || !unsigned(value.fd)) return;
  const fd = value.fd;
  if (value.kind === "tell" || value.kind === "stat" || value.kind === "close")
    return { kind: value.kind, fd };
  if (value.kind === "seek") return parseSeek(value, fd);
  if (value.kind !== "read" && value.kind !== "write") return;
  if (!("spans" in value) || !Array.isArray(value.spans)) return;
  const spans: { address: number; length: number }[] = [];
  for (const span of value.spans) {
    if (!span || !unsigned(span.address) || !unsigned(span.length)) return;
    spans.push({ address: span.address, length: span.length });
  }
  const position = "position" in value ? value.position : undefined;
  if (
    position !== undefined &&
    (typeof position !== "number" || !safeInteger(position) || position < 0)
  )
    return;
  return { kind: value.kind, fd, spans, ...(position === undefined ? {} : { position }) };
}
function parseSeek(value: object, fd: number): ThreadOperation | undefined {
  if (!("offset" in value) || typeof value.offset !== "number" || !safeInteger(value.offset))
    return;
  if (
    !("whence" in value) ||
    (value.whence !== "set" && value.whence !== "current" && value.whence !== "end")
  )
    return;
  return { kind: "seek", fd, offset: value.offset, whence: value.whence };
}

const kinds: readonly FileStat["kind"][] = ["file", "directory", "socket", "symlink"];
function encodeResult(words: Int32Array, view: DataView, result: ThreadResult): void {
  atomicsStore(words, 2, result.kind === "error" ? result.errno : 0);
  if (result.kind === "error") return;
  if (typeof result.value === "number") {
    atomicsStore(words, 3, 0);
    storeNumber(view, 24, result.value);
    return;
  }
  const stat = result.value;
  atomicsStore(words, 3, 1);
  atomicsStore(words, 4, kinds.indexOf(stat.kind));
  atomicsStore(words, 5, stat.mode ?? -1);
  storeNumber(view, 24, stat.ino);
  storeNumber(view, 32, stat.nlink);
  storeNumber(view, 40, stat.size);
  dataViewSetBigUint64(view, 48, bigint(floor(stat.mtime * 1_000_000)), true);
}
function storeNumber(view: DataView, offset: number, value: number): void {
  if (!safeInteger(value) || value < 0) throw new RangeError("invalid thread service result");
  dataViewSetBigUint64(view, offset, bigint(value), true);
}
function readNumber(view: DataView, offset: number): number {
  return number(dataViewGetBigUint64(view, offset, true));
}
function decodeResult(words: Int32Array, view: DataView): ThreadResult {
  const errno = atomicsLoad(words, 2);
  if (errno) return { kind: "error", errno };
  if (atomicsLoad(words, 3) === 0) return { kind: "ok", value: readNumber(view, 24) };
  const kind = kinds[atomicsLoad(words, 4)];
  if (!kind) throw new Error("invalid thread stat reply");
  const mode = atomicsLoad(words, 5);
  return {
    kind: "ok",
    value: {
      kind,
      ino: readNumber(view, 24),
      nlink: readNumber(view, 32),
      size: readNumber(view, 40),
      mtime: number(signedBigInt(64, dataViewGetBigUint64(view, 48, true))) / 1_000_000,
      ...(mode === -1 ? {} : { mode }),
    },
  };
}

export class ThreadLane {
  private readonly words: Int32Array;
  private readonly view: DataView;
  private sequence = 0;
  private phase: "idle" | "calling" | "closed" = "idle";
  constructor(
    private readonly lane: ThreadLaneTransfer,
    private readonly checkTerminal: () => void,
  ) {
    this.words = cells(lane.reply);
    this.view = new DataViewConstructor(lane.reply);
  }
  check(): void {
    this.checkTerminal();
    if (this.phase === "closed" || atomicsLoad(this.words, 1))
      throw new Error("thread service lane is retired");
  }
  call(request: ThreadRequest): ThreadResult {
    this.check();
    if (this.phase !== "idle" || this.sequence === MAX_SEQUENCE)
      throw new Error("thread lane is busy or exhausted");
    const sequence = ++this.sequence;
    this.phase = "calling";
    try {
      reflectApply(post, this.lane.port, [{ sequence, request } satisfies LaneMessage]);
      this.wait(sequence);
      return decodeResult(this.words, this.view);
    } finally {
      if (this.phase === "calling") this.phase = "idle";
    }
  }
  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    reflectApply(closePort, this.lane.port, []);
  }
  private wait(sequence: number): void {
    for (;;) {
      const observed = atomicsLoad(this.words, 0);
      this.check();
      if (observed === sequence) return;
      atomicsWait(this.words, 0, observed);
    }
  }
}

export type ThreadWaitEvent =
  | { kind: "wait-registered"; thread: ThreadKey; registration: CapturedWaitRegistration }
  | { kind: "wait-cleared"; thread: ThreadKey; generation: number };

type OwnedWait =
  | { kind: "parked"; registration: CapturedWaitRegistration; release(): void }
  | { kind: "retained"; registration: CapturedWaitRegistration };

/** Bound to one private guest control route. Retention hooks belong to its aggregate lease. */
export class ThreadWaitOwner {
  private phase: "open" | "draining" | "idle" | "failed" = "open";
  private generation = 0;
  private active: OwnedWait | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: Readonly<{
      thread: ThreadKey;
      memory: WebAssembly.Memory;
      waits: Int32Array;
      terminal(): boolean;
      retain(registration: CapturedWaitRegistration): () => void;
      failed(cause: unknown): void;
    }>,
  ) {}

  receive(value: unknown): boolean {
    if (!value || typeof value !== "object" || !("kind" in value)) return false;
    if (!this.matches(value)) return false;
    if (value.kind === "host-idle") {
      this.idle();
      return true;
    }
    if (this.phase === "idle") return false;
    if (value.kind === "wait-cleared") {
      if (!("generation" in value) || !waitGeneration(value.generation)) return false;
      this.clear(value.generation);
      return true;
    }
    if (value.kind !== "wait-registered" || !("registration" in value)) return false;
    const registration = capturedWait(value.registration);
    if (!registration || registration.generation <= this.generation) return false;
    if (this.active) {
      this.fail(new Error("overlapping guest wait registration"));
      return false;
    }
    this.active = { kind: "retained", registration };
    this.generation = registration.generation;
    try {
      this.active = { kind: "parked", registration, release: this.options.retain(registration) };
    } catch (error) {
      this.fail(error);
    }
    if (this.options.terminal()) this.beginTerminal();
    return true;
  }

  beginTerminal(): void {
    if (this.phase === "idle" || !this.options.terminal()) return;
    this.wake();
    if (this.phase !== "open") return;
    this.phase = "draining";
    this.timer = setInterval(() => this.wake(), 10);
    this.deadline = setTimeout(() => {
      this.fail(new Error("guest wait did not reach host-idle before teardown deadline"));
    }, 1000);
  }

  fail(cause: unknown): void {
    this.stopTimers();
    if (this.phase === "idle" || this.phase === "failed") return;
    this.phase = "failed";
    this.options.failed(cause);
  }

  wake(): void {
    if (this.phase === "idle" || !this.options.terminal()) return;
    const current = readWaitRegistration(this.options.waits);
    if (!current) return;
    const buffer = wasmMemoryBuffer(this.options.memory);
    const parked = this.active?.registration;
    if (parked?.generation === current.generation) {
      notifyWait(parked.buffer, parked.address);
      if (parked.buffer === buffer) return;
    }
    notifyWait(buffer, current.address);
  }

  private matches(value: object): boolean {
    if (!("thread" in value) || !value.thread || typeof value.thread !== "object") return false;
    const thread = value.thread;
    return (
      "directory" in thread &&
      thread.directory === this.options.thread.directory &&
      "pid" in thread &&
      thread.pid === this.options.thread.pid &&
      "tid" in thread &&
      thread.tid === this.options.thread.tid
    );
  }

  private clear(generation: number): void {
    if (generation < this.generation) return;
    if (this.active && this.active.registration.generation !== generation) {
      this.fail(new Error("wait clear skipped the parked generation"));
      return;
    }
    this.generation = generation;
    this.releaseActive();
  }

  private idle(): void {
    if (this.phase === "idle") return;
    this.stopTimers();
    this.releaseActive();
    if (!this.active) this.phase = "idle";
  }

  private releaseActive(): void {
    const active = this.active;
    if (!active || active.kind === "retained") return;
    this.active = { kind: "retained", registration: active.registration };
    try {
      active.release();
      this.active = undefined;
    } catch (error) {
      this.fail(error);
    }
  }

  private stopTimers(): void {
    clearInterval(this.timer);
    clearTimeout(this.deadline);
    this.timer = undefined;
    this.deadline = undefined;
  }
}

function waitGeneration(value: unknown): value is number {
  return typeof value === "number" && safeInteger(value) && value > 0 && value <= MAX_SEQUENCE;
}
function capturedWait(value: unknown): CapturedWaitRegistration | undefined {
  if (!value || typeof value !== "object") return;
  if (!("generation" in value) || !waitGeneration(value.generation)) return;
  if (!("address" in value) || !unsigned(value.address)) return;
  if (!("width" in value) || (value.width !== 4 && value.width !== 8)) return;
  if (!("buffer" in value) || !isSharedArrayBuffer(value.buffer)) return;
  if (
    value.address % value.width ||
    value.address > sharedArrayBufferByteLength(value.buffer) - value.width
  )
    return;
  return {
    generation: value.generation,
    address: value.address,
    width: value.width,
    buffer: value.buffer,
  };
}
function notifyWait(buffer: ArrayBuffer | SharedArrayBuffer, address: number): void {
  if (!isSharedArrayBuffer(buffer) || address > sharedArrayBufferByteLength(buffer) - 4) return;
  atomicsNotify(new Int32ArrayConstructor(buffer), address / 4);
}
