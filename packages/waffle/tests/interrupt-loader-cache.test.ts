import { expect, spyOn, test } from "bun:test";
import { InterruptModuleCache } from "../interrupt/loader.js";
import { emptyWasm, tickWasm } from "./interrupt-admitted-fixture.js";
import { interruptLoopFixture } from "./fixtures/interrupt-browser-loops.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { Signal, type SpawnRequest } from "../proc/types.js";

const source = (id: number) => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 3, 1, 120, id]);

function compilerInput(bytes: ArrayBufferLike | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (!ArrayBuffer.isView(bytes) || !(bytes.buffer instanceof ArrayBuffer))
    throw new Error("Expected unshared admitted bytes");
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function heldCompiler() {
  const compile = WebAssembly.compile;
  const release = Promise.withResolvers<void>();
  const arrivals: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const spy = spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
    arrivals[spy.mock.calls.length - 1]?.resolve();
    await release.promise;
    return compile(compilerInput(bytes));
  });
  return {
    spy,
    entered(index: number) {
      const arrival = Promise.withResolvers<void>();
      arrivals[index] = arrival;
      if (spy.mock.calls.length > index) arrival.resolve();
      return arrival.promise;
    },
    async close(loads: Promise<unknown>[]) {
      release.resolve();
      await Promise.allSettled(loads);
    },
  };
}

function observeCache() {
  const events: unknown[] = [];
  const waiters = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const measure = performance.measure.bind(performance);
  function record(detail: unknown) {
    events.push(detail);
    if (typeof detail === "object" && detail !== null && "result" in detail)
      waiters.get(String(detail.result))?.resolve();
  }
  const spy = spyOn(performance, "measure").mockImplementation((name, options) => {
    if (name === "waffle:program:cache" && typeof options === "object") record(options.detail);
    return measure(name, options);
  });
  return {
    events,
    spy,
    next(result: string) {
      const waiter = Promise.withResolvers<void>();
      waiters.set(result, waiter);
      return waiter.promise;
    },
  };
}

test("held loads beyond completed capacity rejoin the oldest producer", async () => {
  const cache = new InterruptModuleCache();
  const compiler = heldCompiler();
  const observer = observeCache();
  const validate = spyOn(WebAssembly, "validate");
  const loads: Promise<WebAssembly.Module>[] = [];
  try {
    for (let id = 0; id < 17; id++) {
      loads.push(cache.compile(source(id)));
      await compiler.entered(id);
    }
    const joined = observer.next("join");
    loads.push(cache.compile(source(0)));
    await joined;
    await compiler.close(loads);
    const modules = await Promise.all(loads);
    expect(compiler.spy).toHaveBeenCalledTimes(17);
    expect(validate).toHaveBeenCalledTimes(34);
    expect(modules[17]).toBe(modules[0]);
  } finally {
    await compiler.close(loads);
    compiler.spy.mockRestore();
    validate.mockRestore();
    observer.spy.mockRestore();
  }
});

