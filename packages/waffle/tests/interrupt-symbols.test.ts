import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { describeWorkerError } from "../browser/worker.js";
import { sha256Hex } from "../interrupt/admitted-store.js";
import { admittedModuleDiagnostics, InterruptModuleCache } from "../interrupt/loader.js";
import {
  annotateError,
  annotateStack,
  bindSymbolSidecar,
  fetchSymbolSidecar,
  loadSymbolTable,
  matchOwnedWasmFrame,
  parseSymbolSidecar,
  type WasmSymbolSidecar,
} from "../interrupt/symbols.js";
import { MemoryAdmittedStore, emptyWasm } from "./interrupt-admitted-fixture.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const packageRoot = resolve(import.meta.dir, "..");
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
});

function leb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const next = remaining >>> 7;
    bytes.push((remaining & 0x7f) | (next ? 0x80 : 0));
    remaining = next;
  } while (remaining);
  return bytes;
}

function wasmText(value: string): number[] {
  const bytes = Array.from(textEncoder.encode(value));
  return leb(bytes.length).concat(bytes);
}

function wasmSection(id: number, body: number[]): number[] {
  return [id].concat(leb(body.length), body);
}

function wasmList(items: number[][]): number[] {
  return leb(items.length).concat(items.flat());
}

function wasmFuncImport(mod: string, field: string, typeIndex: number): number[] {
  return wasmText(mod).concat(wasmText(field), [0], leb(typeIndex));
}

function wasmExport(field: string, kind: number, index: number): number[] {
  return wasmText(field).concat([kind], leb(index));
}

function wasmBody(ops: number[]): number[] {
  const body = [0].concat(ops, [0x0b]);
  return leb(body.length).concat(body);
}

function encodeWasm(sections: number[][]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(sections.flat()));
}

/** 2 imports (proc_exit, host_bridge) + 3 definitions: 2=_start, 3=outer, 4=inner_trap. */
function ordinaryGuestFixture(salt = 1): Uint8Array<ArrayBuffer> {
  const types = wasmSection(
    1,
    wasmList([
      [0x60, 0, 0],
      [0x60, 1, 0x7f, 0],
    ]),
  );
  const imports = wasmSection(
    2,
    wasmList([
      wasmFuncImport("wasi_snapshot_preview1", "proc_exit", 1),
      wasmFuncImport("env", "host_bridge", 0),
    ]),
  );
  const functions = wasmSection(3, [3, 0, 0, 0]);
  const memory = wasmSection(5, [1, 1, 1, 8]);
  const exports = wasmSection(
    7,
    wasmList([wasmExport("memory", 2, 0), wasmExport("_start", 0, 2)]),
  );
  const code = wasmSection(
    10,
    wasmList([wasmBody([0x10, 3]), wasmBody([0x41, salt & 0x3f, 0x1a, 0x10, 4]), wasmBody([0x00])]),
  );
  return encodeWasm([types, imports, functions, memory, exports, code]);
}

/** Shared-memory guest for supervised-thread (+3 shift): 1 import, 2 defs (1=_start, 2=inner_trap). */
function supervisedGuestFixture(): Uint8Array<ArrayBuffer> {
  const types = wasmSection(
    1,
    wasmList([
      [0x60, 0, 0],
      [0x60, 1, 0x7f, 0],
    ]),
  );
  const imports = wasmSection(
    2,
    wasmList([
      wasmFuncImport("wasi_snapshot_preview1", "proc_exit", 1),
      wasmText("env").concat(wasmText("memory"), [2, 3, 1, 4]),
    ]),
  );
  const functions = wasmSection(3, [2, 0, 0]);
  const exports = wasmSection(7, wasmList([wasmExport("_start", 0, 1)]));
  const code = wasmSection(10, wasmList([wasmBody([0x10, 2]), wasmBody([0x00])]));
  return encodeWasm([types, imports, functions, exports, code]);
}

function readSubsection0ModuleName(module: WebAssembly.Module): string | undefined {
  const sections = WebAssembly.Module.customSections(module, "name");
  if (sections.length !== 1) return undefined;
  const bytes = new Uint8Array(sections[0]!);
  if (bytes[0] !== 0) return undefined;
  const payloadLength = bytes[1]!;
  const stringLength = bytes[2]!;
  if (payloadLength !== stringLength + 1 || bytes.length !== payloadLength + 2) return undefined;
  return textDecoder.decode(bytes.subarray(3, 3 + stringLength));
}

async function encodeSidecar(
  source: Uint8Array<ArrayBuffer>,
  importedFunctions: number,
  names: readonly (string | null)[],
  overrides: Partial<Record<string, unknown>> = {},
) {
  const sourceSha = await sha256Hex(source);
  const payload = {
    version: 1,
    source: { bytes: source.byteLength, sha256: sourceSha },
    named: { bytes: source.byteLength + 64, sha256: "a".repeat(64) },
    importedFunctions,
    names,
    ...overrides,
  };
  const json = JSON.stringify(payload);
  const bytes = new Uint8Array(textEncoder.encode(json));
  const sha256 = await sha256Hex(bytes);
  return { payload: payload as WasmSymbolSidecar, bytes, sha256 };
}

function mockFetchOf(
  handler: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response> | Response,
) {
  return (input: string | URL, init?: { readonly signal?: AbortSignal }) =>
    Promise.resolve(handler(String(input), init));
}

