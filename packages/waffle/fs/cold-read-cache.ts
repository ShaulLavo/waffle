import { PAGE } from "./shared-capacity.js";

/** Default private-memory bound. It holds a 12 MB toolchain binary read several times over. */
const COLD_READ_CACHE_BYTES = 32 * 1024 * 1024;

/** Verified bytes of cold payloads, kept by whole aligned page so a file read again while it
 * stays unmodified skips storage and its checksums. A payload key names one immutable stored
 * version: a write makes the file resident and its next checkpoint stores a new key. An entry
 * can therefore never go stale, only unused, and least recently used pages leave first. The
 * cache owns private copies, so a caller may transfer or modify what it receives. */
export class ColdReadCache {
  private readonly pages = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private readonly limit = COLD_READ_CACHE_BYTES) {}
  /** A copy of the range, or undefined unless every page it touches is cached. */
  read(key: string, offset: number, length: number): Uint8Array | undefined {
    const first = Math.floor(offset / PAGE);
    const last = Math.floor((offset + length - 1) / PAGE);
    for (let index = first; index <= last; index++) {
      const page = this.pages.get(pageKey(key, index));
      if (!page || index * PAGE + page.length < Math.min(offset + length, (index + 1) * PAGE))
        return;
    }
    const result = new Uint8Array(length);
    for (let index = first; index <= last; index++) {
      const name = pageKey(key, index);
      const page = this.pages.get(name)!;
      this.pages.delete(name);
      this.pages.set(name, page);
      const start = Math.max(offset, index * PAGE) - index * PAGE;
      const stop = Math.min(offset + length - index * PAGE, page.length);
      result.set(page.subarray(start, stop), index * PAGE + start - offset);
    }
    return result;
  }
  /** Keep the pages of a verified range that it covers completely. */
  store(key: string, offset: number, bytes: Uint8Array, size: number): void {
    const end = offset + bytes.length;
    for (let index = Math.ceil(offset / PAGE); index * PAGE < end; index++) {
      const start = index * PAGE;
      const length = Math.min(PAGE, size - start);
      if (start + length > end || length > this.limit) return;
      const name = pageKey(key, index);
      const previous = this.pages.get(name);
      if (previous) {
        this.bytes -= previous.length;
        this.pages.delete(name);
      }
      this.pages.set(name, bytes.slice(start - offset, start - offset + length));
      this.bytes += length;
    }
    this.evict();
  }
  clear(): void {
    this.pages.clear();
    this.bytes = 0;
  }
  private evict(): void {
    for (const [name, page] of this.pages) {
      if (this.bytes <= this.limit) return;
      this.pages.delete(name);
      this.bytes -= page.length;
    }
  }
}

function pageKey(key: string, index: number): string {
  return `${index}:${key}`;
}
