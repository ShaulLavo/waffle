import { declareModuleMemory } from "../memory/declarations.js";
import { ExecutableFormatError } from "../proc/start-failure.js";
import { rewriteInterruptsOwned } from "./rewriter-internal.js";
import {
  cacheStorageAdmittedStore,
  INTERRUPT_INTERVAL,
  INTERRUPT_POLICY,
  programStage,
  programTime,
  sha256Hex,
  storeError,
  type AdmittedEntry,
  type AdmittedModuleStore,
} from "./admitted-store.js";

/** Process-independent module promises. Instances get fresh countdown globals and imports.
 * Registries retain resolved modules separately for their lifetime. Persistence holds bytes only.
 */
export class InterruptModuleCache {
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();
  constructor(
    private readonly capacity = 16,
    private readonly store: AdmittedModuleStore | null = null,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("interrupt module cache capacity must be a positive integer");
  }

  async compile(source: Uint8Array): Promise<WebAssembly.Module> {
    // Hash and rewrite one owned snapshot, even if the caller mutates a borrowed view.
    const bytes = new Uint8Array(source);
    const start = programTime();
    const hash = await sha256Hex(bytes);
    programStage("digest", start, { bytes: bytes.length });
    let pending = this.modules.get(hash);
    if (pending) {
      this.modules.delete(hash);
      this.modules.set(hash, pending);
      return pending;
    }
    // Publish before admission so aliases and concurrent loads share all expensive work.
    pending = Promise.resolve().then(() => this.load(hash, bytes));
    this.modules.set(hash, pending);
    if (this.modules.size > this.capacity) this.modules.delete(this.modules.keys().next().value!);
    try {
      return await pending;
    } catch (error) {
      if (this.modules.get(hash) === pending) this.modules.delete(hash);
      throw error;
    }
  }

  private async load(hash: string, bytes: Uint8Array<ArrayBuffer>): Promise<WebAssembly.Module> {
    const reused = await this.reuse(hash);
    if (reused) return reused;
    try {
      const admitStart = programTime();
      const admitted = rewriteInterruptsOwned(bytes, {
        interval: INTERRUPT_INTERVAL,
        policy: INTERRUPT_POLICY,
      });
      programStage("admit", admitStart, { bytes: bytes.length });
      const compileStart = programTime();
      const module = await WebAssembly.compile(admitted);
      declareModuleMemory(module, admitted);
      programStage("compile", compileStart, { bytes: admitted.length });
      void this.persist(hash, admitted);
      return module;
    } catch (error) {
      if (error instanceof WebAssembly.CompileError)
        throw new ExecutableFormatError(error.message, { cause: error });
      throw error;
    }
  }

  private async evict(hash: string): Promise<void> {
    const start = programTime();
    try {
      await this.store?.evict(hash);
    } catch (error) {
      storeError("evict", start, error);
    }
  }

  private async persist(hash: string, admitted: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.store) return;
    const start = programTime();
    try {
      await this.store.put(hash, admitted);
    } catch (error) {
      storeError("put", start, error, admitted.length);
    }
  }

  private async reuse(hash: string): Promise<WebAssembly.Module | undefined> {
    if (!this.store) return undefined;
    const start = programTime();
    try {
      const entry = await this.store.open(hash);
      programStage("store-open", start, { bytes: 0, result: entry ? "hit" : "miss" });
      if (!entry) return undefined;
      const module = await reuseEntry(entry);
      if (!module) void this.evict(hash);
      return module;
    } catch (error) {
      storeError("reuse", start, error);
      return undefined;
    }
  }
}

async function reuseEntry(entry: AdmittedEntry): Promise<WebAssembly.Module | undefined> {
  const start = programTime();
  try {
    return await compileEntry(entry, start);
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
  const module = verified(compiled, digest, entry.admittedSha256);
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
): WebAssembly.Module | undefined {
  if (compiled.status !== "fulfilled" || digest.status !== "fulfilled") return undefined;
  if (digest.value.digest !== expected) return undefined;
  const fatal = WebAssembly.Module.imports(compiled.value).some(
    (entry) =>
      entry.module === "runtime_proc" &&
      entry.name === "__waffle_fatal" &&
      entry.kind === "function",
  );
  return fatal ? compiled.value : undefined;
}

let modules: InterruptModuleCache | undefined;
/** Called through the existing lazy loader import, not on the synchronous spawn path. */
export function compileInterruptible(bytes: Uint8Array): Promise<WebAssembly.Module> {
  modules ??= new InterruptModuleCache(16, cacheStorageAdmittedStore());
  return modules.compile(bytes);
}

export { programStage } from "./admitted-store.js";
