import { expect, test } from "bun:test";
import { WasiExit } from "@bun-wasm/runtime/core";
import { ProcessSignalExit } from "../../runtime/proc/abi";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import { DefaultSignal } from "../src/default-signal";
import { assertFatalEngineCompletion, assertNativeEngineCompletion, engineInterruptionFailure, observeEngineImports, observeEventLoopWait, observedEngineStart, probeCell, probeLength, snapshotProbe, suppressBudgetNotifications } from "./engine-interruption-probe";

function fixture() {
  const probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  const memory = new WebAssembly.Memory({ initial: 1 });
  const requested = new Int32Array(new SharedArrayBuffer(4));
  const pending = new Int32Array(new SharedArrayBuffer(65 * 4));
  const view = new DataView(memory.buffer);
  const packet = 64, result = 96;
  view.setInt32(packet, 18, true); view.setInt32(packet + 8, 4, true);
  return { probe, memory, requested, pending, view, packet, result };
}
test("fatal proof failure retains full probe and process context as diagnostic JSON", () => {
  const f = fixture(), original = new Error("checkpoint assertion");
  Atomics.store(f.probe, probeCell.checkpointThrew, 1);
  Atomics.store(f.probe, probeCell.startLeft, 1);
  const expected = { evidence: snapshotProbe(f.probe), stdout: "out\n", stderr: "ready\n", requestedSignal: 15, ordinaryStatus: 143 };
  const failure = engineInterruptionFailure("jsc/legacy default SIGTERM proof failed", original, () => expected);
  expect(failure.cause).toBe(original);
  expect(failure.message).toContain("jsc/legacy default SIGTERM proof failed: Error: checkpoint assertion");
  const context = JSON.parse(failure.message.split("; diagnostics=")[1]!);
  expect(context).toEqual(expected);
  expect(Object.keys(context.evidence)).toHaveLength(Object.keys(probeCell).length);
  expect(context.evidence.checkpointAfterSignal).toBe(0);
  expect(context.evidence.checkpointThrew).toBe(1);
  expect(context.evidence.startLeft).toBe(1);
});
test("diagnostic collection failure preserves the original proof error", () => {
  const original = new Error("original proof assertion");
  const failure = engineInterruptionFailure("proof failed", original, () => { throw new Error("diagnostic read failed"); });
  expect(failure.cause).toBe(original);
  expect(failure.message).toContain("original proof assertion");
  expect(JSON.parse(failure.message.split("; diagnostics=")[1]!)).toEqual({ diagnosticError: "Error: diagnostic read failed" });
});
test("mode4 checkpoint observes selected signal and preserves real shared pending bit", () => {
  const f = fixture(); let calls = 0;
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
    sock_send() { calls++; f.view.setInt32(f.result, 0, true); return 0; }, fd_write() { return 0; },
  } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  Atomics.store(f.requested, 0, 2); Atomics.store(f.pending, 2, 6);
  expect((imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result)).toBe(0);
  expect(calls).toBe(1);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.checkpoints).toBe(1); expect(evidence.checkpointAfterSignal).toBe(1);
  expect(evidence.checkpointSignal).toBe(2); expect(evidence.checkpointReturned).toBe(1);
  expect(evidence.handledSignal).toBe(0); expect(evidence.checkpointThrew).toBe(0);
  expect(evidence.pendingPreservedBeforeLoopFinished).toBe(1);
  expect(evidence.pendingLostAtCheckpoint).toBe(0); expect(evidence.checkpointNonzero).toBe(0);
  expect(Atomics.load(f.pending, 2)).toBe(6);
});
test("probe rejects fake mode4 preservation and distinguishes mode0 dequeue after yield", () => {
  const f = fixture();
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
    sock_send() { Atomics.store(f.pending, 2, 2); f.view.setInt32(f.result, 2, true); return 0; }, fd_write() { return 0; },
  } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const send = imports.wasi_snapshot_preview1!.sock_send as Function;
  Atomics.store(f.pending, 2, 6);
  send(0x7fffb0b0, f.packet, 5, 0, f.result);
  expect(snapshotProbe(f.probe).pendingLostAtCheckpoint).toBe(1);
  expect(snapshotProbe(f.probe).checkpointNonzero).toBe(1);
  expect(snapshotProbe(f.probe).handledSignal).toBe(0);
  f.view.setInt32(f.packet + 8, 0, true);
  send(0x7fffb0b0, f.packet, 5, 0, f.result);
  expect(snapshotProbe(f.probe).handledBeforeLoopFinished).toBe(1);
  Atomics.store(f.probe, probeCell.loopFinishedWrites, 1);
  send(0x7fffb0b0, f.packet, 5, 0, f.result);
  expect(snapshotProbe(f.probe).handledBeforeLoopFinished).toBe(1);
  expect(snapshotProbe(f.probe).handledSignal).toBe(2);
  expect(snapshotProbe(f.probe).checkpoints).toBe(1);
});
test("unrelated host calls cannot fabricate checkpoint evidence", () => {
  const f = fixture();
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const send = imports.wasi_snapshot_preview1!.sock_send as Function;
  send(0, f.packet, 5, 0, f.result);
  send(0x7fffb0b0, f.packet, 4, 0, f.result);
  f.view.setInt32(f.packet + 4, 2, true);
  send(0x7fffb0b0, f.packet, 5, 0, f.result);
  expect(snapshotProbe(f.probe).checkpoints).toBe(0);
});
test("probe preserves the typed host exception and records actual callback unwind", () => {
  const f = fixture(), fatal = new ProcessSignalExit(15);
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { throw fatal; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  Atomics.store(f.requested, 0, 15);
  expect(() => (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result)).toThrow(fatal);
  expect(snapshotProbe(f.probe).checkpointThrew).toBe(1);
  expect(snapshotProbe(f.probe).checkpointReturned).toBe(0);
});
test("signal published inside an in-flight mode4 callback is observed at its actual unwind", () => {
  for (const [previousSignal, signal] of [[0, 2], [0, 15], [2, 15], [15, 2]] as const) {
    const f = fixture(), fatal = new ProcessSignalExit(signal);
    let calls = 0;
    Atomics.store(f.requested, 0, previousSignal);
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
      sock_send() { calls++; Atomics.store(f.requested, 0, signal); throw fatal; }, fd_write() { return 0; },
    } };
    observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
    let caught: unknown;
    try { (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result); }
    catch (error) { caught = error; }
    expect(caught).toBe(fatal);
    expect(calls).toBe(1);
    const evidence = snapshotProbe(f.probe);
    expect(evidence.checkpoints).toBe(1);
    expect(evidence.checkpointAfterSignal).toBe(1);
    expect(evidence.checkpointSignal).toBe(signal);
    expect(evidence.checkpointThrew).toBe(1);
    expect(evidence.checkpointReturned).toBe(0);
  }
});
test("fatal checkpoint signal is authoritative before wake publication reaches the observer", () => {
  for (const previousSignal of [0, 2]) {
    const f = fixture(), fatal = new ProcessSignalExit(15);
    let calls = 0;
    Atomics.store(f.requested, 0, previousSignal);
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
      sock_send() { calls++; throw fatal; }, fd_write() { return 0; },
    } };
    observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
    let caught: unknown;
    try { (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result); }
    catch (error) { caught = error; }
    // The fatal decision/typed throw precedes requestSignal's later publishWake.
    const beforePublication = snapshotProbe(f.probe);
    expect(caught).toBe(fatal); expect(calls).toBe(1);
    expect(Atomics.load(f.requested, 0)).toBe(previousSignal);
    expect(beforePublication.checkpointAfterSignal).toBe(1);
    expect(beforePublication.checkpointSignal).toBe(15);
    expect(beforePublication.checkpointThrew).toBe(1);
    expect(beforePublication.checkpointReturned).toBe(0);
    Atomics.store(f.requested, 0, 15);
    expect(snapshotProbe(f.probe)).toEqual(beforePublication);
  }
});
test("signal present before a throwing checkpoint is counted once, unrelated exceptions do not select one", () => {
  for (const signal of [0, 2, 15]) {
    const f = fixture(), fatal = new Error("callback error");
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
      sock_send() { throw fatal; }, fd_write() { return 0; },
    } };
    observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
    Atomics.store(f.requested, 0, signal);
    expect(() => (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result)).toThrow(fatal);
    const evidence = snapshotProbe(f.probe);
    expect(evidence.checkpointAfterSignal).toBe(signal ? 1 : 0);
    expect(evidence.checkpointSignal).toBe(0);
    expect(evidence.checkpointThrew).toBe(1);
  }
});
test("normal checkpoint return does not fabricate a fatal observation from a later signal", () => {
  for (const previousSignal of [0, 2]) {
    const f = fixture();
    Atomics.store(f.requested, 0, previousSignal);
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
      sock_send() { Atomics.store(f.requested, 0, 15); f.view.setInt32(f.result, 0, true); return 0; }, fd_write() { return 0; },
    } };
    observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
    expect((imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result)).toBe(0);
    const evidence = snapshotProbe(f.probe);
    expect(evidence.checkpointAfterSignal).toBe(previousSignal ? 1 : 0);
    expect(evidence.checkpointSignal).toBe(previousSignal);
    expect(evidence.checkpointThrew).toBe(0);
    expect(evidence.checkpointReturned).toBe(1);
  }
});
test("catch/finally writes are visible even when real revoked stdio throws", () => {
  const f = fixture(), fatal = new Error("revoked stdio");
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { throw fatal; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const bytes = new TextEncoder().encode("CATCH-RAN\nFINALLY-RAN\nAFTER-RAN\n");
  new Uint8Array(f.memory.buffer, 512, bytes.length).set(bytes);
  f.view.setUint32(256, 512, true); f.view.setUint32(260, bytes.length, true);
  expect(() => (imports.wasi_snapshot_preview1!.fd_write as Function)(1, 256, 1, 300)).toThrow(fatal);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.catchWrites).toBe(1); expect(evidence.finallyWrites).toBe(1); expect(evidence.afterWrites).toBe(1);
});
test("runtime diagnostics quoting marker source are not executed catch/finally/continuation writes", () => {
  const f = fixture();
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const text = "1 | try { while(true){} } catch(error) { fs.writeSync(2,'CATCH-RAN\\n'); } finally { fs.writeSync(2,'FINALLY-RAN\\n'); } fs.writeSync(2,'AFTER-RAN\\n');\nInternalError: interrupted\n";
  const bytes = new TextEncoder().encode(text);
  new Uint8Array(f.memory.buffer, 512, bytes.length).set(bytes);
  f.view.setUint32(256, 512, true); f.view.setUint32(260, bytes.length, true);
  expect((imports.wasi_snapshot_preview1!.fd_write as Function)(2, 256, 1, 300)).toBe(0);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.writes).toBe(1);
  expect(evidence.catchWrites).toBe(0); expect(evidence.finallyWrites).toBe(0); expect(evidence.afterWrites).toBe(0);
});
test("marker substrings and unterminated source tokens do not fabricate execution evidence", () => {
  const f = fixture();
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const bytes = new TextEncoder().encode("NOT-CATCH-RAN\nFINALLY-RAN-not\nError: AFTER-RAN\nCATCH-RAN");
  new Uint8Array(f.memory.buffer, 512, bytes.length).set(bytes);
  f.view.setUint32(256, 512, true); f.view.setUint32(260, bytes.length, true);
  (imports.wasi_snapshot_preview1!.fd_write as Function)(2, 256, 1, 300);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.catchWrites).toBe(0); expect(evidence.finallyWrites).toBe(0); expect(evidence.afterWrites).toBe(0);
});
test("exact marker records survive split fd_write calls and iovecs without joining different fds", () => {
  const f = fixture();
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const write = (fd: number, parts: string[]) => {
    let pointer = 512;
    for (const [index, part] of parts.entries()) {
      const bytes = new TextEncoder().encode(part);
      new Uint8Array(f.memory.buffer, pointer, bytes.length).set(bytes);
      f.view.setUint32(256 + index * 8, pointer, true); f.view.setUint32(260 + index * 8, bytes.length, true);
      pointer += bytes.length;
    }
    return (imports.wasi_snapshot_preview1!.fd_write as Function)(fd, 256, parts.length, 300);
  };
  write(2, ["CATCH-"]); write(1, ["RAN\n"]);
  expect(snapshotProbe(f.probe).catchWrites).toBe(0);
  write(2, ["RA", "N\nFINALLY-", "RAN\n"]);
  write(1, ["AFTER-"]); write(1, ["RAN", "\n"]);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.catchWrites).toBe(1); expect(evidence.finallyWrites).toBe(1); expect(evidence.afterWrites).toBe(1);
});
test("split quoted source remains diagnostic while a subsequent exact marker is still rejected", () => {
  const f = fixture();
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  const write = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(f.memory.buffer, 512, bytes.length).set(bytes);
    f.view.setUint32(256, 512, true); f.view.setUint32(260, bytes.length, true);
    (imports.wasi_snapshot_preview1!.fd_write as Function)(2, 256, 1, 300);
  };
  write("1 | fs.writeSync(2,'"); write("CATCH-"); write("RAN\\n');\nError: AFTER-RAN\n");
  expect(snapshotProbe(f.probe).catchWrites).toBe(0); expect(snapshotProbe(f.probe).afterWrites).toBe(0);
  write("CA"); write("TCH-RAN\n");
  expect(snapshotProbe(f.probe).catchWrites).toBe(1);
});
test("output observation accepts a resizable wasm memory buffer", () => {
  const f = fixture();
  const buffer = Reflect.construct(ArrayBuffer, [65536, { maxByteLength: 131072 }]) as ArrayBuffer;
  expect(Reflect.get(buffer, "resizable")).toBe(true);
  Object.defineProperty(f.memory, "buffer", { value: buffer });
  const view = new DataView(buffer), bytes = new TextEncoder().encode("ready\n");
  new Uint8Array(buffer, 512, bytes.length).set(bytes);
  view.setUint32(256, 512, true); view.setUint32(260, bytes.length, true);
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send() { return 0; }, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  expect((imports.wasi_snapshot_preview1!.fd_write as Function)(2, 256, 1, 300)).toBe(0);
  expect(snapshotProbe(f.probe).readyWrites).toBe(1);
});
test("baseline masks only optional slot18 before _start and still observes unwind", () => {
  const f = fixture(), pointer = 1024, fatal = new Error("start unwind");
  f.view.setUint32(pointer, 1, true); f.view.setUint32(pointer + 4, 19, true);
  for (let slot = 0; slot < 19; slot++) f.view.setUint32(pointer + 8 + slot * 4, 0xffffffff, true);
  const start = observedEngineStart({ memory: f.memory, bun_wasm_host_slots: () => pointer,
    _start() { expect(f.view.getUint32(pointer + 8 + 18 * 4, true)).toBe(0); throw fatal; },
  }, f.probe, false);
  expect(() => start()).toThrow(fatal);
  expect(f.view.getUint32(pointer + 8 + 17 * 4, true)).toBe(0xffffffff);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.slotMasked).toBe(1); expect(evidence.startEntered).toBe(1); expect(evidence.startLeft).toBe(1);
});
test("timed samples leave the production checkpoint import completely untouched", () => {
  const f = fixture();
  const send = () => 0;
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { sock_send: send, fd_write() { return 0; } } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending, false);
  expect(imports.wasi_snapshot_preview1!.sock_send).toBe(send);
  expect(snapshotProbe(f.probe).checkpoints).toBe(0);
});
test("enabled run preserves slot18 and the actual _start result", () => {
  const f = fixture();
  const start = observedEngineStart({ _start: () => 42 }, f.probe, true);
  expect(start()).toBe(42);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.slotMasked).toBe(0); expect(evidence.startLeft).toBe(1);
});
test("idle evidence observes only actual event-loop budget waits and restores the native function", () => {
  const f = fixture(), budget = new SharedArrayBuffer(16), cells = new Int32Array(budget);
  let observed = false;
  const target: Pick<typeof Atomics, "wait"> = { wait() {
    if (observed) expect(Atomics.load(f.probe, probeCell.idleWaiting)).toBe(1);
    return "timed-out";
  } };
  const original = target.wait, restore = observeEventLoopWait(f.probe, new Int32Array(budget, 4, 1), target);
  target.wait(new Int32Array(new SharedArrayBuffer(16)), 1, 0, 4);
  target.wait(cells, 0, 0, 4); target.wait(cells, 1, 0, 0);
  expect(snapshotProbe(f.probe).idleWaitEntries).toBe(0);
  observed = true;
  expect(target.wait(cells, 1, 0, 4)).toBe("timed-out");
  const evidence = snapshotProbe(f.probe);
  expect(evidence.idleWaitEntries).toBe(1); expect(evidence.idleWaitReturns).toBe(1);
  expect(evidence.idleWaitBlocked).toBe(1); expect(evidence.idleWaiting).toBe(0);
  expect(evidence.idleWaitTimedOut).toBe(1); expect(evidence.idleWaitOk).toBe(0);
  restore(); expect(target.wait).toBe(original);
});
test("idle evidence clears waiting state on throw and excludes not-equal from real blocking proof", () => {
  const f = fixture(), budget = new SharedArrayBuffer(16), cells = new Int32Array(budget);
  const target: Pick<typeof Atomics, "wait"> = { wait: () => "not-equal" };
  const restore = observeEventLoopWait(f.probe, new Int32Array(budget, 4, 1), target);
  try {
    target.wait(cells, 1, 0, 4);
    expect(snapshotProbe(f.probe).idleWaitBlocked).toBe(0);
    expect(snapshotProbe(f.probe).idleWaitNotEqual).toBe(1);
    expect(snapshotProbe(f.probe).idleWaiting).toBe(0);
  } finally { restore(); }
  const thrown: Pick<typeof Atomics, "wait"> = { wait() { throw new Error("wait failed"); } };
  const restoreThrown = observeEventLoopWait(f.probe, new Int32Array(budget, 4, 1), thrown);
  try {
    expect(() => thrown.wait(cells, 1, 0, 4)).toThrow("wait failed");
    expect(snapshotProbe(f.probe).idleWaiting).toBe(0);
    expect(snapshotProbe(f.probe).idleWaitReturns).toBe(1);
  } finally { restoreThrown(); }
});
test("idle evidence records native ok separately without claiming signal-notify causality", () => {
  const f = fixture(), budget = new SharedArrayBuffer(16), cells = new Int32Array(budget);
  const target: Pick<typeof Atomics, "wait"> = { wait: () => "ok" };
  const restore = observeEventLoopWait(f.probe, new Int32Array(budget, 4, 1), target);
  try {
    target.wait(cells, 1, 0, 4);
    const evidence = snapshotProbe(f.probe);
    expect(evidence.idleWaitOk).toBe(1); expect(evidence.idleWaitTimedOut).toBe(0);
    expect(evidence.idleWaitNotEqual).toBe(0); expect(evidence.idleWaitBlocked).toBe(1);
  } finally { restore(); }
});
test("one-shot native interrupt injection returns real op4 negative without host send or throw", () => {
  const f = fixture(); let calls = 0;
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
    sock_send() { calls++; f.view.setInt32(f.result, 0, true); return 0; }, fd_write() { return 0; },
  } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  Atomics.store(f.probe, probeCell.nativeInterruptRequested, 1);
  const send = imports.wasi_snapshot_preview1!.sock_send as Function;
  f.view.setInt32(f.packet + 8, 0, true);
  send(0x7fffb0b0, f.packet, 5, 0, f.result);
  expect(Atomics.load(f.probe, probeCell.nativeInterruptRequested)).toBe(1);
  f.view.setInt32(f.packet + 8, 4, true);
  expect(send(0x7fffb0b0, f.packet, 5, 0, f.result)).toBe(0);
  expect(f.view.getInt32(f.result, true)).toBe(-1);
  expect(calls).toBe(1);
  const injected = snapshotProbe(f.probe);
  expect(injected.nativeInterruptInjected).toBe(1); expect(injected.checkpointNonzero).toBe(1);
  expect(injected.checkpointReturned).toBe(1); expect(injected.checkpointThrew).toBe(0);
  expect(Atomics.load(f.requested, 0)).toBe(0);
  send(0x7fffb0b0, f.packet, 5, 0, f.result);
  expect(calls).toBe(2); expect(f.view.getInt32(f.result, true)).toBe(0);
  expect(snapshotProbe(f.probe).nativeInterruptInjected).toBe(1);
});
test("idle timeout stretching preserves foreign, non-budget-cell and zero-time waits", () => {
  const f = fixture(), budget = new SharedArrayBuffer(16), cells = new Int32Array(budget), timeouts: (number | undefined)[] = [];
  const target: Pick<typeof Atomics, "wait"> = { wait(_array, _index, _value, timeout) { timeouts.push(timeout); return "timed-out"; } };
  const restore = observeEventLoopWait(f.probe, new Int32Array(budget, 4, 1), target, 1_000);
  try {
    target.wait(new Int32Array(new SharedArrayBuffer(16)), 1, 0, 4);
    target.wait(cells, 0, 0, 4); target.wait(cells, 1, 0, 0); target.wait(cells, 1, 0, 4);
    expect(timeouts).toEqual([4, 4, 0, 1_000]);
  } finally { restore(); }
});
test("notify mutation touches only the exact process-budget wake cell and restores native notify", () => {
  const budget = new SharedArrayBuffer(16), cells = new Int32Array(budget);
  let calls = 0;
  const target: Pick<typeof Atomics, "notify"> = { notify() { calls++; return 3; } };
  const native = target.notify, mutation = suppressBudgetNotifications(new Int32Array(budget, 4, 1), target);
  try {
    expect(target.notify(cells, 1)).toBe(0);
    expect(target.notify(cells, 0)).toBe(3);
    expect(target.notify(new Int32Array(new SharedArrayBuffer(16)), 1)).toBe(3);
    expect(calls).toBe(2); expect(mutation.count()).toBe(1);
    expect(Atomics.load(cells, 1)).toBe(0);
  } finally { mutation.restore(); }
  expect(target.notify).toBe(native);
});
test("fatal completion admits matching production signal types at the checkpoint and _start", () => {
  for (const Fatal of [DefaultSignal, ProcessSignalExit]) {
    for (const signal of [2, 15]) {
      const f = fixture(), fatal = new Fatal(signal), outcome = outcomeWord();
      let calls = 0;
      Atomics.store(f.requested, 0, signal === 15 ? 2 : 0);
      const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
        sock_send() { calls++; claimOutcome(outcome, { kind: "signaled", code: signal }); throw fatal; }, fd_write() { return 0; },
      } };
      observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
      const start = observedEngineStart({ _start() {
        (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result);
      } }, f.probe, true);
      let caught: unknown;
      try { start(); } catch (error) { caught = error; }
      expect(caught).toBe(fatal); expect(calls).toBe(1);
      expect(readOutcome(outcome)?.status).toBe(128 + signal);
      const evidence = snapshotProbe(f.probe);
      expect(evidence.checkpointAfterSignal).toBe(1);
      expect(evidence.checkpointSignal).toBe(signal);
      expect(evidence.checkpointFatalSignal).toBe(signal);
      expect(evidence.startFatalSignal).toBe(signal);
      expect(() => assertFatalEngineCompletion(evidence, signal)).not.toThrow();
      expect(() => assertFatalEngineCompletion(evidence, signal === 15 ? 2 : 15)).toThrow("typed fatal");
      expect(() => assertNativeEngineCompletion(evidence)).toThrow("unexpected exception");
      // Publication happens only after both observers caught the genuine exception.
      Atomics.store(f.requested, 0, signal);
      expect(snapshotProbe(f.probe)).toEqual(evidence);
    }
  }
});
test("selected fatal outcome cannot turn a RuntimeError or name/code forgery into typed fatal evidence", () => {
  const errors = [new WebAssembly.RuntimeError("unreachable mutant")].concat(
    ["DefaultSignal", "ProcessSignalExit"].map(name => Object.assign(new Error("forged terminal exit"), { name, signal: 15, status: 143, code: 143 })),
  );
  for (const error of errors) {
    const f = fixture(), outcome = outcomeWord();
    let calls = 0;
    claimOutcome(outcome, { kind: "signaled", code: 15 });
    Atomics.store(f.requested, 0, 15);
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
      sock_send() { calls++; throw error; }, fd_write() { return 0; },
    } };
    observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
    const start = observedEngineStart({ _start() {
      (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result);
    } }, f.probe, true);
    let caught: unknown;
    try { start(); } catch (thrown) { caught = thrown; }
    Atomics.store(f.probe, probeCell.runReturned, 1);
    const evidence = snapshotProbe(f.probe);
    expect(caught).toBe(error); expect(calls).toBe(1);
    expect(readOutcome(outcome)?.status).toBe(143);
    expect(evidence.checkpointAfterSignal).toBe(1); expect(evidence.checkpointThrew).toBe(1);
    expect(evidence.startLeft).toBe(1); expect(evidence.runReturned).toBe(1);
    expect(evidence.checkpointSignal).toBe(0);
    expect(evidence.checkpointFatalSignal).toBe(0); expect(evidence.startFatalSignal).toBe(0);
    expect(() => assertFatalEngineCompletion(evidence, 15)).toThrow("typed fatal");
  }
});
test("fatal admission rejects a typed checkpoint followed by an unrelated trap or different terminal signal", () => {
  for (const replacement of [new WebAssembly.RuntimeError("trap after checkpoint"), new DefaultSignal(2)]) {
    const f = fixture(), fatal = new DefaultSignal(15);
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
      sock_send() { throw fatal; }, fd_write() { return 0; },
    } };
    observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
    const start = observedEngineStart({ _start() {
      try { (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result); }
      catch (error) { expect(error).toBe(fatal); throw replacement; }
    } }, f.probe, true);
    expect(() => start()).toThrow(replacement);
    const evidence = snapshotProbe(f.probe);
    expect(evidence.checkpointFatalSignal).toBe(15);
    expect(evidence.startFatalSignal).toBe(replacement instanceof DefaultSignal ? 2 : 0);
    expect(() => assertFatalEngineCompletion(evidence, 15)).toThrow("typed fatal");
    expect(() => assertFatalEngineCompletion(evidence, 2)).toThrow("typed fatal");
  }
});
test("native completion admission accepts normal return and actual imported WasiExit only", () => {
  const normal = fixture(), returned = observedEngineStart({ _start: () => 42 }, normal.probe, true);
  expect(returned()).toBe(42);
  expect(snapshotProbe(normal.probe).startNormalReturn).toBe(1);
  expect(() => assertNativeEngineCompletion(snapshotProbe(normal.probe))).not.toThrow();
  const exited = fixture(), wasiExit = new WasiExit(1);
  const start = observedEngineStart({ _start() { throw wasiExit; } }, exited.probe, true);
  expect(() => start()).toThrow(wasiExit);
  expect(snapshotProbe(exited.probe).startWasiExit).toBe(1);
  expect(snapshotProbe(exited.probe).startWasiExitCode).toBe(1);
  expect(snapshotProbe(exited.probe).startOtherException).toBe(0);
  expect(() => assertNativeEngineCompletion(snapshotProbe(exited.probe))).not.toThrow();
  const forged = fixture(), fakeExit = Object.assign(new Error("exit 1"), { name: "WasiExit", code: 1 });
  expect(() => observedEngineStart({ _start() { throw fakeExit; } }, forged.probe, true)()).toThrow(fakeExit);
  expect(() => assertNativeEngineCompletion(snapshotProbe(forged.probe))).toThrow("unexpected exception");
});
test("native-path RuntimeError mutant after negative callback cannot pass as engine unwind", () => {
  const f = fixture(), trap = new WebAssembly.RuntimeError("unreachable mutant");
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {
    sock_send() { throw new Error("negative injection must bypass host"); }, fd_write() { return 0; },
  } };
  observeEngineImports(imports, f.probe, () => f.memory, f.requested, f.pending);
  Atomics.store(f.probe, probeCell.nativeInterruptRequested, 1);
  const start = observedEngineStart({ _start() {
    (imports.wasi_snapshot_preview1!.sock_send as Function)(0x7fffb0b0, f.packet, 5, 0, f.result);
    throw trap;
  } }, f.probe, true);
  expect(() => start()).toThrow(trap);
  // Model production catching the crash and finishing with ordinary status1.
  Atomics.store(f.probe, probeCell.runReturned, 1);
  const evidence = snapshotProbe(f.probe);
  expect(evidence.nativeInterruptInjected).toBe(1); expect(evidence.checkpointNonzero).toBe(1);
  expect(evidence.checkpointThrew).toBe(0); expect(evidence.startLeft).toBe(1); expect(evidence.runReturned).toBe(1);
  expect(evidence.startOtherException).toBe(1);
  expect(() => assertNativeEngineCompletion(evidence)).toThrow("unexpected exception");
});

