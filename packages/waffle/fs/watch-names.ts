import { FilesystemError } from "../core/filesystem.js";
import { utf8ByteLength } from "./utf8-size.js";
import { validWatchName } from "./watch-ring.js";
import { RootWatchAccount, type WatchAllocationKind } from "./watch-account.js";
import { WatchArena } from "./watch-arena.js";

const NONE = 0xffffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
export interface WatchNameReservation {
  commit(): number;
  cancel(): void;
  readonly length: number;
}

export class WatchNames {
  private readonly arena: WatchArena;
  private pending = false;
  private free = NONE;
  private tail = 0;
  private live = 0;
  private payload = 0;
  constructor(
    account: RootWatchAccount,
    private readonly maximum = 1024,
    kind: WatchAllocationKind = "metadata",
  ) {
    this.arena = new WatchArena(account, kind);
  }
  resources() {
    return {
      nameBytes: this.payload,
      nameBlockBytes: this.live,
      nameCapacity: this.arena.capacity,
    };
  }
  stage(name: string): WatchNameReservation {
    if (this.pending) throw new Error("watch name allocation is already staged");
    if (!name || !validWatchName(name, this.maximum))
      throw new FilesystemError(6, "watch name bound exceeded");
    const length = utf8ByteLength(name);
    const size = Math.ceil((length + 8) / 4) * 4;
    const found = this.find(size);
    const at = found.at === NONE ? this.tail : found.at;
    const growth = this.arena.stage(at + size);
    let pending = true;
    this.pending = true;
    return {
      length,
      commit: () => {
        if (!pending) throw new Error("watch name reservation already settled");
        pending = false;
        this.pending = false;
        growth.commit();
        this.claim(at, size, found.previous);
        const encoded = encoder.encodeInto(
          name,
          this.arena.bytes.subarray(at + 8, at + 8 + length),
        );
        if (encoded.read !== name.length || encoded.written !== length)
          throw new Error("watch name encoding mismatch");
        this.payload += length;
        return at + 8;
      },
      cancel: () => {
        if (pending) {
          pending = false;
          this.pending = false;
          growth.cancel();
        }
      },
    };
  }
  private find(size: number): { at: number; previous: number } {
    let previous = NONE;
    for (let at = this.free; at !== NONE; at = this.arena.view.getUint32(at + 4, true)) {
      if (this.arena.view.getUint32(at, true) >= size) return { at, previous };
      previous = at;
    }
    return { at: NONE, previous };
  }
  private claim(at: number, requested: number, previous: number): void {
    const view = this.arena.view;
    let size = requested;
    if (at === this.tail) this.tail += size;
    else size = this.takeFree(at, requested, previous);
    view.setUint32(at, size, true);
    view.setUint32(at + 4, NONE, true);
    this.live += size;
  }
  private takeFree(at: number, requested: number, previous: number): number {
    const view = this.arena.view;
    const size = view.getUint32(at, true);
    let next = view.getUint32(at + 4, true);
    if (size - requested >= 12) {
      const remainder = at + requested;
      view.setUint32(remainder, size - requested, true);
      view.setUint32(remainder + 4, next, true);
      next = remainder;
    }
    if (previous === NONE) this.free = next;
    else view.setUint32(previous + 4, next, true);
    return size - requested >= 12 ? requested : size;
  }
  read(offset: number, length: number): string {
    return decoder.decode(this.arena.bytes.subarray(offset, offset + length));
  }
  release(offset: number, length: number): void {
    const at = offset - 8;
    const view = this.arena.view;
    const size = view.getUint32(at, true);
    let previous = NONE;
    let next = this.free;
    while (next !== NONE && next < at) {
      previous = next;
      next = view.getUint32(next + 4, true);
    }
    view.setUint32(at + 4, next, true);
    if (previous === NONE) this.free = at;
    else view.setUint32(previous + 4, at, true);
    this.join(at, next);
    if (previous !== NONE) this.join(previous, at);
    this.live -= size;
    this.payload -= length;
  }
  private join(at: number, next: number): void {
    if (next === NONE) return;
    const view = this.arena.view;
    const size = view.getUint32(at, true);
    if (at + size !== next) return;
    view.setUint32(at, size + view.getUint32(next, true), true);
    view.setUint32(at + 4, view.getUint32(next + 4, true), true);
  }
  close(): void {
    this.arena.close();
    this.free = NONE;
    this.tail = this.live = this.payload = 0;
  }
}
