import { PAGE } from "./shared-capacity.js";

/** Default private-memory bound. It holds a 12 MB toolchain binary read several times over. */
const COLD_READ_CACHE_BYTES = 32 * 1024 * 1024;
/** Charged per page on top of its bytes: an estimate of its map entry, key string and typed
 * array and buffer headers. It keeps many tiny files from exceeding the bound in real heap. */
export const COLD_PAGE_OVERHEAD = 256;
/** Pages one storage read fetches for a sequential cold scan: 1 MiB, so a 13 MB binary costs
 * 14 storage reads instead of 210, while its transport still moves one page per request. */
const READAHEAD_PAGES = 16;
export const READAHEAD_BYTES = READAHEAD_PAGES * PAGE;
/** Payloads whose last read end is remembered for sequential detection. */
const STREAMS = 64;

/** Verified bytes of cold payloads, kept by whole aligned page so a file read again while it
 * stays unmodified skips storage and its checksums. A payload key names one immutable stored
 * version: a write makes the file resident and its next checkpoint stores a new key. An entry
 * can therefore never go stale, only unused, and least recently used pages leave first. The
 * cache owns private copies, so a caller may transfer or modify what it receives. */
export class ColdReadCache {
  private readonly pages = new Map<string, Uint8Array>();
  /** Where the last read of each recent payload ended. */
  private readonly ends = new Map<string, number>();
  private bytes = 0;
  constructor(private readonly limit = COLD_READ_CACHE_BYTES) {}
  /** Aligned storage range for a miss at `[offset, offset + count)`. A read that starts exactly
   * where the previous read of this payload ended is a sequential scan, so it fetches a
   * page-aligned readahead window (as Linux page-cache readahead does) up to `READAHEAD_BYTES`
   * and half the cache budget; any other read fetches only what it needs. Aligning the start to a
   * page boundary lets small sequential reads populate their current page too instead of
   * repeatedly missing and refetching the window. */
  readWindow(
    key: string,
    offset: number,
    count: number,
    size: number,
  ): { offset: number; length: number } {
    if (this.ends.get(key) !== offset) return { offset, length: count };
    const windowPages = Math.min(
      READAHEAD_PAGES,
      Math.floor(this.limit / 2 / (PAGE + COLD_PAGE_OVERHEAD)),
    );
    if (windowPages < 1) return { offset, length: count };
    const start = Math.floor(offset / PAGE) * PAGE;
    const end = Math.min(size, start + windowPages * PAGE);
    if (end < offset + count) return { offset, length: count };
    return { offset: start, length: end - start };
  }
  /** Record where a read of this payload ended, hit or miss. */
  noteRead(key: string, end: number): void {
    this.ends.delete(key);
    if (this.ends.size >= STREAMS) this.ends.delete(this.ends.keys().next().value!);
    this.ends.set(key, end);
  }
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
  /** Keep the pages of a verified range that it covers completely. Each page makes room before
   * its copy is made, so the bound holds at every step, not only once the range is done. */
  store(key: string, offset: number, bytes: Uint8Array, size: number): void {
    const end = offset + bytes.length;
    for (let index = Math.ceil(offset / PAGE); index * PAGE < end; index++) {
      const start = index * PAGE;
      const length = Math.min(PAGE, size - start);
      const cost = length + COLD_PAGE_OVERHEAD;
      if (start + length > end || cost > this.limit) return;
      const name = pageKey(key, index);
      this.remove(name);
      this.makeRoom(cost);
      this.pages.set(name, bytes.slice(start - offset, start - offset + length));
      this.bytes += cost;
    }
  }
  clear(): void {
    this.pages.clear();
    this.ends.clear();
    this.bytes = 0;
  }
  private remove(name: string): void {
    const page = this.pages.get(name);
    if (!page) return;
    this.pages.delete(name);
    this.bytes -= page.length + COLD_PAGE_OVERHEAD;
  }
  private makeRoom(cost: number): void {
    for (const [name, page] of this.pages) {
      if (this.bytes + cost <= this.limit) return;
      this.pages.delete(name);
      this.bytes -= page.length + COLD_PAGE_OVERHEAD;
    }
  }
}

function pageKey(key: string, index: number): string {
  return `${index}:${key}`;
}
