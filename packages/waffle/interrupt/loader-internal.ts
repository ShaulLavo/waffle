import { declareModuleMemory } from "../memory/declarations.js";
import { ExecutableFormatError } from "../proc/start-failure.js";
import {
  admittedModuleDiagnostics,
  recordAdmittedModuleDiagnostics,
  type AdmittedModuleDiagnostics,
} from "./diagnostics.js";
import { type InterruptRewriteProfile, rewriteInterruptsOwned } from "./rewriter-internal.js";
import {
  cacheStorageAdmittedStore,
  ADMITTED_STORE_LIMITS,
  INTERRUPT_INTERVAL,
  INTERRUPT_POLICY,
  programStage,
  programTime,
  sha256Hex,
  storeError,
  type AdmittedEntry,
  type AdmittedModuleStore,
} from "./admitted-store.js";

export { admittedModuleDiagnostics, type AdmittedModuleDiagnostics };

export interface InterruptCompileOptions {
  /** Opt-in: append an ephemeral CSPRNG subsection-0 module name and record admission facts. */
  readonly symbolDiagnostics?: boolean;
}

export type InterruptModuleCacheOptions = InterruptCompileOptions;

// This module is intentionally omitted from package.json exports. Runtime code is the only
// caller of the owned entry point; public imports go through loader.ts and copy their input.
const compileOwned = Symbol("compile owned runtime source");
const nameEncoder = new TextEncoder();

interface CacheLimits {
  readonly maxRetainedBytes: number;
  readonly maxIdleMs: number;
  readonly maxActiveEntries: number;
  readonly maxActiveBytes: number;
}

const cacheLimits: CacheLimits = {
  maxRetainedBytes: ADMITTED_STORE_LIMITS.maxTotalBytes,
  maxIdleMs: 5 * 60 * 1000,
  maxActiveEntries: ADMITTED_STORE_LIMITS.maxEntries,
  maxActiveBytes: ADMITTED_STORE_LIMITS.maxTotalBytes,
};

interface RetainedModule {
  readonly module: WebAssembly.Module;
  readonly sourceBytes: number;
  lastUsed: number;
}

/** Process-independent producers and bounded completed retention.
 * Instances get fresh countdown globals and imports.
 * Registries retain resolved modules separately for their lifetime. Persistence holds bytes only.
 */
export class InterruptModuleCache {
  private readonly active = new Map<string, Promise<WebAssembly.Module>>();
  private readonly completed = new Map<string, RetainedModule>();
  private activeBytes = 0;
  private retainedBytes = 0;
  private readonly limits: CacheLimits;
  private readonly symbolDiagnostics: boolean;
  constructor(
    private readonly capacity = 16,
    private readonly store: AdmittedModuleStore | null = null,
    limits: Partial<CacheLimits> = {},
    options: InterruptModuleCacheOptions = {},
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("interrupt module cache capacity must be a positive integer");
    this.limits = { ...cacheLimits, ...limits };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("interrupt module cache limits must be positive integers");
    this.symbolDiagnostics = Boolean(options.symbolDiagnostics);
  }

  async compile(
    source: Uint8Array,
    profile: InterruptRewriteProfile = "ordinary",
    options?: InterruptCompileOptions,
  ): Promise<WebAssembly.Module> {
    // Hash and rewrite one owned snapshot, even if the caller mutates a borrowed view.
    this.checkSourceSize(source.byteLength);
    return this[compileOwned](new Uint8Array(source), profile, options);
  }

