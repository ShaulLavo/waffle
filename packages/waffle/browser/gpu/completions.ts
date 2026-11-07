import { PayloadDirectory } from "./payload.js";
import { gpuPayloadLayout } from "./generated/tables.js";
import { completionBytes, type WireObject } from "./codec.js";
import type { RecordRing, RingWriter } from "./ring.js";
import {
  GPU_LIMITS,
  GPU_TERMINAL,
  GpuProtocolError,
  GpuCallError,
  GpuResourceError,
  type ConnectionState,
  type Handle,
} from "./protocol.js";

interface Pending<T> {
  owner: CompletionOwner | undefined;
  settle: ((owner: CompletionOwner, value: T) => void) | undefined;
  reject: ((owner: CompletionOwner, error: unknown) => void) | undefined;
  readonly abandon: (value: T) => void;
}
interface Payload {
  readonly generation: number;
  readonly offset: number;
  readonly length: number;
}
interface CompletionBuffers {
  readonly commands: RecordRing;
  readonly replies: RecordRing;
  readonly arena?: Uint8Array;
}
interface Ready {
  readonly kind: "ready";
  readonly commands: RecordRing;
  readonly replies: RecordRing;
  readonly pending: Map<number, { cancel(): void }>;
  readonly arena: Uint8Array;
  readonly directory: PayloadDirectory | undefined;
  readonly payloads: (Payload | undefined)[];
  readonly generations: number[];
  retire: (() => void) | undefined;
}

/** Service realm owner. Retiring replaces the entire ring/arena-bearing state. */
export class CompletionOwner {
  #state: Ready | { readonly kind: "terminal"; readonly reason: number };
  #lastToken = 0;
  constructor({ commands, replies, arena = new Uint8Array(0) }: CompletionBuffers) {
    if (commands.recordHeaderBytes !== 8 || replies.recordHeaderBytes !== 16)
      throw new RangeError("Expected command and completion rings");
    this.#state = {
      kind: "ready",
      commands,
      replies,
      pending: new Map(),
      arena,
      directory:
        arena.buffer instanceof SharedArrayBuffer &&
        arena.byteLength === gpuPayloadLayout.byteLength
          ? new PayloadDirectory(arena.buffer)
          : undefined,
      payloads: Array.from({ length: 64 }, () => undefined),
      generations: Array.from({ length: 64 }, () => 0),
      retire: undefined,
    };
  }
  get state(): ConnectionState {
    this.#synchronize();
    return this.#state.kind === "ready" ? { kind: "ready" } : this.#state;
  }
  get pendingCount(): number {
    this.#synchronize();
    return this.#state.kind === "ready" ? this.#state.pending.size : 0;
  }
  get payloadBytes(): number {
    this.#synchronize();
    return this.#state.kind === "ready"
      ? this.#state.payloads.reduce((sum, slot) => sum + (slot?.length ?? 0), 0)
      : 0;
  }
  onRetire(retire: () => void): void {
    this.#synchronize();
    if (this.#state.kind === "terminal") {
      retire();
      return;
    }
    if (this.#state.retire) throw new Error("Completion owner already has retirement cleanup");
    this.#state.retire = retire;
  }
  admit(token: number): void {
    this.#synchronize();
    if (this.#state.kind === "terminal") throw new GpuProtocolError("Terminal completion owner");
    if (!Number.isInteger(token) || token <= this.#lastToken || token > 0xffffffff)
      throw new GpuProtocolError("Tokens must strictly increase without wrapping");
    this.#lastToken = token;
  }
  publish(name: string, token: number, status: number, value: WireObject): boolean {
    this.#synchronize();
    const state = this.#state;
    if (state.kind === "terminal") return false;
    try {
      return this.#publish(
        state,
        completionBytes(name, token, status, value, state.replies.capacity),
      );
    } catch (error) {
      this.terminate(
        error instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol,
      );
      return false;
    }
  }
  /** Admit before starting native work. No continuation retains a retired replay or transport. */
  start<T>(
    token: number,
    start: () => Promise<T>,
    settle: (owner: CompletionOwner, value: T) => void,
    reject: (owner: CompletionOwner, error: unknown) => void,
    abandon: (value: T) => void,
  ): void {
    this.admit(token);
    const state = this.#state;
    if (state.kind === "terminal") return;
    if (state.pending.size >= GPU_LIMITS.pending) {
      this.terminate(GPU_TERMINAL.resource);
      return;
    }
    const pending: Pending<T> = { owner: this, settle, reject, abandon };
    state.pending.set(token, { cancel: () => detach(pending) });
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      fail(pending, token, error);
      return;
    }
    watchPromise(promise, pending, token);
  }
  settled(token: number): boolean {
    this.#synchronize();
    if (this.#state.kind === "terminal") return false;
    return this.#state.pending.delete(token);
  }
  allocatePayload(bytes: Uint8Array): Handle | undefined {
    return this.fillPayload(bytes.byteLength, (destination) => destination.set(bytes));
  }
  fillPayload(length: number, fill: (destination: Uint8Array) => void): Handle | undefined {
    this.#synchronize();
    const state = this.#state;
    if (state.kind === "terminal") return;
    try {
      return this.#allocatePayload(state, length, fill);
    } catch (error) {
      if (error instanceof GpuCallError) throw error;
      this.terminate(GPU_TERMINAL.resource);
      return;
    }
  }
  takePayload(handle: Handle, destination: Uint8Array): number {
    this.#synchronize();
    const state = this.#state;
    if (state.kind === "terminal") throw new GpuCallClosed();
    if (state.directory) {
      const result = state.directory.copyOnce(
        handle,
        destination,
        () => state.commands.terminal()?.reason,
        (reason) => {
          this.terminate(reason);
          return state.commands.terminal()?.reason ?? reason;
        },
      );
      if (result !== 0) throw new GpuProtocolError(`Payload copy failed: ${result}`);
      return state.payloads[handle.id - 1]?.length ?? 0;
    }
    const slot = state.payloads[handle.id - 1];
    if (!slot || slot.generation !== handle.generation)
      throw new GpuProtocolError("Stale payload handle");
    if (destination.byteLength < slot.length)
      throw new GpuResourceError("Short payload destination");
    destination.set(state.arena.subarray(slot.offset, slot.offset + slot.length));
    state.payloads[handle.id - 1] = undefined;
    return slot.length;
  }
  terminate(reason: number): void {
    const state = this.#state;
    if (state.kind === "terminal") return;
    if (!Number.isInteger(reason) || reason <= 0 || reason > 0xffffffff)
      throw new RangeError("Invalid terminal reason");
    const selected = state.commands.terminate(reason).reason;
    this.#state = { kind: "terminal", reason: selected };
    state.directory?.mirror(selected);
    publishClosed(state.replies, selected);
    state.replies.terminate(selected);
    for (const pending of state.pending.values()) pending.cancel();
    state.pending.clear();
    state.payloads.length = 0;
    state.generations.length = 0;
    const retire = state.retire;
    state.retire = undefined;
    retire?.();
  }
  #synchronize(): void {
    if (this.#state.kind === "terminal") return;
    const terminal = this.#state.commands.terminal() ?? this.#state.replies.terminal();
    if (terminal) this.terminate(terminal.reason);
  }
  #publish(state: Ready, bytes: Uint8Array): boolean {
    const acquired = state.replies.tryAcquireWriter();
    if (acquired.kind === "terminal") {
      this.terminate(acquired.reason);
      return false;
    }
    if (acquired.kind === "busy") {
      this.terminate(GPU_TERMINAL.resource);
      return false;
    }
    try {
      const result = acquired.writer.tryWrite(bytes);
      if (result.kind === "written") return true;
      acquired.writer.release();
      this.terminate(result.kind === "terminal" ? result.reason : GPU_TERMINAL.resource);
      return false;
    } finally {
      acquired.writer.release();
    }
  }
  #allocatePayload(state: Ready, length: number, fill: (destination: Uint8Array) => void): Handle {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new GpuResourceError("Invalid payload length");
    for (let index = 0; index < state.payloads.length; index++) {
      const slot = state.payloads[index];
      if (slot && state.directory?.consumed(index, slot.generation))
        state.payloads[index] = undefined;
    }
    const index = state.payloads.findIndex(
      (slot, at) => slot === undefined && (state.generations[at] ?? 0) < 0xffffffff,
    );
    if (index < 0 || length > state.arena.byteLength)
      throw new GpuResourceError("Payload credit exhausted");
    const occupied = state.payloads.filter((slot): slot is Payload => slot !== undefined);
    occupied.sort((a, b) => a.offset - b.offset);
    let offset = state.directory ? gpuPayloadLayout.dataOffset : 0;
    for (const slot of occupied) {
      if (slot.offset - offset >= length) break;
      offset = slot.offset + slot.length;
    }
    if (length > state.arena.byteLength - offset)
      throw new GpuResourceError("Payload credit exhausted");
    const generation = (state.generations[index] ?? 0) + 1;
    fill(state.arena.subarray(offset, offset + length));
    state.generations[index] = generation;
    state.payloads[index] = { offset, length, generation };
    state.directory?.publish(index, generation, offset, length);
    return { id: index + 1, generation };
  }
}
class GpuCallClosed extends Error {}

