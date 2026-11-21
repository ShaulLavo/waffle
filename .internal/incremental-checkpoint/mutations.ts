import { CHUNK_SIZE } from "./indexeddb-chunks.js";

const WORDS = 8;
const RECORDS = 2048;
const HEADER = 2;
export const MUTATION_BYTES = (HEADER + RECORDS * WORDS) * 4;

export interface CaptureDelta {
  parent: string | undefined;
  size: number;
  inheritedEnd: number;
  chunks: ReadonlyMap<number, Uint8Array<ArrayBuffer>>;
  discoveryMs: number;
  copyMs: number;
}

export interface CheckpointCut {
  id: string;
  parent: string | undefined;
  deltas: ReadonlyMap<string, CaptureDelta>;
}

interface Effect {
  kind: "write" | "resize" | "stage";
  start: number;
  end: number;
}

/** Under the filesystem mutation lock, with the corresponding file lock held. */
export class MutationLog {
  private readonly cells: Int32Array;

  constructor(buffer: SharedArrayBuffer, offset: number) {
    this.cells = new Int32Array(buffer, offset, MUTATION_BYTES / 4);
  }

  assertLive(): void {
    if (Atomics.load(this.cells, 1)) throw new Error("Unresolved filesystem mutation");
  }

  reserve(owner: number, handle: number, effect: Effect): number {
    this.assertLive();
    const count = this.cells[0]!;
    if (count === RECORDS) throw new Error("Checkpoint experiment mutation log is full");
    const at = HEADER + count * WORDS;
    const kind = effect.kind === "resize" ? 2 : effect.kind === "stage" ? 3 : 1;
    this.cells.set([owner, handle, kind, effect.start, effect.end], at);
    Atomics.store(this.cells, 0, count + 1);
    return at;
  }

  settle(at: number, revision: number): void {
    this.cells[at + 5] = revision >>> 0;
    this.cells[at + 6] = Math.floor(revision / 0x100000000);
    Atomics.store(this.cells, at + 7, 1);
  }

  cancel(at: number): void {
    this.cells.fill(0, at, at + WORDS);
    Atomics.sub(this.cells, 0, 1);
  }

  settleStage(handle: number, revision: number): void {
    for (let at = HEADER; at < HEADER + this.cells[0]! * WORDS; at += WORDS) {
      if (this.cells[at + 1] === handle && this.cells[at + 2] === 3 && !this.cells[at + 7]) {
        this.settle(at, revision);
        return;
      }
    }
    throw new Error("Missing staged filesystem mutation");
  }

  beforeUnlock(owner: number, holdsFile: (handle: number) => boolean): void {
    for (let at = HEADER; at < HEADER + Atomics.load(this.cells, 0) * WORDS; at += WORDS) {
      if (this.cells[at] === owner && !Atomics.load(this.cells, at + 7) && holdsFile(this.cells[at + 1]!)) {
        Atomics.store(this.cells, 1, 1);
        return;
      }
    }
  }

  private revision(at: number): number {
    return (this.cells[at + 5]! >>> 0) + this.cells[at + 6]! * 0x100000000;
  }

  effects(handle: number, after: number, through: number): Effect[] {
    this.assertLive();
    const effects: Effect[] = [];
    for (let at = HEADER; at < HEADER + this.cells[0]! * WORDS; at += WORDS) {
      if (this.cells[at + 1] !== handle) continue;
      const state = this.cells[at + 7];
      if (state === 2) continue;
      if (state !== 1) throw new Error("Capture reached an unresolved filesystem mutation");
      const revision = this.revision(at);
      if (revision <= after || revision > through) continue;
      effects.push({
        kind: this.cells[at + 2] === 2 ? "resize" : "write",
        start: this.cells[at + 3]! >>> 0,
        end: this.cells[at + 4]! >>> 0,
      });
    }
    return effects;
  }

  confirm(confirmed: ReadonlyMap<number, number>): void {
    let next = HEADER;
    const end = HEADER + this.cells[0]! * WORDS;
    for (let at = HEADER; at < end; at += WORDS) {
      const state = this.cells[at + 7];
      if (state === 1 && this.revision(at) <= (confirmed.get(this.cells[at + 1]!) ?? -1))
        continue;
      this.cells.copyWithin(next, at, at + WORDS);
      next += WORDS;
    }
    this.cells.fill(0, next, end);
    Atomics.store(this.cells, 0, (next - HEADER) / WORDS);
  }
}

export function dirtyChunks(effects: readonly Effect[]): { dirty: Set<number>; inheritedEnd: number } {
  const dirty = new Set<number>();
  let inheritedEnd = Number.POSITIVE_INFINITY;
  for (const { kind, start, end } of effects) {
    if (kind !== "resize") {
      for (let index = Math.floor(start / CHUNK_SIZE); index < Math.ceil(end / CHUNK_SIZE); index++)
        dirty.add(index);
      continue;
    }
    if (end >= start) continue;
    inheritedEnd = Math.min(inheritedEnd, end);
    for (const index of dirty) if (index * CHUNK_SIZE >= end) dirty.delete(index);
    if (end % CHUNK_SIZE) dirty.add(Math.floor(end / CHUNK_SIZE));
  }
  return { dirty, inheritedEnd };
}