  async [compileOwned](
    bytes: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile,
    options?: InterruptCompileOptions,
  ): Promise<WebAssembly.Module> {
    // Hash and rewrite the fixed runtime-owned snapshot without another copy.
    this.checkSourceSize(bytes.byteLength);
    const diagnostics = options?.symbolDiagnostics ?? this.symbolDiagnostics;
    const start = programTime();
    const hash = await sha256Hex(bytes);
    programStage("digest", start, { bytes: bytes.length });
    const key = diagnostics ? `${profile}:diag:${hash}` : `${profile}:${hash}`;
    this.trim(programTime());
    const pending = this.active.get(key);
    if (pending) {
      this.observe("join", start);
      return pending;
    }
    const completed = this.completed.get(key);
    if (completed) {
      completed.lastUsed = programTime() ?? completed.lastUsed;
      this.completed.delete(key);
      this.completed.set(key, completed);
      this.observe("hit", start);
      return completed.module;
    }
    if (
      this.active.size >= this.limits.maxActiveEntries ||
      bytes.byteLength > this.limits.maxActiveBytes - this.activeBytes
    ) {
      this.observe("refused", start);
      throw new RangeError(
        "interrupt module cache active load budget exceeded; retry after settlement",
      );
    }
    // Publish before admission so aliases and concurrent loads share all expensive work.
    const producer = Promise.resolve().then(() =>
      this.produce(key, hash, bytes, profile, diagnostics),
    );
    this.active.set(key, producer);
    this.activeBytes += bytes.byteLength;
    this.observe("producer", start);
    return producer;
  }

  private checkSourceSize(bytes: number): void {
    if (bytes > this.limits.maxActiveBytes)
      throw new RangeError("interrupt module source exceeds the active byte budget");
  }

  private async produce(
    key: string,
    hash: string,
    bytes: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile,
    diagnostics: boolean,
  ): Promise<WebAssembly.Module> {
    try {
      const module = await this.load(hash, bytes, profile, diagnostics);
      this.retain(key, module, bytes.byteLength);
      return module;
    } finally {
      // Only this producer owns settlement. Joined callers never clean up a later retry.
      this.active.delete(key);
      this.activeBytes -= bytes.byteLength;
      this.observe("settled", programTime());
    }
  }

  private retain(key: string, module: WebAssembly.Module, sourceBytes: number): void {
    const now = programTime();
    this.trim(now);
    if (now === undefined || sourceBytes > this.limits.maxRetainedBytes) return;
    this.completed.set(key, { module, sourceBytes, lastUsed: now });
    this.retainedBytes += sourceBytes;
    this.trim(now);
  }

  private trim(now: number | undefined): void {
    for (const [key, entry] of this.completed) {
      if (
        now !== undefined &&
        now - entry.lastUsed < this.limits.maxIdleMs &&
        this.completed.size <= this.capacity &&
        this.retainedBytes <= this.limits.maxRetainedBytes
      )
        break;
      this.completed.delete(key);
      this.retainedBytes -= entry.sourceBytes;
    }
  }

  private observe(result: string, start: number | undefined): void {
    programStage("cache", start, {
      result,
      activeEntries: this.active.size,
      activeSourceBytes: this.activeBytes,
      retainedEntries: this.completed.size,
      retainedSourceBytes: this.retainedBytes,
    });
  }

  private async load(
    hash: string,
    bytes: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile,
    diagnostics: boolean,
  ): Promise<WebAssembly.Module> {
    const reused = await this.reuse(hash, profile, diagnostics);
    if (reused) return reused;
    try {
      const admitStart = programTime();
      const admitted = rewriteInterruptsOwned(bytes, {
        profile,
        interval: INTERRUPT_INTERVAL,
        policy: INTERRUPT_POLICY,
      });
      programStage("admit", admitStart, { bytes: bytes.length });
      const nonce = diagnostics ? randomModuleNonce() : undefined;
      const compileInput = nonce ? appendModuleNameSection(admitted, nonce) : admitted;
      const compileStart = programTime();
      const module = await WebAssembly.compile(compileInput);
      declareModuleMemory(module, admitted);
      programStage("compile", compileStart, { bytes: compileInput.length });
      if (nonce) {
        const admittedSha256 = await sha256Hex(admitted);
        recordDiagnostics(module, hash, admittedSha256, admitted, profile, nonce);
      }
      void this.persist(hash, admitted, profile);
      return module;
    } catch (error) {
      if (error instanceof WebAssembly.CompileError)
        throw new ExecutableFormatError(error.message, { cause: error });
      throw error;
    }
  }

  private async evict(hash: string, profile: InterruptRewriteProfile): Promise<void> {
    const start = programTime();
    try {
      await this.store?.evict(hash, profile);
    } catch (error) {
      storeError("evict", start, error);
    }
  }