test("idle wait selection follows the exact shared word across offset view aliases", () => {
  const f = fixture(), buffer = new SharedArrayBuffer(64);
  const word = new Int32Array(buffer, 20, 1), wide = new Int32Array(buffer, 8, 8);
  const timeouts: (number | undefined)[] = [];
  const target: Pick<typeof Atomics, "wait"> = { wait(_array, _index, _value, timeout) { timeouts.push(timeout); return "ok"; } };
  const restore = observeEventLoopWait(f.probe, word, target, 1_000);
  try {
    target.wait(wide, 1, 0, 4); // Same numerical index as the old budget selector, wrong byte.
    target.wait(wide, 3, 0, 4); // Same actual shared word through a wider view.
    target.wait(word, 0, 0, 4);
    target.wait(new Int32Array(new SharedArrayBuffer(64), 20, 1), 0, 0, 4);
    expect(timeouts).toEqual([4, 1_000, 1_000, 4]);
    expect(snapshotProbe(f.probe).idleWaitEntries).toBe(2);
  } finally { restore(); }
});

test("notification mutant selects the exact absolute shared address across aliases", () => {
  const buffer = new SharedArrayBuffer(64), word = new Int32Array(buffer, 20, 1);
  let calls = 0;
  const target: Pick<typeof Atomics, "notify"> = { notify() { calls++; return 7; } };
  const mutation = suppressBudgetNotifications(word, target);
  try {
    expect(target.notify(new Int32Array(buffer, 8, 8), 3)).toBe(0);
    expect(target.notify(word, 0)).toBe(0);
    expect(target.notify(new Int32Array(buffer), 1)).toBe(7);
    expect(target.notify(new Int32Array(new SharedArrayBuffer(64), 20, 1), 0)).toBe(7);
    expect(mutation.count()).toBe(2); expect(calls).toBe(2);
  } finally { mutation.restore(); }
});
