import { expect, test } from "bun:test";
import { createSignalState } from "../../runtime/proc/signals";
import { createWorkerProcessTransport, workerProcessState } from "../../runtime/proc/worker-client";
import type { RunRequest } from "../src/worker";
import { engineInterruptionTransport } from "./engine-interruption-transport";

// Only transport selection is isolated here. Browser cases create the real request
// through SubprocessBroker.launch / launchRuntime, never through this test fixture.
test("generic engine probe uses authoritative offset signal views and actual shared hostPoll budget", () => {
  const runtimeProcess = createWorkerProcessTransport();
  const budget = new SharedArrayBuffer(64);
  const state = workerProcessState(runtimeProcess);
  const selected = engineInterruptionTransport({ runtimeProcess, budget } as RunRequest);
  expect(selected.route).toBe("runtimeProcess");
  expect(selected.requestedSignal.buffer).toBe(runtimeProcess.directory);
  expect(selected.requestedSignal.byteOffset).toBe(state.signals.requestedSignal.byteOffset);
  expect(selected.signalState.byteOffset).toBe(state.signals.signalState.byteOffset);
  expect(selected.signalState.length).toBe(65);
  expect(selected.waitWord.buffer).toBe(budget);
  expect(selected.waitWord.byteOffset).toBe(4);
  expect(selected.waitWord.length).toBe(1);
  Atomics.store(selected.requestedSignal, 0, 15);
  Atomics.store(selected.signalState, 2, 6);
  expect(Atomics.load(state.signals.requestedSignal, 0)).toBe(15);
  expect(Atomics.load(state.signals.signalState, 2)).toBe(6);
  expect(Atomics.load(new Int32Array(runtimeProcess.directory), 0)).not.toBe(15);
});

test("legacy engine probe observes actual child budget word and shared signal state", () => {
  const child = { budget: new SharedArrayBuffer(64), requestedSignal: new SharedArrayBuffer(4), signalState: createSignalState().buffer };
  const selected = engineInterruptionTransport({ child } as RunRequest);
  expect(selected.route).toBe("legacy");
  expect(selected.waitWord.buffer).toBe(child.budget);
  expect(selected.waitWord.byteOffset).toBe(4);
  expect(selected.waitWord.length).toBe(1);
  Atomics.store(selected.signalState, 2, 6);
  expect(Atomics.load(new Int32Array(child.signalState), 2)).toBe(6);
});

test("probe rejects requests without an actual production signal and wait transport", () => {
  expect(() => engineInterruptionTransport({} as RunRequest)).toThrow("production signal and wait transport");
});

for (const childRoute of [false, true]) test(`Preview1 ${childRoute ? "child" : "root"} probe selects actual WASI interrupt wait word, never hostPoll budget`, () => {
  const transport = { budget: new SharedArrayBuffer(64), interrupt: new SharedArrayBuffer(4),
    requestedSignal: new SharedArrayBuffer(4), signalState: createSignalState().buffer };
  const selected = engineInterruptionTransport({ adapter: "preview1", ...(childRoute ? { child: transport } : transport) } as RunRequest);
  expect(selected.waitWord.buffer).toBe(transport.interrupt);
  expect(selected.waitWord.byteOffset).toBe(0);
});
