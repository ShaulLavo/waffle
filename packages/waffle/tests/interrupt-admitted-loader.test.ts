import { afterEach, expect, spyOn, test } from "bun:test";
import { InterruptModuleCache } from "../interrupt/loader.js";
import { sha256Hex, programStage, type AdmittedModuleStore } from "../interrupt/admitted-store.js";
import { rewriteInterrupts } from "../interrupt/rewriter.js";
import { MemoryAdmittedStore, emptyWasm, tickWasm } from "./interrupt-admitted-fixture.js";
import { interruptLoopFixture } from "./fixtures/interrupt-browser-loops.js";

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
});
function validations() {
  const spy = spyOn(WebAssembly, "validate");
  spies.push(spy);
  return spy;
}
function isInstrumented(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    (entry) => entry.module === "runtime_proc" && entry.name === "__waffle_fatal",
  );
}

test("the real engine compiles application/wasm Responses", async () => {
  expect(
    await WebAssembly.compileStreaming(
      new Response(emptyWasm(), { headers: { "content-type": "application/wasm" } }),
    ),
  ).toBeInstanceOf(WebAssembly.Module);
});

test("misses write admitted empty and loop modules without awaiting persistence", async () => {
  for (const source of [emptyWasm(), interruptLoopFixture()]) {
    const store = new MemoryAdmittedStore();
    const module = await new InterruptModuleCache(16, store).compile(source);
    await store.stored;
    expect(isInstrumented(module)).toBe(true);
    expect(store.puts).toBe(1);
    const entry = store.entries.get(await sha256Hex(source))!;
    expect(isInstrumented(await WebAssembly.compile(entry.bytes))).toBe(true);
  }
  const held: AdmittedModuleStore = {
    open: async () => undefined,
    evict: async () => {},
    put: () => new Promise(() => {}),
  };
  expect(isInstrumented(await new InterruptModuleCache(16, held).compile(emptyWasm()))).toBe(true);
});

test("a new realm cache streams admitted bytes and skips both validations", async () => {
  const store = new MemoryAdmittedStore();
  await new InterruptModuleCache(16, store).compile(emptyWasm());
  await store.stored;
  const validate = validations();
  const streaming = spyOn(WebAssembly, "compileStreaming");
  spies.push(streaming);
  expect(isInstrumented(await new InterruptModuleCache(16, store).compile(emptyWasm()))).toBe(true);
  expect(validate).toHaveBeenCalledTimes(0);
  expect(streaming).toHaveBeenCalledTimes(1);
  expect(store.puts).toBe(1);
});

test("aliases and concurrent views share one open, admission, put and module", async () => {
  const store = new MemoryAdmittedStore();
  const cache = new InterruptModuleCache(16, store);
  const validate = validations();
  const source = emptyWasm();
  const modules = await Promise.all([
    cache.compile(source),
    cache.compile(source.subarray()),
    cache.compile(source.slice()),
  ]);
  await store.stored;
  expect(modules[0]).toBe(modules[1]);
  expect(modules[0]).toBe(modules[2]);
  expect(store.opens).toBe(1);
  expect(store.puts).toBe(1);
  expect(validate).toHaveBeenCalledTimes(2);
});

test("a hit keeps countdown and fatal binding fresh per instance", async () => {
  const store = new MemoryAdmittedStore();
  await new InterruptModuleCache(16, store).compile(tickWasm());
  await store.stored;
  const module = await new InterruptModuleCache(16, store).compile(tickWasm());
  let callsA = 0,
    callsB = 0;
  const a = new WebAssembly.Instance(module, {
    runtime_proc: {
      __waffle_fatal: () => {
        callsA++;
        return 0;
      },
    },
  });
  const b = new WebAssembly.Instance(module, {
    runtime_proc: {
      __waffle_fatal: () => {
        callsB++;
        return 0;
      },
    },
  });
  const tickA = a.exports.tick,
    tickB = b.exports.tick;
  if (typeof tickA !== "function" || typeof tickB !== "function") throw new Error("missing tick");
  for (let i = 0; i < 4095; i++) tickA();
  for (let i = 0; i < 4095; i++) tickB();
  expect([callsA, callsB]).toEqual([0, 0]);
  tickA();
  expect([callsA, callsB]).toEqual([1, 0]);
  tickB();
  expect([callsA, callsB]).toEqual([1, 1]);
});

