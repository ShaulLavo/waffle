import { type InterruptRewriteProfile, INTERRUPT_REWRITER_REVISION } from "./rewriter-internal.js";

export const INTERRUPT_INTERVAL = 4096;
export const INTERRUPT_POLICY = "countdown";
export const ADMITTED_CACHE_PREFIX = "waffle-admitted:";
export const ADMITTED_DIGEST_HEADER = "x-waffle-admitted-sha256";
export const ADMITTED_STORE_LIMITS = Object.freeze({
  maxEntries: 32,
  maxEntryBytes: 48 * 1024 * 1024,
  maxTotalBytes: 192 * 1024 * 1024,
});
type StoreLimits = { readonly [Key in keyof typeof ADMITTED_STORE_LIMITS]: number };

export function interruptTransformId(
  limits: StoreLimits = ADMITTED_STORE_LIMITS,
  profile: InterruptRewriteProfile = "ordinary",
): string {
  return `interrupt-r${INTERRUPT_REWRITER_REVISION}-${INTERRUPT_POLICY}-${INTERRUPT_INTERVAL}-${profile}-e${limits.maxEntries}-b${limits.maxEntryBytes}-t${limits.maxTotalBytes}`;
}

export interface AdmittedEntry {
  readonly response: Response;
  readonly admittedSha256: string;
}

/** Trusted app cache only. Body hashes detect corruption, not a same-origin forger who can
 * replace both bytes and metadata. The fatal import rejects accidentally stored raw source;
 * it does not prove instrumentation or the source-to-output mapping. Both trust the app writer.
 * No guest or process authority belongs in this store.
 */
export interface AdmittedModuleStore {
  open(sourceSha256: string, profile?: InterruptRewriteProfile): Promise<AdmittedEntry | undefined>;
  put(
    sourceSha256: string,
    admitted: Uint8Array<ArrayBuffer>,
    profile?: InterruptRewriteProfile,
  ): Promise<void>;
  evict(sourceSha256: string, profile?: InterruptRewriteProfile): Promise<void>;
}

export function programTime(): number | undefined {
  try {
    return performance.now();
  } catch {
    return undefined;
  }
}

export function programStage(
  stage: string,
  start: number | undefined,
  detail: object,
  end?: number,
): void {
  if (start === undefined) return;
  try {
    const finished = end ?? programTime();
    if (finished === undefined) return;
    performance.measure(`waffle:program:${stage}`, { start, end: finished, detail });
  } catch {
    // Diagnostics must never replace a loader result or failure.
  }
}