  private async persist(
    hash: string,
    admitted: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile,
  ): Promise<void> {
    if (!this.store) return;
    const start = programTime();
    try {
      await this.store.put(hash, admitted, profile);
    } catch (error) {
      storeError("put", start, error, admitted.length);
    }
  }

  private async reuse(
    hash: string,
    profile: InterruptRewriteProfile,
    diagnostics: boolean,
  ): Promise<WebAssembly.Module | undefined> {
    if (!this.store) return undefined;
    const start = programTime();
    try {
      const entry = await this.store.open(hash, profile);
      programStage("store-open", start, { bytes: 0, result: entry ? "hit" : "miss" });
      if (!entry) return undefined;
      const module = await reuseEntry(entry, hash, profile, diagnostics);
      if (!module) void this.evict(hash, profile);
      return module;
    } catch (error) {
      storeError("reuse", start, error);
      return undefined;
    }
  }
}

function encodeU32(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}

function randomModuleNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `w_${hex}`;
}

function appendModuleNameSection(wasm: Uint8Array, moduleName: string): Uint8Array<ArrayBuffer> {
  const encoded = nameEncoder.encode(moduleName);
  const sub0Payload = encodeU32(encoded.length).concat(Array.from(encoded));
  const sub0 = [0].concat(encodeU32(sub0Payload.length), sub0Payload);
  const customPayload = [4, 0x6e, 0x61, 0x6d, 0x65].concat(sub0);
  const customSection = [0].concat(encodeU32(customPayload.length), customPayload);
  const output = new Uint8Array(wasm.byteLength + customSection.length);
  output.set(wasm, 0);
  output.set(customSection, wasm.byteLength);
  return output;
}

function readU32At(wasm: Uint8Array, start: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = wasm[start + i];
    if (byte === undefined || (i === 4 && byte > 15)) return undefined;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: start + i + 1 };
    shift += 7;
  }
  return undefined;
}

function readDefinedFunctionCount(wasm: Uint8Array): number {
  let pos = 8;
  while (pos < wasm.length) {
    const id = wasm[pos++];
    const size = readU32At(wasm, pos);
    if (id === undefined || !size || size.next + size.value > wasm.length) return -1;
    if (id === 3) {
      const count = readU32At(wasm, size.next);
      return count ? count.value : -1;
    }
    pos = size.next + size.value;
  }
  return 0;
}

function hasRequiredImports(module: WebAssembly.Module, profile: InterruptRewriteProfile): boolean {
  const imports = WebAssembly.Module.imports(module);
  const has = (importName: string) =>
    imports.some(
      (entry) =>
        entry.module === "runtime_proc" && entry.name === importName && entry.kind === "function",
    );
  if (!has("__waffle_fatal")) return false;
  const wait32 = has("__waffle_wait32");
  const wait64 = has("__waffle_wait64");
  return profile === "supervised-thread" ? wait32 && wait64 : !wait32 && !wait64;
}

function recordDiagnostics(
  module: WebAssembly.Module,
  sourceSha256: string,
  admittedSha256: string,
  admitted: Uint8Array,
  profile: InterruptRewriteProfile,
  nonce: string,
): boolean {
  const addedImports = profile === "supervised-thread" ? 3 : 1;
  const trailingWrappers = profile === "supervised-thread" ? 2 : 0;
  const importedFunctions = WebAssembly.Module.imports(module).filter(
    (entry) => entry.kind === "function",
  ).length;
  const originalImports = importedFunctions - addedImports;
  const admittedDefinitions = readDefinedFunctionCount(admitted);
  const originalDefinitions = admittedDefinitions - trailingWrappers;
  if (originalImports < 0 || admittedDefinitions < 0 || originalDefinitions < 0) return false;
  recordAdmittedModuleDiagnostics(module, {
    sourceSha256,
    admittedSha256,
    profile,
    originalImports,
    originalDefinitions,
    addedImports,
    nonce,
  });
  return true;
}

