import { expect, spyOn, test } from "bun:test";
import { moduleMemoryDeclarations, parseModuleMemory } from "../memory/declarations.js";
import { InterruptModuleCache } from "../interrupt/loader.js";
import {
  ADMITTED_STORE_LIMITS,
  CacheStorageAdmittedStore,
  admittedKey,
  interruptTransformId,
  sha256Hex,
  type AdmittedModuleStore,
} from "../interrupt/admitted-store.js";
import { rewriteInterrupts } from "../interrupt/rewriter.js";
import { MemoryCacheStorage } from "./interrupt-cache-storage-fixture.js";
import { interruptLoopFixture } from "./fixtures/interrupt-browser-loops.js";
import { interruptWaitFixture } from "./fixtures/interrupt-wait-wasm.js";
import { fatalInterrupt, terminalInterrupt } from "../interrupt/check.js";
import { claimOutcome, outcomeWord } from "../proc/outcome.js";

const names = (module: WebAssembly.Module) =>
  WebAssembly.Module.imports(module)
    .filter((entry) => entry.module === "runtime_proc")
    .map((entry) => entry.name);
const ordinary = ["__waffle_fatal"];
const supervised = ordinary.concat(["__waffle_wait32", "__waffle_wait64"]);

function persistent() {
  const storage = new MemoryCacheStorage();
  const backing = new CacheStorageAdmittedStore(storage, "https://example.test");
  const writes: Promise<void>[] = [];
  const store: AdmittedModuleStore = {
    open: (hash, profile) => backing.open(hash, profile),
    evict: (hash, profile) => backing.evict(hash, profile),
    put(hash, bytes, profile) {
      const pending = backing.put(hash, bytes, profile);
      writes.push(pending);
      return pending;
    },
  };
  return { storage, backing, store, flush: () => Promise.all(writes) };
}

test("source, compiled and persisted identities distinguish supervised waits from ordinary admission", async () => {
  const source = interruptLoopFixture();
  const hash = await sha256Hex(source);
  const data = persistent();
  const cache = new InterruptModuleCache(16, data.store);
  const [base, threads] = await Promise.all([
    cache.compile(source),
    cache.compile(source, "supervised-thread"),
  ]);
  expect(base).not.toBe(threads);
  expect(names(base)).toEqual(ordinary);
  expect(names(threads)).toEqual(supervised);
  expect(await cache.compile(source)).toBe(base);
  expect(await cache.compile(source, "supervised-thread")).toBe(threads);
  await data.flush();
  expect(await data.storage.keys()).toHaveLength(2);
  expect(interruptTransformId()).not.toBe(
    interruptTransformId(ADMITTED_STORE_LIMITS, "supervised-thread"),
  );
  expect(admittedKey("https://example.test", hash)).not.toBe(
    admittedKey("https://example.test", hash, ADMITTED_STORE_LIMITS, "supervised-thread"),
  );
  expect(names(await new InterruptModuleCache(16, data.store).compile(source))).toEqual(ordinary);
  expect(
    names(await new InterruptModuleCache(16, data.store).compile(source, "supervised-thread")),
  ).toEqual(supervised);
});

test("persisted bytes with the wrong profile are rejected even with a valid body digest", async () => {
  const source = interruptLoopFixture();
  const hash = await sha256Hex(source);
  const data = persistent();
  await data.backing.put(hash, rewriteInterrupts(source, { profile: "supervised-thread" }));
  await data.backing.put(hash, rewriteInterrupts(source), "supervised-thread");
  const cache = new InterruptModuleCache(16, data.store);
  expect(names(await cache.compile(source))).toEqual(ordinary);
  expect(names(await cache.compile(source, "supervised-thread"))).toEqual(supervised);
  await data.flush();
});

test("ordinary wait rejection remains independent of a supervised cache hit", async () => {
  const cache = new InterruptModuleCache();
  const source = interruptWaitFixture();
  expect(names(await cache.compile(source, "supervised-thread"))).toEqual(supervised);
  await expect(cache.compile(source)).rejects.toThrow(/atomic.wait/);
  expect(() => rewriteInterrupts(source)).toThrow(/atomic.wait/);
});

test("the supervised profile cannot bind memory created after its compiler start section", () => {
  const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  expect(() => rewriteInterrupts(empty, { profile: "supervised-thread" })).toThrow(
    /imported shared env.memory/,
  );
});

test("terminal checkpoints preserve every selected result and leave ordinary signals unchanged", () => {
  expect(terminalInterrupt(null)).toBe(0);
  for (const kind of ["exited", "signaled", "start-failed"] as const) {
    const word = outcomeWord();
    expect(terminalInterrupt(word)).toBe(0);
    claimOutcome(word, { kind, code: kind === "exited" ? 0 : kind === "signaled" ? 9 : 8 });
    expect(terminalInterrupt(word)).toBe(1);
    expect(fatalInterrupt(word)).toBe(kind === "signaled" ? 9 : 0);
  }
});

for (const profile of ["ordinary", "supervised-thread"] as const) {
  test(`${profile} memory declarations survive fresh and stored profile compilation`, async () => {
    const source = interruptLoopFixture();
    const expected = parseModuleMemory(source);
    const data = persistent();
    const first = await new InterruptModuleCache(16, data.store).compile(source, profile);
    expect(moduleMemoryDeclarations(first)).toEqual(expected);
    await data.flush();
    const compile = spyOn(WebAssembly, "compile");
    try {
      const stored = await new InterruptModuleCache(16, data.store).compile(source, profile);
      expect(moduleMemoryDeclarations(stored)).toEqual(expected);
      expect(names(stored)).toEqual(profile === "ordinary" ? ordinary : supervised);
      expect(compile).toHaveBeenCalledTimes(0);
    } finally {
      compile.mockRestore();
    }
  });
}
