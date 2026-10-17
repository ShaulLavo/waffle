import { expect, spyOn, test } from "bun:test";
import type { RuntimeFilesystem } from "@bun-wasm/runtime";
import { createFilesystemIdentity } from "@bun-wasm/runtime/fs";
import { startRun } from "../src/runner";
import { SubprocessBroker, type ExecutableRegistration } from "../src/subprocess-broker";
import { processRuntimeFixture } from "./process-runtime-fixture";

test("a Preview1-first runtime does not register its guest as the immutable Bun engine program", async () => {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [];
  const registrations = new Map<string, ExecutableRegistration>();
  const register = SubprocessBroker.prototype.register;
  const registration = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(name, entry) {
    registrations.set(name, entry); return register.call(this, name, entry);
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    String(input).endsWith(".gz") ? new Response(null, { status: 404 })
      : new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { "content-type": "application/wasm" } }),
  { preconnect: globalThis.fetch.preconnect }));
  globalThis.Worker = class { postMessage() {} terminate() {} } as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = processRuntimeFixture({
    fork() { const channel = new MessageChannel(); ports.push(channel.port1, channel.port2); return { ...createFilesystemIdentity(), port: channel.port1 }; },
    revoke() {}, reap() {}, async quiesce() {},
  } as RuntimeFilesystem);
  const runs: ReturnType<typeof startRun>[] = [];
  try {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    runs.push(startRun({ runtime, engine: "browser", adapter: "preview1", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} }));
    runs.push(startRun({ runtime, engine: "browser", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} }));
    const program = registrations.get("bun-browser")!;
    expect(program.adapter).toBe("bun");
    if (!("module" in program)) throw new Error("Expected a compiled Bun engine program");
    expect(typeof program.module).toBe("function");
    const first = await (program.module as () => Promise<WebAssembly.Module>)();
    const second = await (program.module as () => Promise<WebAssembly.Module>)();
    expect(first).not.toBe(module);
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    for (const run of runs) run.kill(9);
    await Promise.all(runs.map(run => run.done));
    await runtime.dispose();
    registration.mockRestore(); fetch.mockRestore();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
});