test("disabled diagnostics emit no name section, record no facts, and never bundle symbols.ts", async () => {
  const store = new MemoryAdmittedStore();
  const source = ordinaryGuestFixture(1);
  const mod = await new InterruptModuleCache(16, store).compile(source);
  await store.stored;
  expect(admittedModuleDiagnostics(mod)).toBeUndefined();
  expect(WebAssembly.Module.customSections(mod, "name")).toEqual([]);

  const streaming = spyOn(WebAssembly, "compileStreaming");
  spies.push(streaming);
  const reused = await new InterruptModuleCache(16, store).compile(source);
  expect(admittedModuleDiagnostics(reused)).toBeUndefined();
  expect(WebAssembly.Module.customSections(reused, "name")).toEqual([]);
  expect(streaming).toHaveBeenCalledTimes(1);

  let fetches = 0;
  const sidecar = await encodeSidecar(source, 2, ["_start", "outer", "inner_trap"]);
  const fetcher = mockFetchOf(() => {
    fetches++;
    return new Response(sidecar.bytes);
  });
  expect(
    await loadSymbolTable(
      mod,
      { url: "https://example.test/s.json", sha256: sidecar.sha256 },
      {
        fetch: fetcher,
      },
    ),
  ).toBeUndefined();
  const trap = new WebAssembly.RuntimeError("unreachable");
  const annotated = await annotateError(
    trap,
    [{ module: mod, sidecar: { url: "https://example.test/s.json", sha256: sidecar.sha256 } }],
    { fetch: fetcher },
  );
  expect(fetches).toBe(0);
  expect(annotated.error).toBe(trap);
  expect(annotated.annotatedFrames).toBe(0);

  for (const entry of ["core/index.ts", "fs/index.ts", "proc/index.ts", "interrupt/loader.ts"]) {
    const built = await Bun.build({
      entrypoints: [resolve(packageRoot, entry)],
      target: "browser",
      format: "esm",
      metafile: true,
    });
    expect(built.success).toBe(true);
    const inputs = Object.keys(built.metafile!.inputs).map((file) =>
      relative(packageRoot, resolve(file)),
    );
    expect(inputs).not.toContain("interrupt/symbols.ts");
  }
});

