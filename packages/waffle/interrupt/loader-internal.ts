import { declareModuleMemory } from "../memory/declarations.js";
import { ExecutableFormatError } from "../proc/start-failure.js";
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

// This module is intentionally omitted from package.json exports. Runtime code is the only
// caller of the owned entry point; public imports go through loader.ts and copy their input.
const compileOwned = Symbol("compile owned runtime source");

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
  constructor(
    private readonly capacity = 16,
    private readonly store: AdmittedModuleStore | null = null,
    limits: Partial<CacheLimits> = {},
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("interrupt module cache capacity must be a positive integer");
    this.limits = { ...cacheLimits, ...limits };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("interrupt module cache limits must be positive integers");
  }

  async compile(
    source: Uint8Array,
    profile: InterruptRewriteProfile = "ordinary",
  ): Promise<WebAssembly.Module> {
    // Hash and rewrite one owned snapshot, even if the caller mutates a borrowed view.
    this.checkSourceSize(source.byteLength);
    return this[compileOwned](new Uint8Array(source), profile);
  }

  async [compileOwned](
    bytes: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile,
  ): Promise<WebAssembly.Module> {
    // Hash and rewrite the fixed runtime-owned snapshot without another copy.
    this.checkSourceSize(bytes.byteLength);
    const start = programTime();
    const hash = await sha256Hex(bytes);
    programStage("digest", start, { bytes: bytes.length });
    const key = `${profile}:${hash}`;
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
    const producer = Promise.resolve().then(() => this.produce(key, hash, bytes, profile));
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
  ): Promise<WebAssembly.Module> {
    try {
      const module = await this.load(hash, bytes, profile);
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
  ): Promise<WebAssembly.Module> {
    const reused = await this.reuse(hash, profile);
    if (reused) return reused;
    try {
      const admitStart = programTime();
      const admitted = rewriteInterruptsOwned(bytes, {
        profile,
        interval: INTERRUPT_INTERVAL,
        policy: INTERRUPT_POLICY,
      });
      programStage("admit", admitStart, { bytes: bytes.length });
      const compileStart = programTime();
      const module = await WebAssembly.compile(admitted);
      declareModuleMemory(module, admitted);
      programStage("compile", compileStart, { bytes: admitted.length });
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
  ): Promise<WebAssembly.Module | undefined> {
    if (!this.store) return undefined;
    const start = programTime();
    try {
      const entry = await this.store.open(hash, profile);
      programStage("store-open", start, { bytes: 0, result: entry ? "hit" : "miss" });
      if (!entry) return undefined;
      const module = await reuseEntry(entry, profile);
      if (!module) void this.evict(hash, profile);
      return module;
    } catch (error) {
      storeError("reuse", start, error);
      return undefined;
    }
  }
}

async function reuseEntry(
  entry: AdmittedEntry,
  profile: InterruptRewriteProfile,
): Promise<WebAssembly.Module | undefined> {
  const start = programTime();
  try {
    return await compileEntry(entry, start, profile);
  } catch (error) {
    storeError("verify", start, error);
    programStage("store-verify", start, { bytes: 0, result: "rejected" });
    return undefined;
  }
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
  const imports = WebAssembly.Module.imports(compiled.value);
  const has = (name: string) =>
    imports.some(
      (entry) =>
        entry.module === "runtime_proc" && entry.name === name && entry.kind === "function",
    );
  if (!has("__waffle_fatal")) return undefined;
  const wait32 = has("__waffle_wait32"),
    wait64 = has("__waffle_wait64");
  if (profile === "supervised-thread" ? !wait32 || !wait64 : wait32 || wait64) return undefined;
  return compiled.value;
}

let modules: InterruptModuleCache | undefined;
/** Called through the existing lazy loader import, not on the synchronous spawn path. */
export function compileInterruptible(
  bytes: Uint8Array,
  profile: InterruptRewriteProfile = "ordinary",
): Promise<WebAssembly.Module> {
  modules ??= new InterruptModuleCache(16, cacheStorageAdmittedStore());
  return modules.compile(bytes, profile);
}

/** Internal runtime path for a fixed, unshared source snapshot. */
export function compileInterruptibleOwned(
  bytes: Uint8Array<ArrayBuffer>,
  profile: InterruptRewriteProfile = "ordinary",
): Promise<WebAssembly.Module> {
  modules ??= new InterruptModuleCache(16, cacheStorageAdmittedStore());
  return modules[compileOwned](bytes, profile);
}

export { programStage } from "./admitted-store.js";