async function reuseEntry(
  entry: AdmittedEntry,
  sourceSha256: string,
  profile: InterruptRewriteProfile,
  diagnostics: boolean,
): Promise<WebAssembly.Module | undefined> {
  const start = programTime();
  try {
    if (diagnostics) return await compileDiagnosticEntry(entry, sourceSha256, start, profile);
    return await compileEntry(entry, start, profile);
  } catch (error) {
    storeError("verify", start, error);
    programStage("store-verify", start, { bytes: 0, result: "rejected" });
    return undefined;
  }
}

async function compileDiagnosticEntry(
  entry: AdmittedEntry,
  sourceSha256: string,
  start: number | undefined,
  profile: InterruptRewriteProfile,
): Promise<WebAssembly.Module | undefined> {
  const bytes = new Uint8Array(await entry.response.arrayBuffer());
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== entry.admittedSha256) {
    programStage("store-verify", start, { bytes: bytes.byteLength, result: "rejected" });
    return undefined;
  }
  const nonce = randomModuleNonce();
  const named = appendModuleNameSection(bytes, nonce);
  const compileStart = programTime();
  const module = await WebAssembly.compile(named);
  programStage("compile", compileStart, { bytes: named.byteLength, source: "store" });
  const ok =
    hasRequiredImports(module, profile) &&
    recordDiagnostics(module, sourceSha256, actualDigest, bytes, profile, nonce);
  if (ok) declareModuleMemory(module, bytes);
  programStage("store-verify", start, {
    bytes: bytes.byteLength,
    result: ok ? "hit" : "rejected",
  });
  return ok ? module : undefined;
}

async function compileStored(response: Response): Promise<WebAssembly.Module> {
  const start = programTime();
  try {
    return await WebAssembly.compileStreaming(response);
  } finally {
    programStage("compile", start, {
      bytes: Number(response.headers.get("content-length")),
      source: "store",
    });
  }
}

async function compileEntry(
  entry: AdmittedEntry,
  start: number | undefined,
  profile: InterruptRewriteProfile,
): Promise<WebAssembly.Module | undefined> {
  const copy = entry.response.clone();
  const results = await Promise.allSettled([
    compileStored(entry.response),
    copy.arrayBuffer().then(async (body) => {
      const bytes = new Uint8Array(body);
      return { bytes, digest: await sha256Hex(bytes) };
    }),
  ]);
  const compiled = results[0],
    digest = results[1];
  if (compiled.status === "rejected") storeError("compile-stored", start, compiled.reason);
  if (digest.status === "rejected") storeError("verify", start, digest.reason);
  const module = verified(compiled, digest, entry.admittedSha256, profile);
  if (module && digest.status === "fulfilled") declareModuleMemory(module, digest.value.bytes);
  programStage("store-verify", start, {
    bytes: Number(copy.headers.get("content-length")),
    result: module ? "hit" : "rejected",
  });
  return module;
}

function verified(
  compiled: PromiseSettledResult<WebAssembly.Module>,
  digest: PromiseSettledResult<{ bytes: Uint8Array; digest: string }>,
  expected: string,
  profile: InterruptRewriteProfile,
): WebAssembly.Module | undefined {
  if (compiled.status !== "fulfilled" || digest.status !== "fulfilled") return undefined;
  if (digest.value.digest !== expected) return undefined;
  if (!hasRequiredImports(compiled.value, profile)) return undefined;
  return compiled.value;
}

let modules: InterruptModuleCache | undefined;
/** Called through the existing lazy loader import, not on the synchronous spawn path. */
export function compileInterruptible(
  bytes: Uint8Array,
  profile: InterruptRewriteProfile = "ordinary",
  options?: InterruptCompileOptions,
): Promise<WebAssembly.Module> {
  modules ??= new InterruptModuleCache(16, cacheStorageAdmittedStore());
  return modules.compile(bytes, profile, options);
}

/** Internal runtime path for a fixed, unshared source snapshot. */
export function compileInterruptibleOwned(
  bytes: Uint8Array<ArrayBuffer>,
  profile: InterruptRewriteProfile = "ordinary",
  options?: InterruptCompileOptions,
): Promise<WebAssembly.Module> {
  modules ??= new InterruptModuleCache(16, cacheStorageAdmittedStore());
  return modules[compileOwned](bytes, profile, options);
}

export { programStage } from "./admitted-store.js";
