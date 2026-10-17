import { WasiExit } from "@bun-wasm/runtime/core";
import { ProcessSignalExit } from "../../runtime/proc/abi";
import { DefaultSignal } from "../src/default-signal";

// Test-only evidence shared between the page and the instrumented guest worker.
// Counts come from real WASI imports / _start, never the supervisor's logical exit.
export const probeCell = {
  checkpoints: 0,
  checkpointAfterSignal: 1,
  checkpointReturned: 2,
  checkpointThrew: 3,
  checkpointSignal: 4,
  handledSignal: 5,
  startEntered: 6,
  startLeft: 7,
  runReturned: 8,
  terminateRequests: 9,
  catchWrites: 10,
  finallyWrites: 11,
  afterWrites: 12,
  slotMasked: 13,
  writes: 14,
  readyWrites: 15,
  lastHostSlot: 16,
  loopFinishedWrites: 17,
  handledBeforeLoopFinished: 18,
  pendingPreservedBeforeLoopFinished: 19,
  pendingLostAtCheckpoint: 20,
  checkpointNonzero: 21,
  idleWaitEntries: 22,
  idleWaiting: 23,
  idleWaitReturns: 24,
  idleWaitBlocked: 25,
  idleWaitOk: 26,
  idleWaitTimedOut: 27,
  idleWaitNotEqual: 28,
  idleWaitActiveGeneration: 29,
  idleWaitSampleGeneration: 30,
  idleWaitSampleResult: 31,
  idleWaitSampleCompleted: 32,
  nativeInterruptRequested: 33,
  nativeInterruptInjected: 34,
  startNormalReturn: 35,
  startWasiExit: 36,
  startOtherException: 37,
  startWasiExitCode: 38,
  checkpointFatalSignal: 39,
  startFatalSignal: 40,
} as const;
export const probeLength = 41;
export interface EngineInterruptionOptions { evidence: SharedArrayBuffer; hooks: boolean; observeCheckpoints: boolean; idleWaitTimeoutMs: number; }
const hostCallFd = 0x7fffb0b0;

export function snapshotProbe(probe: Int32Array): Record<keyof typeof probeCell, number> {
  return Object.fromEntries(Object.entries(probeCell).map(([key, index]) => [key, Atomics.load(probe, index)])) as Record<keyof typeof probeCell, number>;
}

export function engineInterruptionFailure(label: string, error: unknown, diagnostics: () => unknown): Error {
  let context: unknown;
  try { context = diagnostics(); }
  catch (diagnosticError) { context = { diagnosticError: String(diagnosticError) }; }
  return new Error(`${label}: ${String(error)}; diagnostics=${JSON.stringify(context)}`, { cause: error });
}

