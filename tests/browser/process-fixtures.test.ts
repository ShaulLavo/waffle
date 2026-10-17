import { expect, test } from "bun:test";
import { createSignalState, publishSignal, setSignalDisposition, signalDisposition, takeSignal } from "../../runtime/proc/signals";
import { processFixture, processFixtureModes, type ProcessFixture } from "./process-fixtures";

test.each(processFixtureModes)("original preview1 %s fixture validates without toolchains", mode => {
  expect(WebAssembly.validate(processFixture(mode))).toBe(true);
});
function instantiate(mode: ProcessFixture, signal = 0, writeError = 0) {
  let writes = 0, defaultSignal = 0;
  const state = createSignalState();
  const registrations: number[][] = [];
  const published: string[] = [];
  const dequeue = () => {
    const pending = takeSignal(state);
    // Bound CPU fixtures in unit tests; browser integration exercises their real live loops.
    if (!pending) throw new Error("no pending signal");
    return pending;
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(processFixture(mode)), {
    wasi_snapshot_preview1: {
      fd_write: () => { writes++; if (signal) published.push(publishSignal(state, signal)); return writeError; },
      proc_exit: (code: number) => { throw new Error(`guest exit ${code}`); },
    },
    runtime_proc: {
      interrupted: dequeue,
      signal: (sig: number, disposition: number) => {
        if (sig === 0 && disposition === 0) return dequeue();
        registrations.push([sig, disposition]);
        try { setSignalDisposition(state, sig, disposition); return 0; } catch { return -22; }
      },
      default_signal: (value: number) => { defaultSignal = value; },
    },
  });
  return { start: instance.exports._start as () => void, writes: () => writes, defaultSignal: () => defaultSignal, state, registrations, published };
}
test.each([2, 15, 13, 9])("unregistered CPU fixture leaves signal %s to the supervisor default action", signal => {
  const guest = instantiate("default", signal);
  expect(guest.start).toThrow("no pending signal");
  expect(guest.registrations).toEqual([]);
  expect(guest.published).toEqual(["default"]);
  expect(guest.defaultSignal()).toBe(0);
});
test("active INT handler cannot dequeue or reinterpret uncatchable KILL", () => {
  const guest = instantiate("handling", 9);
  expect(guest.start).toThrow("no pending signal");
  expect(guest.registrations).toEqual([[2, 2]]);
  expect(guest.published).toEqual(["default"]);
  expect(signalDisposition(guest.state, 9)).toBe(0);
  expect(guest.defaultSignal()).toBe(0);
});
test("explicit default action traps even if default_signal mistakenly returns", () => {
  const guest = instantiate("explicit-default", 2);
  expect(guest.start).toThrow(WebAssembly.RuntimeError);
  expect(guest.defaultSignal()).toBe(2);
  expect(guest.writes()).toBe(1);
});
test.each([["handled", 2], ["handled-term", 15]] as const)("%s registers before readiness, consumes signal %s and returns normally", (mode, signal) => {
  const guest = instantiate(mode, signal);
  guest.start();
  expect(guest.registrations).toEqual([[signal, 2]]);
  expect(guest.published).toEqual(["handled"]);
  expect(guest.defaultSignal()).toBe(0);
  expect(guest.writes()).toBe(1);
  expect(takeSignal(guest.state)).toBe(0);
});
test.each([["handled-term-23", 23], ["handled-term-143", 143], ["handled-pipe", 42]] as const)("%s uses an explicit handled disposition and retains own status %s", (mode, code) => {
  const signal = mode === "handled-pipe" ? 13 : 15;
  const guest = instantiate(mode, signal);
  expect(guest.start).toThrow(`guest exit ${code}`);
  expect(guest.registrations).toEqual([[signal, 2]]);
  expect(guest.published).toEqual(["handled"]);
  expect(guest.defaultSignal()).toBe(0);
  expect(takeSignal(guest.state)).toBe(0);
});
test("removing the last handler after dequeue restores default for the next signal", () => {
  const guest = instantiate("removed", 2);
  expect(guest.start).toThrow("no pending signal");
  expect(guest.registrations).toEqual([[2, 2], [2, 0]]);
  expect(guest.published).toEqual(["handled", "default"]);
  expect(signalDisposition(guest.state, 2)).toBe(0);
  expect(takeSignal(guest.state)).toBe(0);
});
test("ignored PIPE publishes no pending work", () => {
  const guest = instantiate("ignored-pipe", 13);
  expect(guest.start).toThrow("no pending signal");
  expect(guest.registrations).toEqual([[13, 1], [2, 2]]);
  expect(guest.published).toEqual(["ignore"]);
  expect(takeSignal(guest.state)).toBe(0);
});
test.each(["epipe", "epipe-ignored"] as const)("%s registers PIPE before fd_write and handles actual EPIPE with own status42", mode => {
  const guest = instantiate(mode, 13, 64);
  expect(guest.start).toThrow("guest exit 42");
  expect(guest.registrations).toEqual([[13, mode === "epipe" ? 2 : 1]]);
  expect(guest.defaultSignal()).toBe(0);
  expect(instantiate(mode).start).toThrow(WebAssembly.RuntimeError);
});
test("handled signal followed by unrelated trap is distinguishable from default action", () => {
  const guest = instantiate("handled-trap", 2);
  expect(guest.start).toThrow(WebAssembly.RuntimeError);
  expect(guest.defaultSignal()).toBe(0);
});
