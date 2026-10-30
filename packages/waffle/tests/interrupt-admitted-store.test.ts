import { expect, spyOn, test } from "bun:test";
import {
  ADMITTED_CACHE_PREFIX,
  ADMITTED_DIGEST_HEADER,
  ADMITTED_STORE_LIMITS,
  CacheStorageAdmittedStore,
  admittedKey,
  cacheStorageAdmittedStore,
  interruptTransformId,
  sha256Hex,
} from "../interrupt/admitted-store.js";
import { INTERRUPT_REWRITER_REVISION } from "../interrupt/rewriter-internal.js";
import { rewriteInterrupts } from "../interrupt/rewriter.js";
import { emptyWasm } from "./interrupt-admitted-fixture.js";
import { MemoryCacheStorage } from "./interrupt-cache-storage-fixture.js";

const origin = "https://example.test";
const hash = "a".repeat(64);

test("identity binds revision, current rewrite options and resource limits", () => {
  const id = interruptTransformId();
  expect(id).toContain(`interrupt-r${INTERRUPT_REWRITER_REVISION}-countdown-4096`);
  for (const limit of Object.values(ADMITTED_STORE_LIMITS)) expect(id).toContain(String(limit));
  expect(admittedKey(origin, hash)).toBe(`${origin}/__waffle/admitted/${id}/${hash}.wasm`);
  expect(interruptTransformId({ ...ADMITTED_STORE_LIMITS, maxEntries: 1 })).not.toBe(id);
});

test("stored bodies have exactly identity encoding, size and admitted digest headers", async () => {
  const storage = new MemoryCacheStorage();
  const store = new CacheStorageAdmittedStore(storage, origin);
  const bytes = rewriteInterrupts(emptyWasm());
  await store.put(hash, bytes);
  const entry = (await store.open(hash))!;
  expect(Array.from(entry.response.headers.keys()).sort()).toEqual([
    "content-length",
    "content-type",
    ADMITTED_DIGEST_HEADER,
  ]);
  expect(entry.response.headers.get("content-type")).toBe("application/wasm");
  expect(entry.response.headers.get("content-length")).toBe(String(bytes.length));
  expect(entry.admittedSha256).toBe(await sha256Hex(bytes));
  expect(new Uint8Array(await entry.response.arrayBuffer())).toEqual(bytes);
});

test("obsolete cleanup touches only the exact admitted cache prefix", async () => {
  const storage = new MemoryCacheStorage();
  for (const name of ["waffle-admitted:other", "waffle-admitted-ish", "http-assets"])
    await storage.open(name);
  const store = new CacheStorageAdmittedStore(storage, origin);
  await store.open(hash);
  expect(await storage.keys()).toEqual([
    "waffle-admitted-ish",
    "http-assets",
    ADMITTED_CACHE_PREFIX + interruptTransformId(),
  ]);
});

test("malformed metadata is removed instead of becoming a hit", async () => {
  const storage = new MemoryCacheStorage();
  const store = new CacheStorageAdmittedStore(storage, origin);
  await store.open(hash);
  const cache = await storage.open(ADMITTED_CACHE_PREFIX + interruptTransformId());
  const good = {
    "content-type": "application/wasm",
    "content-length": "8",
    [ADMITTED_DIGEST_HEADER]: hash,
  };
  const invalidHeaders = [
    { ...good, "content-length": "NaN" },
    { ...good, "content-length": "0" },
    { ...good, "content-length": String(ADMITTED_STORE_LIMITS.maxEntryBytes + 1) },
    { ...good, "content-type": "text/plain" },
    { ...good, "content-encoding": "gzip" },
    { ...good, [ADMITTED_DIGEST_HEADER]: "not-a-digest" },
  ];
  for (const headers of invalidHeaders) {
    await cache.put(admittedKey(origin, hash), new Response(emptyWasm(), { headers }));
    expect(await store.open(hash)).toBeUndefined();
    expect(await cache.match(admittedKey(origin, hash))).toBeUndefined();
  }
});

