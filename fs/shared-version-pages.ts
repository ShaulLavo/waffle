import { FilesystemError, PAGE } from "./protocol.js";

export interface RetainedSharedPage {
  readonly physical: number;
  readonly bytes: Uint8Array;
}

/** Internal backing only. Public readers copy bytes and never receive these descriptors. */
export class SharedPageVersion {
  private closed = false;
  constructor(
    readonly offset: number,
    readonly length: number,
    private readonly pages: readonly RetainedSharedPage[],
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
      const page = this.pages[Math.floor(position / PAGE) - Math.floor(this.offset / PAGE)]!;
      const start = position % PAGE;
      const count = Math.min(PAGE - start, offset + length - position);
      out.set(page.bytes.subarray(start, start + count), position - offset);
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
