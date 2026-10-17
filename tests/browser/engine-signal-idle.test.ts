import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transferArrayBuffers } from "../src/buffer-transfer.ts";

// Exercise the actual host turn without loading a guest or changing the test runner's globals.
const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
const EngineHost = runInNewContext(source + "\nEngineHost;", { TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, transferArrayBuffers });

function turn(next: number, pendingAsync = 0, io = 0, signal = true) {
  const order: string[] = [];
  const delays: number[] = [];
  let finished = 0;
  const host = Object.assign(Object.create(EngineHost.prototype), {
    exited: false, testComplete: false, pendingAsync, o: {},
    native: { hostCaps: { signal } },
    internal: {
      pumpSignals() { order.push("signals"); return false; },
      runTimers() { order.push("timers"); return next; },
      ioPending() { return io; }, pumpIo() { return false; },
    },
    guard<T>(callback: () => T) { return callback(); },
    schedule(delay: number) { delays.push(delay); },
    flush() {}, finish() { finished++; },
  });
  return { host, order, delays, finished: () => finished };
}

test("host engine dispatches signals before timer callbacks", () => {
  const f = turn(1000);
  f.host.pump();
  expect(f.order).toEqual(["signals", "timers"]);
  expect(f.delays).toEqual([25]);
});

for (const [pending, io] of [[1, 0], [0, 1]]) test(`host idle signal delivery polls while pending=${pending} io=${io}`, () => {
  const f = turn(-1, pending, io);
  f.host.pump();
  expect(f.delays).toEqual([25]);
  expect(f.finished()).toBe(0);
});

test("registered signal handlers do not keep an otherwise idle guest alive", () => {
  const f = turn(-1);
  f.host.pump();
  expect(f.delays).toEqual([]);
  expect(f.finished()).toBe(1);
});

test("short timers and hosts without signal support retain their delay", () => {
  const short = turn(2);
  short.host.pump();
  expect(short.delays).toEqual([2]);
  const unsupported = turn(1000, 0, 0, false);
  unsupported.host.pump();
  expect(unsupported.delays).toEqual([1000]);
});

test("signal handler exit does not run another timer or finish again", () => {
  const f = turn(0);
  f.host.internal.pumpSignals = () => { f.order.push("signal exit"); f.host.exited = true; };
  f.host.pump();
  expect(f.order).toEqual(["signal exit"]);
  expect(f.delays).toEqual([]);
  expect(f.finished()).toBe(0);
});

for (const [input, expected] of [[-1, 255], [-2147483648, 0], [256, 0], [511, 255], [143, 143], [0, 0], [undefined, 0]]) {
  test(`host-engine exit ${input} publishes byte status ${expected}`, () => {
    const statuses: number[] = [];
    const host = Object.assign(Object.create(EngineHost.prototype), { exit(code: number) { statuses.push(code); } });
    expect(() => host.valueNatives().exit(input)).toThrow();
    expect(statuses).toEqual([expected]);
  });
}
