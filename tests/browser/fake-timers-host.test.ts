import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { transferArrayBuffers } from "../src/buffer-transfer.ts";

const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");

test("restoring guest Date replaces an armed host wakeup with the earlier real timer", async () => {
  const context = createContext({ TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, transferArrayBuffers });
  const EngineHost = runInContext(source + "\nEngineHost;", context);
  const host = Object.assign(Object.create(EngineHost.prototype), {
    exited: false, timer: null, timerAt: Infinity,
  });
  const realDate = runInContext("Date", context);
  let wakeTime = 0;
  const wake = new Promise<void>(resolve => {
    host.pump = () => { wakeTime = Date.now(); resolve(); };
  });
  try {
    runInContext("globalThis.savedDate = Date; globalThis.Date = { now: () => 0 };", context);
    host.schedule(1000);
    const armed = host.timer;
    runInContext("globalThis.Date = savedDate;", context);
    const start = Date.now();
    host.schedule(1);
    expect(host.timer).not.toBe(armed);
    await wake;
    expect(wakeTime - start).toBeLessThan(500);
  } finally {
    context.Date = realDate;
    if (host.timer !== null) clearTimeout(host.timer);
  }
});

test("the browser fake checkpoint drains runtime nextTicks synchronously", () => {
  const context = createContext({ TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, transferArrayBuffers });
  const EngineHost = runInContext(source + "\nEngineHost;", context);
  let drained = false;
  const host = Object.assign(Object.create(EngineHost.prototype), {
    tickQueued: true,
    internal: { runTicks() { drained = true; } },
    guard<T>(callback: () => T) { return callback(); },
  });
  host.valueNatives().runMicrotasks();
  expect(drained).toBe(true);
  expect(host.tickQueued).toBe(false);
});