test("completed churn cannot remove an active producer", async () => {
  const cache = new InterruptModuleCache(1);
  const compile = WebAssembly.compile;
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const spy = spyOn(WebAssembly, "compile").mockImplementationOnce(async (bytes) => {
    entered.resolve();
    await release.promise;
    return compile(compilerInput(bytes));
  });
  const observer = observeCache();
  const loads: Promise<WebAssembly.Module>[] = [];
  try {
    loads.push(cache.compile(source(0)));
    await entered.promise;
    await cache.compile(source(1));
    await cache.compile(source(2));
    const joined = observer.next("join");
    loads.push(cache.compile(source(0)));
    await joined;
    release.resolve();
    expect(await loads[1]).toBe(await loads[0]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(observer.events.at(-1)).toMatchObject({ activeEntries: 0, activeSourceBytes: 0 });
  } finally {
    release.resolve();
    await Promise.allSettled(loads);
    spy.mockRestore();
    observer.spy.mockRestore();
  }
});

test("cancellation and cache eviction preserve peers and preloaded registration ownership", async () => {
  const cache = new InterruptModuleCache(1);
  const registry = new ExecutableRegistry();
  const entry = { module: () => cache.compile(source(0)), adapter: "fixture" };
  registry.register("fixture", entry);
  registry.register("alias", entry);
  const supervisor = new ProcessSupervisor({
    registry,
    launch(context) {
      context.started();
      context.exit(0);
      return { terminate() {} };
    },
  });
  const root = supervisor.createRoot();
  const request: SpawnRequest = {
    executable: "fixture",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  };
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const compile = WebAssembly.compile;
  const spy = spyOn(WebAssembly, "compile").mockImplementationOnce(async (bytes) => {
    entered.resolve();
    await release.promise;
    return compile(compilerInput(bytes));
  });
  const preload = registry.resolve("fixture");
  const loads: Promise<unknown>[] = [preload];
  try {
    await entered.promise;
    const cancelled = supervisor.spawn(root, request);
    const peer = supervisor.spawn(root, { ...request, executable: "alias" });
    loads.push(supervisor.start(cancelled), supervisor.start(peer));
    supervisor.kill(cancelled, Signal.SIGKILL);
    await cache.compile(source(1));
    await cache.compile(source(2));
    release.resolve();
    await Promise.all(loads);
    expect(supervisor.wait(root, cancelled)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(supervisor.wait(root, peer)).toEqual({ kind: "exited", code: 0, status: 0 });
    const module = (await preload).module;
    expect(module).toBeInstanceOf(WebAssembly.Module);
    await cache.compile(source(3));
    expect(await cache.compile(source(0))).not.toBe(module);
    expect((await registry.resolve("fixture")).module).toBe(module);
    expect((await registry.resolve("alias")).module).toBe(module);
    expect(spy).toHaveBeenCalledTimes(5);
  } finally {
    release.resolve();
    await Promise.allSettled(loads);
    supervisor.dispose();
    spy.mockRestore();
  }
});

test("joined failure releases ownership before a retry and late callers cannot clear it", async () => {
  const cache = new InterruptModuleCache(1);
  const failure = new RangeError("injected compiler failure");
  const first = Promise.withResolvers<WebAssembly.Module>();
  const retryGate = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  const compile = WebAssembly.compile;
  const spy = spyOn(WebAssembly, "compile")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(async (bytes) => {
      await retryGate.promise;
      return compile(compilerInput(bytes));
    });
  const observer = observeCache();
  const loads: Promise<unknown>[] = [];
  try {
    const producer = observer.next("producer");
    const original = cache.compile(source(0));
    loads.push(original);
    await producer;
    const joined = observer.next("join");
    const peer = cache.compile(source(0));
    loads.push(peer);
    await joined;
    const retryStarted = observer.next("producer");
    const retry = original.catch((error: unknown) => {
      expect(error).toBe(failure);
      return cache.compile(source(0));
    });
    const delayed = peer.catch(async (error: unknown) => {
      await late.promise;
      expect(error).toBe(failure);
      return cache.compile(source(0));
    });
    loads.push(retry, delayed);
    first.reject(failure);
    await retryStarted;
    const retryJoined = observer.next("join");
    late.resolve();
    await retryJoined;
    retryGate.resolve();
    expect(await delayed).toBe(await retry);
    expect(await cache.compile(source(0))).toBe(await retry);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(observer.events.at(-1)).toMatchObject({
      result: "hit",
      activeEntries: 0,
      activeSourceBytes: 0,
    });
  } finally {
    first.reject(failure);
    late.resolve();
    retryGate.resolve();
    await Promise.allSettled(loads);
    spy.mockRestore();
    observer.spy.mockRestore();
  }
});

test.each([
  { maxActiveEntries: 2, maxActiveBytes: 1000 },
  { maxActiveEntries: 10, maxActiveBytes: source(0).length * 2 },
])("active admission is bounded while joins remain allowed: %j", async (limits) => {
  const cache = new InterruptModuleCache(1, null, limits);
  const compiler = heldCompiler();
  const observer = observeCache();
  const loads: Promise<WebAssembly.Module>[] = [];
  try {
    loads.push(cache.compile(source(0)));
    await compiler.entered(0);
    loads.push(cache.compile(source(1)));
    await compiler.entered(1);
    await expect(cache.compile(source(2))).rejects.toThrow("active load budget");
    const joined = observer.next("join");
    loads.push(cache.compile(source(0)));
    await joined;
    expect(compiler.spy).toHaveBeenCalledTimes(2);
    await compiler.close(loads);
    expect(await loads[2]).toBe(await loads[0]);
    await cache.compile(source(2));
    expect(compiler.spy).toHaveBeenCalledTimes(3);
  } finally {
    await compiler.close(loads);
    compiler.spy.mockRestore();
    observer.spy.mockRestore();
  }
});

test("completed count and source bytes evict the least recently used module", async () => {
  for (const limits of [
    { capacity: 2, bytes: 1000 },
    { capacity: 10, bytes: 26 },
  ]) {
    const cache = new InterruptModuleCache(limits.capacity, null, {
      maxRetainedBytes: limits.bytes,
    });
    const first = await cache.compile(source(0));
    const second = await cache.compile(source(1));
    expect(await cache.compile(source(0))).toBe(first);
    await cache.compile(source(2));
    expect(await cache.compile(source(0))).toBe(first);
    expect(await cache.compile(source(1))).not.toBe(second);
  }
});

test("completed idle expiry is lazy, refreshes on hits and never revokes a held module", async () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const cache = new InterruptModuleCache(2, null, { maxIdleMs: 10 });
    const module = await cache.compile(source(0));
    now = 9;
    expect(await cache.compile(source(0))).toBe(module);
    now = 18;
    expect(await cache.compile(source(0))).toBe(module);
    now = 28;
    expect(await cache.compile(source(0))).not.toBe(module);
    expect(
      new WebAssembly.Instance(module, { runtime_proc: { __waffle_fatal: () => 0 } }),
    ).toBeInstanceOf(WebAssembly.Instance);
  } finally {
    clock.mockRestore();
  }
});