test("Node imports of runtime and interrupt loader never eagerly load dist/interrupt/symbols.js", () => {
  const script = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({
      load(url, context, nextLoad) {
        loaded.push(url);
        return nextLoad(url, context);
      },
    });
    await import("@waffle-os/runtime");
    await import("@waffle-os/runtime/interrupt");
    await import("@waffle-os/runtime/interrupt/loader");
    assert.ok(!loaded.some((url) => url.endsWith("/dist/interrupt/symbols.js")), loaded.join("\\n"));
  `;
  expect(() =>
    execFileSync("node", ["--input-type=module", "--eval", script], {
      cwd: packageRoot,
      stdio: "pipe",
    }),
  ).not.toThrow();
});

test("opt-in diagnostics append a 36-byte CSPRNG nonce, record facts, and keep CacheStorage canonical", async () => {
  const store = new MemoryAdmittedStore();
  const source = ordinaryGuestFixture(7);
  const sourceSha = await sha256Hex(source);

  const compileSpy = spyOn(WebAssembly, "compile");
  spies.push(compileSpy);

  const diagCache = new InterruptModuleCache(16, store, {}, { symbolDiagnostics: true });
  const modMiss = await diagCache.compile(source);
  await store.stored;

  const factsMiss = admittedModuleDiagnostics(modMiss);
  expect(factsMiss).toBeDefined();
  expect(factsMiss!.sourceSha256).toBe(sourceSha);
  expect(factsMiss!.profile).toBe("ordinary");
  expect(factsMiss!.originalImports).toBe(2);
  expect(factsMiss!.originalDefinitions).toBe(3);
  expect(factsMiss!.addedImports).toBe(1);
  expect(factsMiss!.nonce).toMatch(/^w_[0-9a-f]{24}$/);
  expect(Object.isFrozen(factsMiss)).toBe(true);
  expect(readSubsection0ModuleName(modMiss)).toBe(factsMiss!.nonce);

  // Stored canonical bytes have NO name custom section and differ by exactly 36 bytes.
  const storedEntry = store.entries.get(sourceSha)!;
  expect(factsMiss!.admittedSha256).toBe(storedEntry.digest);
  const compiledInput = compileSpy.mock.calls[0]![0] as Uint8Array;
  expect(compiledInput.byteLength - storedEntry.bytes.byteLength).toBe(36);
  const rawStoredModule = await WebAssembly.compile(storedEntry.bytes);
  expect(WebAssembly.Module.customSections(rawStoredModule, "name")).toEqual([]);

  // A second diagnostic cache reuses CacheStorage without re-running WebAssembly.validate,
  // appends a fresh distinct nonce, and records matching admission facts.
  const validateSpy = spyOn(WebAssembly, "validate");
  spies.push(validateSpy);
  const modHit = await new InterruptModuleCache(16, store, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  expect(validateSpy).toHaveBeenCalledTimes(0);
  expect(store.puts).toBe(1);
  const factsHit = admittedModuleDiagnostics(modHit);
  expect(factsHit).toBeDefined();
  expect(factsHit!.sourceSha256).toBe(sourceSha);
  expect(factsHit!.admittedSha256).toBe(storedEntry.digest);
  expect(factsHit!.originalImports).toBe(2);
  expect(factsHit!.originalDefinitions).toBe(3);
  expect(factsHit!.addedImports).toBe(1);
  expect(factsHit!.nonce).toMatch(/^w_[0-9a-f]{24}$/);
  expect(factsHit!.nonce).not.toBe(factsMiss!.nonce);
  expect(readSubsection0ModuleName(modHit)).toBe(factsHit!.nonce);

  // A non-diagnostic cache still reuses the same canonical CacheStorage entry via compileStreaming.
  const streamingSpy = spyOn(WebAssembly, "compileStreaming");
  spies.push(streamingSpy);
  const modPlain = await new InterruptModuleCache(16, store).compile(source);
  expect(streamingSpy).toHaveBeenCalledTimes(1);
  expect(admittedModuleDiagnostics(modPlain)).toBeUndefined();
  expect(WebAssembly.Module.customSections(modPlain, "name")).toEqual([]);
});

test("in-memory cache separates diagnostic and non-diagnostic modules and handles supervised-thread +3 shift", async () => {
  const sharedCache = new InterruptModuleCache();
  const source = ordinaryGuestFixture(9);
  const plain = await sharedCache.compile(source);
  const diag = await sharedCache.compile(source, "ordinary", { symbolDiagnostics: true });
  expect(plain).not.toBe(diag);
  expect(admittedModuleDiagnostics(plain)).toBeUndefined();
  expect(admittedModuleDiagnostics(diag)).toBeDefined();
  expect(await sharedCache.compile(source, "ordinary", { symbolDiagnostics: true })).toBe(diag);

  // Supervised-thread (+3 import shift, 2 trailing wait wrappers excluded from originalDefinitions).
  const supSource = supervisedGuestFixture();
  const store = new MemoryAdmittedStore();
  const supMod = await new InterruptModuleCache(16, store, {}, { symbolDiagnostics: true }).compile(
    supSource,
    "supervised-thread",
  );
  await store.stored;
  const supFacts = admittedModuleDiagnostics(supMod)!;
  expect(supFacts.profile).toBe("supervised-thread");
  expect(supFacts.originalImports).toBe(1);
  expect(supFacts.originalDefinitions).toBe(2);
  expect(supFacts.addedImports).toBe(3);

  const supSidecar = await encodeSidecar(supSource, 1, ["_start", "inner_trap"]);
  const table = bindSymbolSidecar(supFacts, supSidecar.payload)!;
  expect(table).toBeDefined();
  expect(table.lookup(0)).toBeUndefined(); // original import
  expect(table.lookup(1)).toBeUndefined(); // __waffle_fatal
  expect(table.lookup(2)).toBeUndefined(); // __waffle_wait32
  expect(table.lookup(3)).toBeUndefined(); // __waffle_wait64
  expect(table.lookup(4)).toBe("_start");
  expect(table.lookup(5)).toBe("inner_trap");
  expect(table.lookup(6)).toBeUndefined(); // trailing wait32 wrapper
  expect(table.lookup(7)).toBeUndefined(); // trailing wait64 wrapper

  // Cache hit on supervised-thread also preserves exact layout.
  const supHit = await new InterruptModuleCache(16, store, {}, { symbolDiagnostics: true }).compile(
    supSource,
    "supervised-thread",
  );
  expect(admittedModuleDiagnostics(supHit)).toMatchObject({
    profile: "supervised-thread",
    originalImports: 1,
    originalDefinitions: 2,
    addedImports: 3,
  });
});

test("corrupted CacheStorage entry in diagnostic mode is evicted and re-admitted cleanly", async () => {
  const store = new MemoryAdmittedStore();
  const source = emptyWasm();
  const sourceSha = await sha256Hex(source);
  store.entries.set(sourceSha, { bytes: source, digest: "0".repeat(64) });
  const mod = await new InterruptModuleCache(16, store, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  await store.stored;
  expect(store.evictions).toBe(1);
  const facts = admittedModuleDiagnostics(mod)!;
  expect(facts.originalImports).toBe(0);
  expect(facts.originalDefinitions).toBe(0);
  expect(readSubsection0ModuleName(mod)).toBe(facts.nonce);
});

test("sidecar digest verification, schema validation, and binding reject every malformed/mismatched input", async () => {
  const source = ordinaryGuestFixture(3);
  const mod = await new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  const facts = admittedModuleDiagnostics(mod)!;
  const good = await encodeSidecar(source, 2, ["_start", null, "inner_trap"]);

  const parsed = await parseSymbolSidecar(good.bytes, good.sha256);
  expect(parsed).toBeDefined();
  const table = bindSymbolSidecar(facts, parsed!)!;
  expect(table.lookup(2)).toBeUndefined(); // __waffle_fatal
  expect(table.lookup(3)).toBe("_start");
  expect(table.lookup(4)).toBeUndefined(); // null entry stays raw
  expect(table.lookup(5)).toBe("inner_trap");
  expect(table.lookup(6)).toBeUndefined(); // past end
  expect(table.lookup(-1)).toBeUndefined();
  expect(table.lookup(3.5)).toBeUndefined();
  expect(table.lookup(Number.NaN)).toBeUndefined();

  // Wrong digest & invalid digest format
  expect(await parseSymbolSidecar(good.bytes, "0".repeat(64))).toBeUndefined();
  expect(await parseSymbolSidecar(good.bytes, "not-a-digest")).toBeUndefined();

  // Malformed JSON and invalid UTF-8
  for (const raw of [textEncoder.encode("{"), new Uint8Array([0xff, 0xfe])]) {
    const owned = new Uint8Array(raw);
    expect(await parseSymbolSidecar(owned, await sha256Hex(owned))).toBeUndefined();
  }

  // Schema rejections (even with matching SHA-256), including empty string names and non-canonical JSON
  for (const overrides of [
    { version: 2 },
    { source: { bytes: -1, sha256: facts.sourceSha256 } },
    { source: { bytes: 10, sha256: "short" } },
    { named: null },
    { importedFunctions: -1 },
    { names: [42] },
    { names: ["_start", "", "inner_trap"] },
    { extra: true },
  ]) {
    const bad = await encodeSidecar(source, 2, ["_start", "outer", "inner_trap"], overrides);
    expect(await parseSymbolSidecar(bad.bytes, bad.sha256)).toBeUndefined();
  }

  // Non-canonical JSON (pretty-printed or reordered keys) is rejected even with matching SHA-256
  for (const rawJson of [
    JSON.stringify(good.payload, null, 2),
    JSON.stringify({
      names: good.payload.names,
      importedFunctions: good.payload.importedFunctions,
      named: good.payload.named,
      source: good.payload.source,
      version: good.payload.version,
    }),
  ]) {
    const rawBytes = new Uint8Array(textEncoder.encode(rawJson));
    expect(await parseSymbolSidecar(rawBytes, await sha256Hex(rawBytes))).toBeUndefined();
  }

  // Exact byte-size check in parseSymbolSidecar
  expect(await parseSymbolSidecar(good.bytes, good.sha256, good.bytes.byteLength)).toEqual(
    good.payload,
  );
  expect(
    await parseSymbolSidecar(good.bytes, good.sha256, good.bytes.byteLength + 1),
  ).toBeUndefined();
  expect(await parseSymbolSidecar(good.bytes, good.sha256, -1)).toBeUndefined();

  // Binding mismatches (valid JSON + valid SHA-256, but wrong source hash / import count / def count)
  const wrongSource = await encodeSidecar(source, 2, ["_start", "outer", "inner_trap"], {
    source: { bytes: source.byteLength, sha256: "b".repeat(64) },
  });
  expect(
    bindSymbolSidecar(facts, (await parseSymbolSidecar(wrongSource.bytes, wrongSource.sha256))!),
  ).toBeUndefined();

  const wrongImports = await encodeSidecar(source, 3, ["_start", "outer", "inner_trap"]);
  expect(
    bindSymbolSidecar(facts, (await parseSymbolSidecar(wrongImports.bytes, wrongImports.sha256))!),
  ).toBeUndefined();

  const wrongDefs = await encodeSidecar(source, 2, ["_start", "outer"]);
  expect(
    bindSymbolSidecar(facts, (await parseSymbolSidecar(wrongDefs.bytes, wrongDefs.sha256))!),
  ).toBeUndefined();
});

test("bounded sidecar fetch rejects HTTP errors, network errors, timeouts, oversize Content-Length, oversize streams, and bad digests", async () => {
  const validSha = "c".repeat(64);

  // Invalid digest format fails before calling fetch
  let calls = 0;
  expect(
    await fetchSymbolSidecar(
      { url: "https://example.test/s.json", sha256: "bad" },
      {
        fetch: mockFetchOf(() => {
          calls++;
          return new Response("{}");
        }),
      },
    ),
  ).toBeUndefined();
  expect(calls).toBe(0);

  // HTTP 404
  expect(
    await fetchSymbolSidecar(
      { url: "https://example.test/missing.json", sha256: validSha },
      { fetch: mockFetchOf(() => new Response("not found", { status: 404 })) },
    ),
  ).toBeUndefined();

  // Network throw
  expect(
    await fetchSymbolSidecar(
      { url: "https://example.test/net.json", sha256: validSha },
      {
        fetch: mockFetchOf(() => {
          throw new TypeError("network down");
        }),
      },
    ),
  ).toBeUndefined();

  // Timeout abort
  expect(
    await fetchSymbolSidecar(
      { url: "https://example.test/slow.json", sha256: validSha },
      {
        timeoutMs: 20,
        fetch: mockFetchOf(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ),
      },
    ),
  ).toBeUndefined();

  // Streaming body exceeds maxBytes (cancels mid-stream before pulling remaining chunks)
  let streamCancelled = false;
  let chunkCount = 0;
  const streamedTooLarge = new Response(
    new ReadableStream(
      {
        pull(controller) {
          chunkCount++;
          controller.enqueue(new Uint8Array(20));
          if (chunkCount >= 10) controller.close();
        },
        cancel() {
          streamCancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  expect(
    await fetchSymbolSidecar(
      { url: "https://example.test/stream.json", sha256: validSha },
      { maxBytes: 32, fetch: mockFetchOf(() => streamedTooLarge) },
    ),
  ).toBeUndefined();
  expect(streamCancelled).toBe(true);
  expect(chunkCount).toBe(2);

  // Exact source.bytes check (matches @waffle-os/coreutils/symbols/* { url, bytes, sha256 } shape)
  const sampleBytes = new Uint8Array(textEncoder.encode('{"ok":1}'));
  const sampleSha = await sha256Hex(sampleBytes);
  expect(
    await fetchSymbolSidecar(
      { url: "https://example.test/exact.json", bytes: sampleBytes.byteLength, sha256: sampleSha },
      { fetch: mockFetchOf(() => new Response(sampleBytes)) },
    ),
  ).toEqual(sampleBytes);
  // Wrong exact bytes rejected on decoded streamed body (both shorter and longer)
  expect(
    await fetchSymbolSidecar(
      {
        url: "https://example.test/short.json",
        bytes: sampleBytes.byteLength + 1,
        sha256: sampleSha,
      },
      { fetch: mockFetchOf(() => new Response(sampleBytes)) },
    ),
  ).toBeUndefined();
  expect(
    await fetchSymbolSidecar(
      {
        url: "https://example.test/long.json",
        bytes: sampleBytes.byteLength - 1,
        sha256: sampleSha,
      },
      { fetch: mockFetchOf(() => new Response(sampleBytes)) },
    ),
  ).toBeUndefined();
  // source.bytes exceeding maxBytes or invalid fails closed before calling fetch
  let precheckFetches = 0;
  for (const badBytes of [64, -1, 1.5]) {
    expect(
      await fetchSymbolSidecar(
        { url: "https://example.test/bad-size.json", bytes: badBytes, sha256: sampleSha },
        {
          maxBytes: 32,
          fetch: mockFetchOf(() => {
            precheckFetches++;
            return new Response(sampleBytes);
          }),
        },
      ),
    ).toBeUndefined();
  }
  expect(precheckFetches).toBe(0);
});

test("engine-specific frame matching and annotation name only owned unnamed frames and preserve everything else", async () => {
  const sourceA = ordinaryGuestFixture(11);
  const sourceB = ordinaryGuestFixture(12);
  const cache = new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true });
  const modA = await cache.compile(sourceA);
  const modB = await cache.compile(sourceB);
  const factsA = admittedModuleDiagnostics(modA)!;
  const factsB = admittedModuleDiagnostics(modB)!;
  const sidecarA = await encodeSidecar(sourceA, 2, ["_start", "outer_a", "inner_trap_a"]);
  const sidecarB = await encodeSidecar(sourceB, 2, ["_start", "outer_b", "inner_trap_b"]);
  const tableA = bindSymbolSidecar(factsA, sidecarA.payload)!;
  const tableB = bindSymbolSidecar(factsB, sidecarB.payload)!;
  const tokA = factsA.nonce;
  const tokB = factsB.nonce;

  // Chromium V8 multi-module + already-named + streaming helper + truncated line
  const v8Stack = [
    "RuntimeError: unreachable",
    `    at ${tokA} (wasm://wasm/${tokA}-deadbeef:wasm-function[5]:0x128)`,
    `    at ${tokB} (wasm://wasm/${tokB}-01234567:wasm-function[4]:0x10b)`,
    `    at ${tokA}.already_named (wasm://wasm/${tokA}-deadbeef:wasm-function[4]:0x10b)`,
    `    at ${tokA} (http://127.0.0.1:8080/helper.wasm:wasm-function[5]:0x51)`,
    "    at wasm://wasm/1a8a0f42:wasm-function[5]:0x51",
    `    at ${tokA} (wasm://wasm/${tokA}-deadbeef:wasm-function[2]:0x40)`,
    `    at ${tokA} (wasm://wasm/${tokA}-deadbeef:wasm-function[5]:0x1... [truncated]`,
    "    at Wasi.launch (http://127.0.0.1:8080/worker.js:100:7)",
  ].join("\n");
  const v8Annotated = annotateStack(v8Stack, [tableA, tableB]);
  expect(v8Annotated.annotatedFrames).toBe(2);
  expect(v8Annotated.stack).toBe(
    [
      "RuntimeError: unreachable",
      `    at ${tokA}.inner_trap_a (wasm://wasm/${tokA}-deadbeef:wasm-function[5]:0x128)`,
      `    at ${tokB}.outer_b (wasm://wasm/${tokB}-01234567:wasm-function[4]:0x10b)`,
      `    at ${tokA}.already_named (wasm://wasm/${tokA}-deadbeef:wasm-function[4]:0x10b)`,
      `    at ${tokA} (http://127.0.0.1:8080/helper.wasm:wasm-function[5]:0x51)`,
      "    at wasm://wasm/1a8a0f42:wasm-function[5]:0x51",
      `    at ${tokA} (wasm://wasm/${tokA}-deadbeef:wasm-function[2]:0x40)`,
      `    at ${tokA} (wasm://wasm/${tokA}-deadbeef:wasm-function[5]:0x1... [truncated]`,
      "    at Wasi.launch (http://127.0.0.1:8080/worker.js:100:7)",
    ].join("\n"),
  );
  // Idempotent on second pass
  expect(annotateStack(v8Annotated.stack, [tableA, tableB])).toEqual({
    stack: v8Annotated.stack,
    annotatedFrames: 0,
  });

  // Firefox SpiderMonkey (cache miss URL + CacheStorage hit empty URL + already-named + other module)
  const ffStack = [
    `${tokA}.@http://127.0.0.1:8080/page.js line 42 > WebAssembly.compile:wasm-function[5]:0x128`,
    `${tokA}.@:wasm-function[3]:0xeb`,
    `${tokA}.already_named@:wasm-function[4]:0x10b`,
    "@:wasm-function[5]:0x128",
    "launch@http://127.0.0.1:8080/worker.js:100:7",
  ].join("\n");
  const ffAnnotated = annotateStack(ffStack, [tableA]);
  expect(ffAnnotated.annotatedFrames).toBe(2);
  expect(ffAnnotated.stack).toBe(
    [
      `${tokA}.inner_trap_a@http://127.0.0.1:8080/page.js line 42 > WebAssembly.compile:wasm-function[5]:0x128`,
      `${tokA}._start@:wasm-function[3]:0xeb`,
      `${tokA}.already_named@:wasm-function[4]:0x10b`,
      "@:wasm-function[5]:0x128",
      "launch@http://127.0.0.1:8080/worker.js:100:7",
    ].join("\n"),
  );
  expect(annotateStack(ffAnnotated.stack, [tableA]).annotatedFrames).toBe(0);

  // WebKit JSC
  const wkStack = [
    `@${tokA}:wasm-function[5]`,
    `already_named@${tokA}:wasm-function[4]`,
    "5@wasm-function[5]",
    `@${tokA}:wasm-function[3]`,
  ].join("\n");
  const wkAnnotated = annotateStack(wkStack, [tableA]);
  expect(wkAnnotated.annotatedFrames).toBe(2);
  expect(wkAnnotated.stack).toBe(
    [
      `inner_trap_a@${tokA}:wasm-function[5]`,
      `already_named@${tokA}:wasm-function[4]`,
      "5@wasm-function[5]",
      `_start@${tokA}:wasm-function[3]`,
    ].join("\n"),
  );
  expect(annotateStack(wkAnnotated.stack, [tableA]).annotatedFrames).toBe(0);

  // Nonce validation in matchOwnedWasmFrame rejects unsafe characters
  expect(matchOwnedWasmFrame(`@${tokA}:wasm-function[5]`, `${tokA}.bad`)).toBeNull();
});

