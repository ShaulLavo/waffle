import { readIdentityWords, writeIdentityWords } from "./file-identity.js";
import type { PublicationEffect } from "./publication.js";

export const WATCH_CAPACITY = 128;
const RECORD_WORDS = 288;
export const WATCH_BYTES = (4 + WATCH_CAPACITY * RECORD_WORDS) * 4;
const POINTER = 26;
const NAME_OFFSET = 20;
export const WATCH_NAME_BYTES = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
export type WatchRecord =
  | { kind: "overflow" }
  | { kind: "change"; file: bigint }
  | { kind: "metadata"; file: bigint; mode: number }
  | { kind: "inode"; file: bigint; mode: number; directory: boolean }
  | { kind: "entry"; parent: bigint; before: bigint; after: bigint; name: string };

export function validWatchName(name: string): boolean {
  let bytes = 0;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code < 0xd800 || code > 0xdfff) bytes += 3;
    else if (
      code <= 0xdbff &&
      name.charCodeAt(index + 1) >= 0xdc00 &&
      name.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else return false;
    if (bytes > WATCH_NAME_BYTES) return false;
  }
  return true;
}

export function wakeFilesystemWatch(buffer: SharedArrayBuffer): void {
  const offset = Atomics.load(new Int32Array(buffer, POINTER * 4, 1), 0);
  if (offset) Atomics.notify(new Int32Array(buffer, offset, 4), 3);
}

/** Appends and reads own the filesystem's global mutation lock. Waiting never does. */
export class WatchRing {
  readonly cells: Int32Array;
  private readonly records: Int32Array;
  constructor(buffer: SharedArrayBuffer, offset?: number) {
    const pointer = new Int32Array(buffer, POINTER * 4, 1);
    if (offset !== undefined) Atomics.store(pointer, 0, offset);
    const at = Atomics.load(pointer, 0);
    this.cells = new Int32Array(buffer, at, 4);
    this.records = new Int32Array(buffer, at + 16, WATCH_CAPACITY * RECORD_WORDS);
  }
  get active(): boolean {
    return Atomics.load(this.cells, 0) > 0;
  }
  get sequence(): number {
    return (this.cells[1]! >>> 0) + (this.cells[2]! >>> 0) * 0x100000000;
  }
  get wakeSequence(): number {
    return Atomics.load(this.cells, 3);
  }
  retain(): void {
    Atomics.add(this.cells, 0, 1);
  }
  release(): void {
    Atomics.sub(this.cells, 0, 1);
    this.wake();
  }
  wake(): void {
    Atomics.notify(this.cells, 3);
  }
  change(file: bigint, mode?: number): void {
    if (!this.active) return;
    const at = this.begin(mode === undefined ? 1 : 2);
    if (at === undefined) return;
    writeIdentityWords(this.records, at + 1, file);
    if (mode !== undefined) this.records[at + 5] = mode;
    this.commit();
  }
  effects(effects: readonly PublicationEffect[]): void {
    if (!this.active) return;
    for (const effect of effects) this.effect(effect);
  }
  private effect(effect: PublicationEffect): void {
    if (effect.kind === "bytes" || effect.kind === "resize") {
      this.change(effect.file.id);
      return;
    }
    const kind = effect.kind === "metadata" ? 2 : effect.kind === "inode" ? 3 : 4;
    const at = this.begin(kind);
    if (at === undefined) return;
    if (effect.kind === "entry") this.entry(at, effect);
    else {
      writeIdentityWords(this.records, at + 1, effect.file.id);
      this.records[at + 5] = effect.mode;
      this.records[at + 6] = effect.kind === "inode" && effect.nodeKind === "directory" ? 1 : 0;
    }
    this.commit();
  }
  private entry(at: number, effect: Extract<PublicationEffect, { kind: "entry" }>): void {
    writeIdentityWords(this.records, at + 1, effect.parent.id);
    writeIdentityWords(this.records, at + 5, effect.before?.id ?? 0n);
    writeIdentityWords(this.records, at + 9, effect.after?.id ?? 0n);
    if (!validWatchName(effect.name)) {
      this.records[at] = 0;
      return;
    }
    const destination = new Uint8Array(
      this.records.buffer,
      this.records.byteOffset + (at + NAME_OFFSET) * 4,
      WATCH_NAME_BYTES,
    );
    const encoded = encoder.encodeInto(effect.name, destination);
    this.records[at + 13] = encoded.written;
    if (encoded.read !== effect.name.length) this.records[at] = 0;
  }
  private begin(kind: number): number | undefined {
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      this.overflow();
      return;
    }
    const at = (this.sequence % WATCH_CAPACITY) * RECORD_WORDS;
    this.records[at] = kind;
    return at;
  }
  private commit(): void {
    const sequence = this.sequence + 1;
    this.cells[1] = sequence >>> 0;
    this.cells[2] = Math.floor(sequence / 0x100000000);
    Atomics.add(this.cells, 3, 1);
    this.wake();
  }
  private overflow(): void {
    this.cells[1] = -1;
    this.cells[2] = 0x1fffff;
    Atomics.add(this.cells, 3, 1);
    this.wake();
  }
  read(after: number): WatchRecord[] | undefined {
    const sequence = this.sequence;
    if (
      sequence === Number.MAX_SAFE_INTEGER ||
      after > sequence ||
      sequence - after > WATCH_CAPACITY
    )
      return;
    const records: WatchRecord[] = [];
    for (let cursor = after; cursor < sequence; cursor++)
      records.push(this.record((cursor % WATCH_CAPACITY) * RECORD_WORDS));
    return records;
  }
  private record(at: number): WatchRecord {
    const file = readIdentityWords(this.records, at + 1);
    switch (this.records[at]) {
      case 0:
        return { kind: "overflow" };
      case 1:
        return { kind: "change", file };
      case 2:
        return { kind: "metadata", file, mode: this.records[at + 5]! };
      case 3:
        return {
          kind: "inode",
          file,
          mode: this.records[at + 5]!,
          directory: this.records[at + 6] === 1,
        };
      default:
        return {
          kind: "entry",
          parent: file,
          before: readIdentityWords(this.records, at + 5),
          after: readIdentityWords(this.records, at + 9),
          name: decoder.decode(
            new Uint8Array(
              this.records.buffer,
              this.records.byteOffset + (at + NAME_OFFSET) * 4,
              this.records[at + 13]!,
            ),
          ),
        };
    }
  }
}