export function storeError(
  operation: string,
  start: number | undefined,
  error: unknown,
  bytes = 0,
): void {
  programStage("store-error", start, { bytes, operation, error: typeof error });
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function admittedKey(
  origin: string,
  sourceSha256: string,
  limits: StoreLimits = ADMITTED_STORE_LIMITS,
  profile: InterruptRewriteProfile = "ordinary",
): string {
  return `${origin}/__waffle/admitted/${interruptTransformId(limits, profile)}/${sourceSha256}.wasm`;
}

function entrySize(response: Response, limits: StoreLimits): number | undefined {
  const text = response.headers.get("content-length");
  if (!text || !/^[1-9][0-9]*$/.test(text)) return undefined;
  const size = Number(text);
  return Number.isSafeInteger(size) && size <= limits.maxEntryBytes ? size : undefined;
}

function admittedEntry(response: Response, limits: StoreLimits): AdmittedEntry | undefined {
  const digest = response.headers.get(ADMITTED_DIGEST_HEADER);
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
  if (entrySize(response, limits) === undefined) return undefined;
  if (response.headers.get("content-type") !== "application/wasm") return undefined;
  if (response.headers.has("content-encoding")) return undefined;
  return { response, admittedSha256: digest };
}

/** Serializes this realm's mutations, not loads or cross-tab writes. Other tabs can trim
 * concurrently; a missing entry is always a normal admission miss.
 */
export class CacheStorageAdmittedStore implements AdmittedModuleStore {
  private maintenance: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | undefined;
  private name(profile: InterruptRewriteProfile): string {
    return ADMITTED_CACHE_PREFIX + interruptTransformId(this.limits, profile);
  }

  constructor(
    private readonly storage: CacheStorage,
    private readonly origin: string,
    private readonly limits: StoreLimits = ADMITTED_STORE_LIMITS,
  ) {}

  private initialize(): Promise<void> {
    return (this.initialized ??= this.removeObsolete());
  }

  private async removeObsolete(): Promise<void> {
    const names = await this.storage.keys();
    for (const name of names) {
      if (
        name.startsWith(ADMITTED_CACHE_PREFIX) &&
        name !== this.name("ordinary") &&
        name !== this.name("supervised-thread")
      )
        await this.storage.delete(name);
    }
  }

  async open(
    hash: string,
    profile: InterruptRewriteProfile = "ordinary",
  ): Promise<AdmittedEntry | undefined> {
    const start = programTime();
    try {
      await this.initialize();
      const cache = await this.storage.open(this.name(profile));
      const response = await cache.match(admittedKey(this.origin, hash, this.limits, profile));
      if (!response) return undefined;
      const entry = admittedEntry(response, this.limits);
      if (!entry) await this.evict(hash, profile);
      return entry;
    } catch (error) {
      this.initialized = undefined;
      storeError("open", start, error);
      return undefined;
    }
  }

  put(
    hash: string,
    admitted: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile = "ordinary",
  ): Promise<void> {
    if (admitted.byteLength > this.limits.maxEntryBytes) return Promise.resolve();
    const pending = this.maintenance.then(() => this.write(hash, admitted, profile));
    this.maintenance = pending;
    return pending;
  }

  private async write(
    hash: string,
    admitted: Uint8Array<ArrayBuffer>,
    profile: InterruptRewriteProfile,
  ): Promise<void> {
    const start = programTime();
    try {
      await this.initialize();
      const digest = await sha256Hex(admitted);
      const cache = await this.storage.open(this.name(profile));
      const key = admittedKey(this.origin, hash, this.limits, profile);
      await cache.put(
        key,
        new Response(admitted, {
          headers: {
            "content-type": "application/wasm",
            "content-length": String(admitted.byteLength),
            [ADMITTED_DIGEST_HEADER]: digest,
          },
        }),
      );
      await this.trim(cache);
      programStage("store-put", start, { bytes: admitted.byteLength });
    } catch (error) {
      this.initialized = undefined;
      storeError("put", start, error, admitted.byteLength);
    }
  }

  private async trim(cache: Cache): Promise<void> {
    const entries: { key: Request; size: number }[] = [];
    let total = 0;
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      const size = response && entrySize(response, this.limits);
      if (size === undefined) {
        await cache.delete(key);
        continue;
      }
      entries.push({ key, size });
      total += size;
    }
    let remaining = entries.length;
    for (const entry of entries) {
      if (remaining <= this.limits.maxEntries && total <= this.limits.maxTotalBytes) break;
      await cache.delete(entry.key);
      total -= entry.size;
      remaining--;
    }
  }

  evict(hash: string, profile: InterruptRewriteProfile = "ordinary"): Promise<void> {
    const pending = this.maintenance.then(() => this.remove(hash, profile));
    this.maintenance = pending;
    return pending;
  }

  private async remove(hash: string, profile: InterruptRewriteProfile): Promise<void> {
    const start = programTime();
    try {
      const cache = await this.storage.open(this.name(profile));
      await cache.delete(admittedKey(this.origin, hash, this.limits, profile));
    } catch (error) {
      storeError("evict", start, error);
    }
  }
}

export function cacheStorageAdmittedStore(): AdmittedModuleStore | null {
  const start = programTime();
  try {
    if (!globalThis.caches || typeof WebAssembly.compileStreaming !== "function") return null;
    if (typeof location === "undefined" || !/^https?:\/\//.test(location.origin)) return null;
    return new CacheStorageAdmittedStore(globalThis.caches, location.origin);
  } catch (error) {
    storeError("capability", start, error);
    return null;
  }
}