/** Decorate only the guest's actual imported WASI functions, preserving their behavior. */
export function observeEngineImports(imports: WebAssembly.Imports, probe: Int32Array,
  memory: () => WebAssembly.Memory, requestedSignal: Int32Array, signalState: Int32Array, observeCheckpoints = true): void {
  const wasi = imports.wasi_snapshot_preview1;
  if (!wasi) throw new Error("engine interruption guest has no preview1 imports");
  const send = wasi.sock_send;
  if (typeof send !== "function") throw new Error("engine interruption guest has no sock_send import");
  if (observeCheckpoints) wasi.sock_send = (fd: number, packet: number, length: number, flags: number, result: number) => {
    const view = new DataView(memory().buffer);
    if (fd === hostCallFd && length === 5) Atomics.store(probe, probeCell.lastHostSlot, view.getInt32(packet, true));
    const signalCall = fd === hostCallFd && length === 5 && view.getInt32(packet, true) === 18
      && view.getInt32(packet + 4, true) === 0;
    const mode = signalCall ? view.getInt32(packet + 8, true) : -1;
    const checkpoint = mode === 4, dequeue = mode === 0;
    if (!checkpoint && !dequeue) return send(fd, packet, length, flags, result);
    // Shared signal ABI: SIGINT is cell2; mask4 is its authoritative pending bit.
    // Mode4 must leave it there until an event-loop mode0 dequeue after JS yields.
    const pendingBefore = checkpoint && Atomics.load(probe, probeCell.loopFinishedWrites) === 0
      ? Atomics.load(signalState, 2) & 4 : 0;
    const signalBefore = checkpoint ? Atomics.load(requestedSignal, 0) : 0;
    if (checkpoint) {
      Atomics.add(probe, probeCell.checkpoints, 1);
      if (signalBefore) Atomics.add(probe, probeCell.checkpointAfterSignal, 1);
    }
    try {
      let status: number;
      if (checkpoint && Atomics.compareExchange(probe, probeCell.nativeInterruptRequested, 1, 0) === 1) {
        // Native-engine-path fixture only: errno0 with a real negative slot result.
        // No production host call, selected signal outcome or throwing callback.
        new DataView(memory().buffer).setInt32(result, -1, true);
        Atomics.add(probe, probeCell.nativeInterruptInjected, 1);
        status = 0;
      } else status = send(fd, packet, length, flags, result);
      const delivered = new DataView(memory().buffer).getInt32(result, true);
      if (checkpoint) {
        Atomics.add(probe, probeCell.checkpointReturned, 1);
        if (signalBefore) Atomics.store(probe, probeCell.checkpointSignal, signalBefore);
        if (delivered !== 0) Atomics.add(probe, probeCell.checkpointNonzero, 1);
        if (pendingBefore) Atomics.add(probe, Atomics.load(signalState, 2) & 4
          ? probeCell.pendingPreservedBeforeLoopFinished : probeCell.pendingLostAtCheckpoint, 1);
      } else if (delivered > 0) {
        Atomics.store(probe, probeCell.handledSignal, delivered);
        if (Atomics.load(probe, probeCell.loopFinishedWrites) === 0) Atomics.add(probe, probeCell.handledBeforeLoopFinished, 1);
      }
      return status;
    } catch (error) {
      if (checkpoint) {
        Atomics.add(probe, probeCell.checkpointThrew, 1);
        // The fatal decision precedes wake publication: this word can still be
        // zero or the previous handled signal even after the real callback throws.
        // Only a production terminal exception identifies this fatal checkpoint.
        if (error instanceof DefaultSignal || error instanceof ProcessSignalExit) {
          if (!signalBefore) Atomics.add(probe, probeCell.checkpointAfterSignal, 1);
          Atomics.store(probe, probeCell.checkpointSignal, error.signal);
          Atomics.store(probe, probeCell.checkpointFatalSignal, error.signal);
        }
      }
      throw error;
    }
  };
  const write = wasi.fd_write;
  if (typeof write !== "function") throw new Error("engine interruption guest has no fd_write import");
  const decoder = new TextDecoder();
  const markers = [["ready", probeCell.readyWrites], ["loop-finished", probeCell.loopFinishedWrites],
    ["CATCH-RAN", probeCell.catchWrites], ["FINALLY-RAN", probeCell.finallyWrites], ["AFTER-RAN", probeCell.afterWrites]] as const;
  // Raw diagnostics can quote the source containing marker literals. Match complete
  // output records, carrying only possible marker prefixes across calls per fd.
  // A non-matching line stays ignored until newline; arbitrarily long source
  // excerpts therefore cannot grow this state or reset into a mid-line marker.
  const partialLines = new Map<number, string | null>();
  wasi.fd_write = (fd: number, vectors: number, count: number, written: number) => {
    // Observe attempts BEFORE the real import rejects a revoked guest. Otherwise the
    // supervisor's closed pipe could conceal an incorrectly executed catch/finally.
    if (fd === 1 || fd === 2) {
      const buffer = memory().buffer, view = new DataView(buffer);
      let text = "";
      for (let index = 0; index < count; index++) {
        const pointer = view.getUint32(vectors + index * 8, true);
        const length = view.getUint32(vectors + index * 8 + 4, true);
        // Chromium's TextDecoder rejects resizable WASM buffers. The fixed owned
        // byte copy is a decoder representation requirement, not a guest-memory view.
        text += decoder.decode(new Uint8Array(buffer, pointer, length).slice(), { stream: true });
      }
      text += decoder.decode();
      Atomics.add(probe, probeCell.writes, 1);
      const previousLine = partialLines.get(fd);
      let line: string | null = previousLine === undefined ? "" : previousLine;
      for (const character of text) {
        if (character === "\n") {
          const cell = markers.find(([marker]) => marker === line)?.[1];
          if (cell !== undefined) Atomics.add(probe, cell, 1);
          line = "";
        } else if (line !== null) {
          const next: string = line + character;
          line = markers.some(([marker]) => marker.startsWith(next)) ? next : null;
        }
      }
      partialLines.set(fd, line);
    }
    return write(fd, vectors, count, written);
  };
}

/** Test-only idle proof; never installed in timed CPU overhead runs. */
export function observeEventLoopWait(probe: Int32Array, word: Int32Array,
  target: Pick<typeof Atomics, "wait"> = Atomics, timeoutOverrideMs = 0): () => void {
  const native = target.wait;
  target.wait = (array, index, value, timeout) => {
    const observed = array.buffer === word.buffer && array.byteOffset + index * array.BYTES_PER_ELEMENT === word.byteOffset
      && (timeout === undefined || timeout > 0);
    if (!observed) return Reflect.apply(native, target, [array, index, value, timeout]);
    const generation = Atomics.add(probe, probeCell.idleWaitEntries, 1) + 1;
    Atomics.store(probe, probeCell.idleWaitActiveGeneration, generation);
    Atomics.store(probe, probeCell.idleWaiting, 1);
    try {
      const result = Reflect.apply(native, target, [array, index, value, timeoutOverrideMs || timeout]);
      Atomics.add(probe, probeCell.idleWaitReturns, 1);
      // not-equal never slept: it cannot substantiate actual native blocking.
      if (result === "ok" || result === "timed-out") Atomics.add(probe, probeCell.idleWaitBlocked, 1);
      if (result === "ok") Atomics.add(probe, probeCell.idleWaitOk, 1);
      else if (result === "timed-out") Atomics.add(probe, probeCell.idleWaitTimedOut, 1);
      else if (result === "not-equal") Atomics.add(probe, probeCell.idleWaitNotEqual, 1);
      if (Atomics.load(probe, probeCell.idleWaitSampleGeneration) === generation) {
        Atomics.store(probe, probeCell.idleWaitSampleResult, result === "ok" ? 1 : result === "timed-out" ? 2 : 3);
        Atomics.store(probe, probeCell.idleWaitSampleCompleted, generation);
      }
      return result;
    } finally { Atomics.store(probe, probeCell.idleWaiting, 0); Atomics.store(probe, probeCell.idleWaitActiveGeneration, 0); }
  };
  return () => { target.wait = native; };
}