test("annotateError preserves original error reference on success and failure and skips unreferenced modules", async () => {
  const sourceA = ordinaryGuestFixture(21);
  const sourceB = ordinaryGuestFixture(22);
  const cache = new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true });
  const modA = await cache.compile(sourceA);
  const modB = await cache.compile(sourceB);
  const factsA = admittedModuleDiagnostics(modA)!;
  const sidecarA = await encodeSidecar(sourceA, 2, ["_start", "outer_a", "inner_trap_a"]);
  const sidecarB = await encodeSidecar(sourceB, 2, ["_start", "outer_b", "inner_trap_b"]);

  const original = new WebAssembly.RuntimeError("unreachable");
  const rawStack = `RuntimeError: unreachable\n    at ${factsA.nonce} (wasm://wasm/${factsA.nonce}-12345678:wasm-function[5]:0x128)`;
  original.stack = rawStack;

  const fetchedUrls: string[] = [];
  const res = await annotateError(
    original,
    [
      {
        module: modA,
        sidecar: {
          url: "https://example.test/a.json",
          bytes: sidecarA.bytes.byteLength,
          sha256: sidecarA.sha256,
        },
      },
      {
        module: modB,
        sidecar: {
          url: "https://example.test/b.json",
          bytes: sidecarB.bytes.byteLength,
          sha256: sidecarB.sha256,
        },
      },
    ],
    {
      fetch: mockFetchOf((url) => {
        fetchedUrls.push(url);
        return new Response(sidecarA.bytes);
      }),
    },
  );
  expect(res.error).toBe(original);
  expect(original.stack).toBe(rawStack); // never mutated
  expect(fetchedUrls).toEqual(["https://example.test/a.json"]); // modB was not on stack
  expect(res.annotatedFrames).toBe(1);
  expect(res.stack).toContain(`${factsA.nonce}.inner_trap_a`);

  // Failed sidecar fetch preserves original error and raw stack
  const failed = await annotateError(
    original,
    [
      {
        module: modA,
        sidecar: { url: "https://example.test/missing.json", sha256: sidecarA.sha256 },
      },
    ],
    { fetch: mockFetchOf(() => new Response("nope", { status: 404 })) },
  );
  expect(failed.error).toBe(original);
  expect(failed.stack).toBe(rawStack);
  expect(failed.annotatedFrames).toBe(0);

  // Throwing stack getter never throws out of annotateError
  const broken = new Error("broken");
  Object.defineProperty(broken, "stack", {
    get() {
      throw new Error("getter threw");
    },
  });
  expect(await annotateError(broken, [])).toEqual({
    error: broken,
    stack: "",
    annotatedFrames: 0,
  });
});

