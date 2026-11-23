import { controlLoad } from "../proc/control.js";
import { expect, test } from "bun:test";
import { fatalInterrupt } from "../interrupt/check.js";
import { claimOutcome, outcomeWord } from "../proc/outcome.js";
import {
  createSignalState,
  requestSignal,
  setSignalDisposition,
  takeSignal,
} from "../proc/signals.js";

function transport() {
  return {
    outcome: outcomeWord(),
    signalState: createSignalState(),
    interrupt: new Int32Array(new SharedArrayBuffer(4)),
    requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
  };
}

test("injected checkpoints observe recorded default actions without inferring a trap status", () => {
  for (const signal of [2, 9, 13, 15]) {
    const state = transport();
    expect(fatalInterrupt(state.outcome)).toBe(0);
    requestSignal(state, signal);
    expect(fatalInterrupt(state.outcome)).toBe(signal);
    expect(fatalInterrupt(state.outcome)).toBe(signal);
  }
});

test("a handled signal remains queued for a cooperative guest's existing handler checkpoint", () => {
  const state = transport();
  setSignalDisposition(state.signalState, 2, 2);
  requestSignal(state, 2);
  expect(controlLoad(state.interrupt, 0)).toBe(2);
  expect(fatalInterrupt(state.outcome)).toBe(0);
  expect(takeSignal(state.signalState)).toBe(2);
  expect(takeSignal(state.signalState)).toBe(0);
});

test("ordinary completion and missing shared state are never relabeled as a signal", () => {
  const state = transport();
  claimOutcome(state.outcome, { kind: "exited", code: 143 });
  requestSignal(state, 15);
  expect(fatalInterrupt(state.outcome)).toBe(0);
  expect(fatalInterrupt(null)).toBe(0);
});

test("a polling taker keeps every handled signal armed through the wake hint", () => {
  const state = transport();
  for (const signal of [2, 10, 28]) setSignalDisposition(state.signalState, signal, 2);
  // Nothing pending: the clear hint answers without consuming anything.
  expect(takeSignal(state.signalState, state.interrupt)).toBe(0);
  requestSignal(state, 10);
  requestSignal(state, 2);
  requestSignal(state, 28);
  // Each take re-arms the hint while another pending bit remains.
  const taken = [0, 0, 0].map(() => takeSignal(state.signalState, state.interrupt));
  expect(taken.toSorted((a, b) => a - b)).toEqual([2, 10, 28]);
  expect(controlLoad(state.interrupt, 0)).toBe(0);
  expect(takeSignal(state.signalState, state.interrupt)).toBe(0);
  // A stale hint with nothing pending is cleared by the full scan.
  state.interrupt[0] = 10;
  expect(takeSignal(state.signalState, state.interrupt)).toBe(0);
  expect(controlLoad(state.interrupt, 0)).toBe(0);
  // Re-registering a handler keeps a delivered pending bit and its hint.
  requestSignal(state, 28);
  setSignalDisposition(state.signalState, 28, 2, state.interrupt);
  expect(takeSignal(state.signalState, state.interrupt)).toBe(28);
});
