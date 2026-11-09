import { FilesystemError } from "./protocol.js";
import { DATA_PAGE_BYTES } from "./storage-geometry.js";

export class ReaderPagePressure extends Error {}

/** Only the retained partial page needs replacement before a shrink. */
export function truncateBoundaryEnd(size: number, old: number): number {
  return size % DATA_PAGE_BYTES
    ? Math.min(old, Math.ceil(size / DATA_PAGE_BYTES) * DATA_PAGE_BYTES)
    : size;
}

/** Internal backing only. Public readers copy bytes and never receive these physical IDs. */
export class SharedPageVersion {
  private closed = false;
  constructor(
    readonly offset: number,
    readonly length: number,
    private readonly pages: Uint32Array,
    private readonly copyPage: (
      physical: number,
      target: Uint8Array,
      targetAt: number,
      start: number,
      count: number,
    ) => void,
    private readonly retire: () => void,
  ) {}
  read(offset: number, length: number): Uint8Array<ArrayBuffer> {
    if (this.closed) throw new FilesystemError(8);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < this.offset ||
      length < 0 ||
      offset > Number.MAX_SAFE_INTEGER - length ||
      offset + length > this.offset + this.length
    )
      throw new RangeError("range is outside retained pages");
    const out = new Uint8Array(length);
    let position = offset;
    while (position < offset + length) {
      const physical =
        this.pages[
          Math.floor(position / DATA_PAGE_BYTES) - Math.floor(this.offset / DATA_PAGE_BYTES)
        ]!;
      const start = position % DATA_PAGE_BYTES;
      const count = Math.min(DATA_PAGE_BYTES - start, offset + length - position);
      this.copyPage(physical, out, position - offset, start, count);
      position += count;
    }
    return out;
  }
  release(): void {
    if (this.closed) return;
    this.retire();
    this.closed = true;
  }
}
