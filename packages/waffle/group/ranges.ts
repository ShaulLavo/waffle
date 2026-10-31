/** First-fit free list over integer units, coalescing on release. */
export class RangeAllocator {
  private readonly free: { start: number; size: number }[] = [];

  /** Units currently free. */
  get available(): number {
    let total = 0;
    for (const range of this.free) total += range.size;
    return total;
  }

  /** Lowest aligned start that fits, or undefined. */
  take(size: number, alignment = 1): number | undefined {
    for (let index = 0; index < this.free.length; index++) {
      const range = this.free[index]!;
      const start = Math.ceil(range.start / alignment) * alignment;
      const end = range.start + range.size;
      if (start + size > end) continue;
      this.free.splice(index, 1);
      if (end > start + size)
        this.free.splice(index, 0, { start: start + size, size: end - start - size });
      if (start > range.start)
        this.free.splice(index, 0, { start: range.start, size: start - range.start });
      return start;
    }
    return undefined;
  }

  give(start: number, size: number): void {
    let index = 0;
    while (index < this.free.length && this.free[index]!.start < start) index++;
    const previous = this.free[index - 1];
    const next = this.free[index];
    if (previous && previous.start + previous.size > start) throw new Error("range released twice");
    if (next && start + size > next.start) throw new Error("range released twice");
    if (previous && previous.start + previous.size === start) {
      previous.size += size;
      if (next && previous.start + previous.size === next.start) {
        previous.size += next.size;
        this.free.splice(index, 1);
      }
      return;
    }
    if (next && start + size === next.start) {
      next.start = start;
      next.size += size;
      return;
    }
    this.free.splice(index, 0, { start, size });
  }
}