test("oversized completed modules are shared while active but never retained", async () => {
  const cache = new InterruptModuleCache(16, null, { maxRetainedBytes: 8 });
  const compiler = heldCompiler();
  const observer = observeCache();
  const loads: Promise<WebAssembly.Module>[] = [];
  try {
    loads.push(cache.compile(source(0)));
    await compiler.entered(0);
    const joined = observer.next("join");
    loads.push(cache.compile(source(0)));
    await joined;
    await compiler.close(loads);
    expect(await loads[1]).toBe(await loads[0]);
    expect(await cache.compile(source(0))).not.toBe(await loads[0]);
    expect(compiler.spy).toHaveBeenCalledTimes(2);
  } finally {
    await compiler.close(loads);
    compiler.spy.mockRestore();
    observer.spy.mockRestore();
  }
});

test("oversized active source is rejected before copying or hashing", async () => {
  const cache = new InterruptModuleCache(16, null, { maxActiveBytes: 8 });
  const digest = spyOn(crypto.subtle, "digest");
  try {
    await expect(cache.compile(source(0))).rejects.toThrow("source exceeds");
    expect(digest).not.toHaveBeenCalled();
    expect(await cache.compile(emptyWasm())).toBeInstanceOf(WebAssembly.Module);
  } finally {
    digest.mockRestore();
  }
});

test.each(["maxRetainedBytes", "maxIdleMs", "maxActiveEntries", "maxActiveBytes"])(
  "%s must be a positive safe integer",
  (key) => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => new InterruptModuleCache(16, null, { [key]: value })).toThrow(RangeError);
  },
);

test("the admitted empty, tick and loop workload reports producers, joins, hits and source bytes", async () => {
  const cache = new InterruptModuleCache();
  const observer = observeCache();
  const sources = [emptyWasm(), tickWasm(), interruptLoopFixture()];
  try {
    for (const bytes of sources) {
      const pair = await Promise.all([cache.compile(bytes), cache.compile(bytes)]);
      expect(pair[0]).toBe(pair[1]);
      expect(await cache.compile(bytes)).toBe(pair[0]);
    }
    expect(observer.events).toHaveLength(12);
    expect(observer.events.at(-1)).toEqual({
      result: "hit",
      activeEntries: 0,
      activeSourceBytes: 0,
      retainedEntries: 3,
      retainedSourceBytes: sources.reduce((total, bytes) => total + bytes.byteLength, 0),
    });
    for (const result of ["producer", "join", "hit", "settled"])
      expect(
        observer.events.filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "result" in entry &&
            entry.result === result,
        ),
      ).toHaveLength(3);
  } finally {
    observer.spy.mockRestore();
  }
});