test("describeWorkerError strips only the leading error header and preserves frames containing err.message", () => {
  const trap = new WebAssembly.RuntimeError("unreachable");
  trap.stack = [
    "RuntimeError: unreachable",
    "    at w_0123456789abcdef01234567.panic_unreachable (wasm://wasm/w_0123456789abcdef01234567-12345678:wasm-function[5]:0x128)",
    "    at w_0123456789abcdef01234567._start (wasm://wasm/w_0123456789abcdef01234567-12345678:wasm-function[3]:0xeb)",
  ].join("\n");
  expect(describeWorkerError(trap)).toBe(trap.stack);

  // Empty message must not drop all frames
  const emptyMessage = new Error("");
  emptyMessage.stack = "Error\n    at frameOne (file.js:1:1)\n    at frameTwo (file.js:2:2)";
  expect(describeWorkerError(emptyMessage)).toBe(
    "Error: \n    at frameOne (file.js:1:1)\n    at frameTwo (file.js:2:2)",
  );

  // Multiline error message strips header cleanly without dropping frames
  const multi = new Error("first line\nsecond line");
  multi.stack =
    "Error: first line\nsecond line\n    at keep_second_line_fn (file.js:3:1)\n    at caller (file.js:4:1)";
  expect(describeWorkerError(multi)).toBe(
    "Error: first line\nsecond line\n    at keep_second_line_fn (file.js:3:1)\n    at caller (file.js:4:1)",
  );

  // Firefox/WebKit stacks without leading header preserve every frame (up to 15)
  const firefoxTrap = new WebAssembly.RuntimeError("unreachable executed");
  firefoxTrap.stack = [
    "panic_unreachable_executed@http://127.0.0.1/worker.js:1:1",
    "w_0123456789abcdef01234567.@:wasm-function[3]:0xeb",
  ].join("\n");
  expect(describeWorkerError(firefoxTrap)).toBe(
    [
      "RuntimeError: unreachable executed",
      "    panic_unreachable_executed@http://127.0.0.1/worker.js:1:1",
      "    w_0123456789abcdef01234567.@:wasm-function[3]:0xeb",
    ].join("\n"),
  );
});

