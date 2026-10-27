import { expect, spyOn, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
type ProcessSignalExit = import("../proc/abi.js").ProcessSignalExit;

import { isolatedProcess } from "./fixtures/isolated-process.js";

const isolated = await isolatedProcess();
const Atomics = isolated.atomics;
const { controlLoad } = isolated.load<typeof import("../proc/control.js")>("control");
const { ProcessABI, ProcessSignalExit } = isolated.load<typeof import("../proc/abi.js")>("abi");
const { claimOutcome, outcomeWord } = isolated.load<typeof import("../proc/outcome.js")>("outcome");
const { createSignalState, requestSignal } =
  isolated.load<typeof import("../proc/signals.js")>("signals");

function fixture() {
  const descriptors = new DescriptorTable();
  const signals = {
    signalState: createSignalState(),
    interrupt: new Int32Array(new SharedArrayBuffer(4)),
    requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
    outcome: outcomeWord(),
  };
  const unused = (): never => {
    throw new Error("unexpected service operation");
  };
  const abi = new ProcessABI({
    memory: new WebAssembly.Memory({ initial: 1 }),
    descriptors,
    fs: new MemFS(),
    pid: 1,
    signals,
    service: {
      cwd: unused,
      spawn: unused,
      startStatus: unused,
      waitJob: unused,
      jobEmpty: unused,
      wait: unused,
      childExited: unused,
      kill: unused,
      killJob: unused,
      jobOf: unused,
      defaultSignal: unused,
    },
  });
  return { abi, signals, dispose: () => descriptors.dispose() };
}

test("runtime_proc.signal(0,4) preserves handled deliveries, dispositions and wake hints", () => {
  const f = fixture();
  try {
    expect(f.abi.imports.signal!(2, 2)).toBe(0);
    expect(f.abi.imports.signal!(15, 2)).toBe(0);
    requestSignal(f.signals, 2);
    requestSignal(f.signals, 15);
    const state = Array.from({ length: f.signals.signalState.length }, (_, index) =>
        controlLoad(f.signals.signalState, index),
      ),
      interrupt = controlLoad(f.signals.interrupt, 0);
    const requested = controlLoad(f.signals.requestedSignal, 0);
    for (let index = 0; index < 3; index++) expect(f.abi.imports.signal!(0, 4)).toBe(0);
    expect(
      Array.from({ length: f.signals.signalState.length }, (_, index) =>
        controlLoad(f.signals.signalState, index),
      ),
    ).toEqual(state);
    expect(controlLoad(f.signals.interrupt, 0)).toBe(interrupt);
    expect(controlLoad(f.signals.requestedSignal, 0)).toBe(requested);
    expect(f.abi.imports.signal!(2, 4)).toBe(-28);
    expect(f.abi.imports.signal!(-1, 4)).toBe(-28);
    expect(f.abi.imports.signal!(65, 4)).toBe(-28);
    expect(f.abi.imports.signal!(0, 0)).toBe(2);
    expect(f.abi.imports.interrupted!()).toBe(15);
    expect(f.abi.imports.interrupted!()).toBe(0);
  } finally {
    f.dispose();
  }
});

test("dequeue preserves a publisher racing after wake-hint clear", () => {
  const f = fixture(),
    exchange = Atomics.exchange;
  let raced = false;
  const hook = spyOn(Atomics, "exchange").mockImplementation(((
    word: Int32Array,
    index: number,
    value: number,
  ) => {
    const previous = exchange(word, index, value);
    if (word === f.signals.interrupt && !raced) {
      raced = true;
      requestSignal(f.signals, 15);
    }
    return previous;
  }) as typeof Atomics.exchange);
  try {
    f.abi.imports.signal!(2, 2);
    f.abi.imports.signal!(15, 2);
    requestSignal(f.signals, 2);
    expect(f.abi.imports.interrupted!()).toBe(2);
    expect(raced).toBe(true);
    expect(controlLoad(f.signals.interrupt, 0)).toBe(15);
    expect(f.abi.imports.interrupted!()).toBe(15);
    expect(controlLoad(f.signals.interrupt, 0)).toBe(0);
  } finally {
    hook.mockRestore();
    f.dispose();
  }
});

test("rearming a remaining handled signal never overwrites a racing KILL", () => {
  const f = fixture(),
    compareExchange = Atomics.compareExchange;
  let raced = false;
  const hook = spyOn(Atomics, "compareExchange").mockImplementation(((
    word: Int32Array,
    index: number,
    expected: number,
    value: number,
  ) => {
    if (word === f.signals.interrupt && expected === 0 && value === 15 && !raced) {
      raced = true;
      requestSignal(f.signals, 9);
    }
    return compareExchange(word, index, expected, value);
  }) as typeof Atomics.compareExchange);
  try {
    f.abi.imports.signal!(2, 2);
    f.abi.imports.signal!(15, 2);
    requestSignal(f.signals, 2);
    requestSignal(f.signals, 15);
    expect(() => f.abi.imports.interrupted!()).toThrow(ProcessSignalExit);
    expect(raced).toBe(true);
    expect(controlLoad(f.signals.interrupt, 0)).toBe(9);
    expect(controlLoad(f.signals.requestedSignal, 0)).toBe(9);
  } finally {
    hook.mockRestore();
    f.dispose();
  }
});

for (const signal of [2, 9, 15])
  test(`runtime_proc.signal(0,4) admits fatal signal ${signal} as a typed unwind`, () => {
    const f = fixture();
    try {
      f.abi.imports.signal!(2, 2);
      requestSignal(f.signals, 2);
      claimOutcome(f.signals.outcome, { kind: "signaled", code: signal });
      const pending = controlLoad(f.signals.signalState, 2),
        interrupt = controlLoad(f.signals.interrupt, 0);
      let thrown: unknown;
      try {
        f.abi.imports.signal!(0, 4);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProcessSignalExit);
      expect((thrown as ProcessSignalExit).signal).toBe(signal);
      expect((thrown as ProcessSignalExit).status).toBe(128 + signal);
      expect(controlLoad(f.signals.signalState, 2)).toBe(pending);
      expect(controlLoad(f.signals.interrupt, 0)).toBe(interrupt);
    } finally {
      f.dispose();
    }
  });