export function assertFatalEngineCompletion(evidence: ReturnType<typeof snapshotProbe>, signal: number): void {
  if (signal <= 0 || evidence.checkpointFatalSignal !== signal || evidence.startFatalSignal !== signal
    || evidence.checkpointThrew !== 1 || evidence.startOtherException !== 1
    || evidence.startNormalReturn !== 0 || evidence.startWasiExit !== 0) {
    throw new Error(`default signal completion requires matching typed fatal checkpoint and _start throws: expected=${signal}, checkpoint=${evidence.checkpointFatalSignal}, start=${evidence.startFatalSignal}, threw=${evidence.checkpointThrew}, other=${evidence.startOtherException}, normal=${evidence.startNormalReturn}, wasi=${evidence.startWasiExit}`);
  }
}

export function assertNativeEngineCompletion(evidence: ReturnType<typeof snapshotProbe>): void {
  if (evidence.startOtherException !== 0 || evidence.startNormalReturn + evidence.startWasiExit !== 1) {
    throw new Error(`native engine completion used an unexpected exception or missing normal/typed WASI exit: normal=${evidence.startNormalReturn}, wasi=${evidence.startWasiExit}, other=${evidence.startOtherException}`);
  }
}

export function assertCausalIdleWake(evidence: ReturnType<typeof snapshotProbe>, generation: number): void {
  if (evidence.idleWaitSampleCompleted !== generation || evidence.idleWaitSampleResult !== 1) {
    throw new Error(`sampled idle wait generation ${generation} did not return native ok: completed=${evidence.idleWaitSampleCompleted}, result=${evidence.idleWaitSampleResult}`);
  }
}

/** Mutation control: suppress only this exact shared wait-cell address. */
export function suppressBudgetNotifications(word: Int32Array,
  target: Pick<typeof Atomics, "notify"> = Atomics): { count(): number; restore(): void } {
  const native = target.notify;
  let suppressed = 0;
  target.notify = (array, index, count) => {
    if (array.buffer === word.buffer && array.byteOffset + index * array.BYTES_PER_ELEMENT === word.byteOffset) { suppressed++; return 0; }
    return Reflect.apply(native, target, [array, index, count]);
  };
  return { count: () => suppressed, restore() { target.notify = native; } };
}

/** Called after production slot installation, immediately before the real _start. */
export function observedEngineStart(exports: WebAssembly.Exports, probe: Int32Array, hooks: boolean): () => unknown {
  if (typeof exports._start !== "function") throw new Error("guest has no _start");
  const start = exports._start;
  return () => {
    if (!hooks) {
      if (typeof exports.bun_wasm_host_slots !== "function" || !(exports.memory instanceof WebAssembly.Memory)) throw new Error("baseline guest has no host slots");
      const pointer = Number(exports.bun_wasm_host_slots());
      const view = new DataView(exports.memory.buffer);
      if (view.getUint32(pointer, true) !== 1 || view.getUint32(pointer + 4, true) <= 18) throw new Error("baseline guest has no signal slot");
      // The runtime installs engine hooks only if optional slot 18 is provided. This
      // is the SAME freshly built artifact, not a different version or compiler mode.
      view.setUint32(pointer + 8 + 18 * 4, 0, true);
      Atomics.store(probe, probeCell.slotMasked, 1);
    }
    Atomics.add(probe, probeCell.startEntered, 1);
    try {
      const result = start();
      Atomics.add(probe, probeCell.startNormalReturn, 1);
      return result;
    } catch (error) {
      if (error instanceof WasiExit) {
        Atomics.add(probe, probeCell.startWasiExit, 1);
        Atomics.store(probe, probeCell.startWasiExitCode, error.code);
      } else {
        // Keep typed fatal throws in "other" so native true-return admission
        // remains strict; default-fatal admission additionally checks their type.
        Atomics.add(probe, probeCell.startOtherException, 1);
        if (error instanceof DefaultSignal || error instanceof ProcessSignalExit) {
          Atomics.store(probe, probeCell.startFatalSignal, error.signal);
        }
      }
      throw error;
    } finally { Atomics.add(probe, probeCell.startLeft, 1); }
  };
}