test("gzip-encoded HTTP response with compressed Content-Length succeeds and enforces decoded size bounds", async () => {
  const source = ordinaryGuestFixture(31);
  const mod = await new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  const sidecar = await encodeSidecar(source, 2, ["_start", "outer", "inner_trap"]);
  const gzipped = Bun.gzipSync(sidecar.bytes);
  expect(gzipped.byteLength).not.toBe(sidecar.bytes.byteLength);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/gzip.json") {
        return new Response(gzipped, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(gzipped.byteLength),
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/gzip.json`;
    const table = await loadSymbolTable(mod, {
      url,
      bytes: sidecar.bytes.byteLength,
      sha256: sidecar.sha256,
    });
    expect(table).toBeDefined();
    expect(table!.lookup(5)).toBe("inner_trap");

    // Decoded bytes exceeding maxBytes are rejected even when compressed Content-Length < maxBytes
    const tooSmallBudget = Math.min(gzipped.byteLength + 1, sidecar.bytes.byteLength - 1);
    expect(
      await fetchSymbolSidecar({ url, sha256: sidecar.sha256 }, { maxBytes: tooSmallBudget }),
    ).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("timeout and caller abort cover reading the whole body and reject late or stalled streams", async () => {
  const sampleBytes = new Uint8Array(textEncoder.encode('{"ok":1}'));
  const sampleSha = await sha256Hex(sampleBytes);

  // Late body delivered only when the timeout signal fires must be rejected
  const lateAfterTimeout = await fetchSymbolSidecar(
    { url: "https://example.test/late.json", bytes: sampleBytes.byteLength, sha256: sampleSha },
    {
      timeoutMs: 25,
      fetch: mockFetchOf((_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              try {
                controller.enqueue(sampleBytes);
                controller.close();
              } catch {}
            });
          },
        });
        return new Response(body);
      }),
    },
  );
  expect(lateAfterTimeout).toBeUndefined();

  // Stream that stalls forever must settle on timeout and cancel its reader
  let stalledCancelled = false;
  const stalledBody = await fetchSymbolSidecar(
    { url: "https://example.test/stalled.json", sha256: sampleSha },
    {
      timeoutMs: 25,
      fetch: mockFetchOf(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(sampleBytes.subarray(0, 2));
              },
              cancel() {
                stalledCancelled = true;
              },
            }),
          ),
      ),
    },
  );
  expect(stalledBody).toBeUndefined();
  expect(stalledCancelled).toBe(true);

  // Caller AbortSignal cancelling a stalled stream settles promptly and cancels reader
  let abortCancelled = false;
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 20);
  const callerAborted = await fetchSymbolSidecar(
    { url: "https://example.test/abort.json", sha256: sampleSha },
    {
      timeoutMs: 5_000,
      signal: caller.signal,
      fetch: mockFetchOf(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                abortCancelled = true;
              },
            }),
          ),
      ),
    },
  );
  expect(callerAborted).toBeUndefined();
  expect(abortCancelled).toBe(true);
});

test("sidecar names containing LF, CR, or NUL match PR 608 acceptance and render safely on one line", async () => {
  const source = ordinaryGuestFixture(32);
  const mod = await new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  const facts = admittedModuleDiagnostics(mod)!;
  const sidecar = await encodeSidecar(source, 2, ["_start", "weird\nline\r\0name", "inner_trap"]);
  const parsed = await parseSymbolSidecar(sidecar.bytes, sidecar.sha256, sidecar.bytes.byteLength);
  expect(parsed).toBeDefined();
  const table = bindSymbolSidecar(facts, parsed!)!;
  expect(table).toBeDefined();
  expect(table.lookup(3)).toBe("_start");
  expect(table.lookup(4)).toBe("weird\nline\r\0name");
  expect(table.lookup(5)).toBe("inner_trap");

  const tok = facts.nonce;
  const rawStack = [
    "RuntimeError: unreachable",
    `    at ${tok} (wasm://wasm/${tok}-deadbeef:wasm-function[5]:0x128)`,
    `    at ${tok} (wasm://wasm/${tok}-deadbeef:wasm-function[4]:0x10b)`,
    `    at ${tok} (wasm://wasm/${tok}-deadbeef:wasm-function[3]:0xeb)`,
  ].join("\n");
  const annotated = annotateStack(rawStack, [table]);
  expect(annotated.annotatedFrames).toBe(3);
  expect(annotated.stack.split("\n")).toHaveLength(4);
  expect(annotated.stack).toContain(`${tok}.inner_trap`);
  expect(annotated.stack).toContain(`${tok}.weird\\nline\\r\\0name`);
  expect(annotated.stack).toContain(`${tok}._start`);
  // Idempotent on second pass
  expect(annotateStack(annotated.stack, [table]).annotatedFrames).toBe(0);
});

test("Firefox owned-frame grammar accepts @ in compile-site URLs while rejecting already-named and truncated frames", async () => {
  const source = ordinaryGuestFixture(33);
  const mod = await new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  const facts = admittedModuleDiagnostics(mod)!;
  const sidecar = await encodeSidecar(source, 2, ["_start", "outer", "inner_trap"]);
  const table = bindSymbolSidecar(facts, sidecar.payload)!;
  const tok = facts.nonce;

  const ffAtStack = [
    `${tok}.@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x128`,
    `${tok}.@/@tests.js line 1904 > WebAssembly.compile:wasm-function[4]:0x10b`,
    `${tok}.@https://user@example.test/@scope/page.js line 12 > WebAssembly.compile:wasm-function[3]:0xeb`,
    `${tok}.already_named@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x128`,
    `${tok}.@spoof_fn@http://127.0.0.1:41234/page.js line 10 > WebAssembly.compile:wasm-function[5]:0x128`,
    `${tok}.@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x1... [truncated]`,
  ].join("\n");

  const annotated = annotateStack(ffAtStack, [table], { engine: "firefox" });
  expect(annotated.annotatedFrames).toBe(3);
  expect(annotated.stack).toBe(
    [
      `${tok}.inner_trap@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x128`,
      `${tok}.outer@/@tests.js line 1904 > WebAssembly.compile:wasm-function[4]:0x10b`,
      `${tok}._start@https://user@example.test/@scope/page.js line 12 > WebAssembly.compile:wasm-function[3]:0xeb`,
      `${tok}.already_named@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x128`,
      `${tok}.@spoof_fn@http://127.0.0.1:41234/page.js line 10 > WebAssembly.compile:wasm-function[5]:0x128`,
      `${tok}.@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x1... [truncated]`,
    ].join("\n"),
  );
  expect(annotateStack(annotated.stack, [table], { engine: "firefox" }).annotatedFrames).toBe(0);
});

test("parseSymbolSidecar snapshots caller-owned bytes before hashing so mid-verification mutation cannot spoof decoded names", async () => {
  const source = ordinaryGuestFixture(34);
  const sidecar = await encodeSidecar(source, 2, ["_start", "outer", "inner_trap"]);
  const mutable = new Uint8Array(sidecar.bytes);
  const target = textEncoder.encode("inner_trap");
  const spoof = textEncoder.encode("spoofed_fn");
  let pos = -1;
  for (let i = 0; i <= mutable.length - target.length; i++) {
    if (target.every((byte, idx) => mutable[i + idx] === byte)) {
      pos = i;
      break;
    }
  }
  expect(pos).toBeGreaterThan(-1);

  const pending = parseSymbolSidecar(mutable, sidecar.sha256, sidecar.bytes.byteLength);
  // Mutate the caller's buffer synchronously before crypto.subtle.digest resolves!
  mutable.set(spoof, pos);
  const parsed = await pending;
  expect(parsed).toBeDefined();
  expect(parsed!.names[2]).toBe("inner_trap");
});

test("Firefox rejects already-named @https:// frames and annotation is idempotent for delimiter-bearing names", async () => {
  const source = ordinaryGuestFixture(35);
  const mod = await new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true }).compile(
    source,
  );
  const facts = admittedModuleDiagnostics(mod)!;
  const sidecar = await encodeSidecar(source, 2, [
    "   ",
    "@https://name.example/symbol",
    "inner_trap",
  ]);
  const table = bindSymbolSidecar(facts, sidecar.payload)!;
  const tok = facts.nonce;

  // Natively named Firefox frames whose function name begins with `@https://` must stay raw.
  const nativeAtUrlStack = [
    `${tok}.@https://name.example/f@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x128`,
    `${tok}.@https://name.example/f@:wasm-function[5]:0x128`,
    `${tok}.@https://name.example/f@/@tests.js line 1904 > WebAssembly.compile:wasm-function[5]:0x128`,
  ].join("\n");
  const nativeRes = annotateStack(nativeAtUrlStack, [table], { engine: "firefox" });
  expect(nativeRes.annotatedFrames).toBe(0);
  expect(nativeRes.stack).toBe(nativeAtUrlStack);

  // Sidecar symbols starting with `@https://` or whitespace-only must be idempotent on pass 2 in all engines.
  for (const [engine, rawStack] of [
    [
      "chromium",
      [
        `    at ${tok} (wasm://wasm/${tok}-deadbeef:wasm-function[4]:0x10b)`,
        `    at ${tok} (wasm://wasm/${tok}-deadbeef:wasm-function[3]:0xeb)`,
      ].join("\n"),
    ],
    [
      "firefox",
      [
        `${tok}.@http://127.0.0.1:41234/@tests.js line 1904 > WebAssembly.compile:wasm-function[4]:0x10b`,
        `${tok}.@:wasm-function[3]:0xeb`,
      ].join("\n"),
    ],
    ["webkit", [`@${tok}:wasm-function[4]`, `@${tok}:wasm-function[3]`].join("\n")],
  ] as const) {
    const pass1 = annotateStack(rawStack, [table], { engine });
    expect(pass1.annotatedFrames).toBe(2);
    const pass2 = annotateStack(pass1.stack, [table], { engine });
    expect(pass2.annotatedFrames).toBe(0);
    expect(pass2.stack).toBe(pass1.stack);
  }
});