test("entry and byte capacity evict FIFO, and oversized writes do not store", async () => {
  const storage = new MemoryCacheStorage();
  const limits = { maxEntries: 2, maxEntryBytes: 8, maxTotalBytes: 12 };
  const store = new CacheStorageAdmittedStore(storage, origin, limits);
  await store.put("oversize", new Uint8Array(9));
  expect(await storage.keys()).toEqual([]);
  await store.put("a", new Uint8Array(4));
  await store.put("b", new Uint8Array(4));
  await store.put("c", new Uint8Array(4));
  expect(await store.open("a")).toBeUndefined();
  expect(await store.open("b")).toBeDefined();
  await store.put("d", new Uint8Array(8));
  expect(await store.open("b")).toBeUndefined();
  expect(await store.open("c")).toBeDefined();
  await store.put("e", new Uint8Array(8));
  expect(await store.open("c")).toBeUndefined();
  expect(await store.open("d")).toBeUndefined();
  expect(await store.open("e")).toBeDefined();
});

test("the thirty-third production put evicts only the oldest key", async () => {
  const store = new CacheStorageAdmittedStore(new MemoryCacheStorage(), origin);
  await Promise.all(Array.from({ length: 33 }, (_, i) => store.put(String(i), emptyWasm())));
  expect(await store.open("0")).toBeUndefined();
  expect(await store.open("1")).toBeDefined();
  expect(await store.open("32")).toBeDefined();
});

test("storage errors are visible and a later operation can recover", async () => {
  const storage = new MemoryCacheStorage();
  const open = storage.open.bind(storage);
  storage.open = async () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  const store = new CacheStorageAdmittedStore(storage, origin);
  performance.clearMeasures();
  expect(await store.open(hash)).toBeUndefined();
  await store.put(hash, emptyWasm());
  await store.evict(hash);
  expect(performance.getEntriesByName("waffle:program:store-error")).toHaveLength(3);
  storage.open = open;
  await store.put(hash, emptyWasm());
  expect(await store.open(hash)).toBeDefined();
});

test("unavailable streaming, caches and non-http origins preserve admission-only mode", () => {
  const descriptors = ["caches", "location"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const streaming = WebAssembly.compileStreaming;
  try {
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: new MemoryCacheStorage(),
    });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
    expect(cacheStorageAdmittedStore()).not.toBeNull();
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "file://" },
    });
    expect(cacheStorageAdmittedStore()).toBeNull();
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
    Reflect.deleteProperty(WebAssembly, "compileStreaming");
    expect(cacheStorageAdmittedStore()).toBeNull();
    WebAssembly.compileStreaming = streaming;
    Reflect.deleteProperty(globalThis, "caches");
    expect(cacheStorageAdmittedStore()).toBeNull();
  } finally {
    WebAssembly.compileStreaming = streaming;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("eviction reserves mutation order before a later repair", async () => {
  const storage = new MemoryCacheStorage();
  const store = new CacheStorageAdmittedStore(storage, origin);
  const admitted = rewriteInterrupts(emptyWasm());
  await store.put(hash, admitted);
  const digest = await crypto.subtle.digest("SHA-256", admitted);
  const hashing = spyOn(crypto.subtle, "digest").mockResolvedValue(digest);
  const cache = await storage.open(ADMITTED_CACHE_PREFIX + interruptTransformId());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const remove = cache.delete.bind(cache);
  const deleting = spyOn(cache, "delete").mockImplementation(async (key) => {
    entered.resolve();
    await release.promise;
    return remove(key);
  });
  const writing = spyOn(cache, "put");
  const removal = store.evict(hash);
  await entered.promise;
  const repair = store.put(hash, admitted);
  try {
    // Drain resolved storage and digest jobs while deletion remains deliberately held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writing).toHaveBeenCalledTimes(0);
    release.resolve();
    await Promise.all([removal, repair]);
    expect(writing).toHaveBeenCalledTimes(1);
    expect(await store.open(hash)).toBeDefined();
  } finally {
    release.resolve();
    await Promise.all([removal, repair]);
    deleting.mockRestore();
    writing.mockRestore();
    hashing.mockRestore();
  }
});