function detach<T>(pending: Pending<T>): void {
  pending.owner = undefined;
  pending.settle = undefined;
  pending.reject = undefined;
}
function complete<T>(pending: Pending<T>, token: number, value: T): void {
  const owner = pending.owner;
  const settle = pending.settle;
  detach(pending);
  if (!owner?.settled(token) || !settle) {
    pending.abandon(value);
    return;
  }
  try {
    settle(owner, value);
  } catch (error) {
    owner.terminate(
      error instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol,
    );
  }
}
function fail<T>(pending: Pending<T>, token: number, error: unknown): void {
  const owner = pending.owner;
  const reject = pending.reject;
  detach(pending);
  if (!owner?.settled(token) || !reject) return;
  try {
    reject(owner, error);
  } catch (failure) {
    owner.terminate(
      failure instanceof GpuResourceError ? GPU_TERMINAL.resource : GPU_TERMINAL.protocol,
    );
  }
}

function watchPromise<T>(promise: Promise<T>, pending: Pending<T>, token: number): void {
  void promise.then(
    (value) => complete(pending, token, value),
    (error: unknown) => fail(pending, token, error),
  );
}

function publishClosed(ring: RecordRing, reason: number): void {
  let writer: RingWriter | undefined;
  try {
    const acquired = ring.tryAcquireWriter();
    if (acquired.kind !== "acquired") return;
    writer = acquired.writer;
    if (ring.capacity >= 24)
      writer.tryWrite(completionBytes("closed", 0, 0, { reason }, ring.capacity));
  } catch {
    /* The out-of-band reason still closes a corrupt or exhausted ring. */
  } finally {
    writer?.release();
  }
}