async function rejectedEntry(bytes: Uint8Array<ArrayBuffer>, digest: string) {
  const store = new MemoryAdmittedStore();
  store.entries.set(await sha256Hex(emptyWasm()), { bytes, digest });
  const validate = validations();
  expect(isInstrumented(await new InterruptModuleCache(16, store).compile(emptyWasm()))).toBe(true);
  expect(validate).toHaveBeenCalledTimes(2);
  expect(store.evictions).toBe(1);
  await store.stored;
}

test("a mismatched body digest is evicted and admitted normally", async () => {
  const admitted = rewriteInterrupts(emptyWasm());
  await rejectedEntry(admitted, "0".repeat(64));
});

test("raw source with its correct digest is not an interruptible cache hit", async () => {
  const bytes = emptyWasm();
  await rejectedEntry(bytes, await sha256Hex(bytes));
});

test("malformed stored Wasm falls back while invalid source still fails ENOEXEC", async () => {
  const bytes = new Uint8Array([0, 1]);
  await rejectedEntry(bytes, await sha256Hex(bytes));
  const store = new MemoryAdmittedStore();
  await expect(new InterruptModuleCache(16, store).compile(bytes)).rejects.toThrow(
    "Cannot instrument",
  );
  expect(store.puts).toBe(0);
});

test("throwing storage methods never hide admission and report storage failure", async () => {
  performance.clearMeasures();
  const fail = () => {
    throw new DOMException("unavailable", "SecurityError");
  };
  const stores: AdmittedModuleStore[] = [
    { open: fail, put: fail, evict: fail },
    {
      open: async () => undefined,
      put: async () => {
        fail();
      },
      evict: fail,
    },
    {
      open: async () => ({
        response: new Response(emptyWasm(), { headers: { "content-type": "application/wasm" } }),
        admittedSha256: await sha256Hex(emptyWasm()),
      }),
      put: fail,
      evict: fail,
    },
    {
      open: async () => ({ response: Response.error(), admittedSha256: "0".repeat(64) }),
      put: fail,
      evict: fail,
    },
  ];
  for (const store of stores)
    expect(isInstrumented(await new InterruptModuleCache(16, store).compile(emptyWasm()))).toBe(
      true,
    );
  await Promise.resolve();
  expect(performance.getEntriesByName("waffle:program:store-error").length).toBeGreaterThanOrEqual(
    4,
  );
});

test("genuine compiler failure is not normalized to a storage miss or retained", async () => {
  const store = new MemoryAdmittedStore();
  const cache = new InterruptModuleCache(16, store);
  const compile = spyOn(WebAssembly, "compile").mockRejectedValueOnce(new RangeError("allocation"));
  spies.push(compile);
  await expect(cache.compile(emptyWasm())).rejects.toThrow("allocation");
  expect(store.puts).toBe(0);
  expect(isInstrumented(await cache.compile(emptyWasm()))).toBe(true);
  expect(store.opens).toBe(2);
});

test("timing failures leave the original result and error untouched", async () => {
  const measure = spyOn(performance, "measure").mockImplementation(() => {
    throw new Error("observer failed");
  });
  spies.push(measure);
  expect(isInstrumented(await new InterruptModuleCache().compile(emptyWasm()))).toBe(true);
  await expect(new InterruptModuleCache().compile(new Uint8Array([0]))).rejects.toThrow(
    "Cannot instrument",
  );
  expect(() => programStage("source", 0, {}, 1)).not.toThrow();
});