test("pending stream cancel() on oversized or non-OK response settles promptly and unlocks the reader", async () => {
  const validSha = "d".repeat(64);

  // Oversized response whose cancel() returns a never-settling promise
  let oversizedCancels = 0;
  const oversizedBody = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(24));
      },
      cancel() {
        oversizedCancels++;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const oversizedRes = await fetchSymbolSidecar(
    { url: "https://example.test/oversized-hang-cancel.json", sha256: validSha },
    {
      maxBytes: 16,
      timeoutMs: 100,
      fetch: mockFetchOf(() => new Response(oversizedBody)),
    },
  );
  expect(oversizedRes).toBeUndefined();
  expect(oversizedCancels).toBe(1);
  expect(oversizedBody.locked).toBe(false);

  // Non-OK response whose cancel() returns a never-settling promise
  let errorCancels = 0;
  const errorBody = new ReadableStream<Uint8Array>({
    cancel() {
      errorCancels++;
      return new Promise<void>(() => {});
    },
  });
  const errorRes = await fetchSymbolSidecar(
    { url: "https://example.test/error-hang-cancel.json", sha256: validSha },
    {
      timeoutMs: 100,
      fetch: mockFetchOf(() => new Response(errorBody, { status: 500 })),
    },
  );
  expect(errorRes).toBeUndefined();
  expect(errorCancels).toBe(1);
});

test("monotonic deadline stops consecutive ready reads even when the macrotask timer is starved", async () => {
  const payload = new Uint8Array(
    textEncoder.encode('{"version":1,"pad":"0123456789abcdefghijklmnopqrstuvwxyz"}'),
  );
  const sha = await sha256Hex(payload);
  let index = 0;
  let cancelled = false;
  const readyStream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index >= payload.length) {
          controller.close();
          return;
        }
        // Keep reads synchronous/ready so macrotask timers cannot fire between chunks,
        // while consuming >30 ms total across all 1-byte chunks.
        const until = performance.now() + 0.75;
        while (performance.now() < until) {
          // intentional synchronous spin
        }
        controller.enqueue(payload.subarray(index, index + 1));
        index++;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await fetchSymbolSidecar(
    { url: "https://example.test/starve.json", bytes: payload.byteLength, sha256: sha },
    {
      timeoutMs: 10,
      fetch: mockFetchOf(() => new Response(readyStream)),
    },
  );
  expect(result).toBeUndefined();
  expect(cancelled).toBe(true);
  expect(index).toBeLessThan(payload.length);
});
