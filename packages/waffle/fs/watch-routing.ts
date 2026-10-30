import { FilesystemError } from "../core/filesystem.js";
import { RootWatchAccount } from "./watch-account.js";
import { WatchArena } from "./watch-arena.js";
import { watchId, setWatchId } from "./watch-id-index.js";
import { WatchNames, type WatchNameReservation } from "./watch-names.js";

/** Packed pending routes; the control lease covers bounded decoded paths, not measured heap bytes. */
export class WatchRouting {
  private readonly frames: WatchArena;
  private readonly names: WatchNames;
  private readonly control: { release(): void };
  private count = 0;
  constructor(account: RootWatchAccount) {
    this.frames = new WatchArena(account, "scratch");
    this.names = new WatchNames(account, 12288, "scratch");
    this.control = account.reserveControl(16384);
  }
  push(id: bigint, path: string): void {
    if (path.length > 4096) throw new FilesystemError(6, "watch path bound exceeded");
    const growth = this.frames.stage((this.count + 1) * 24);
    let name: WatchNameReservation | undefined;
    try {
      if (path) name = this.names.stage(path);
      growth.commit();
      const offset = name?.commit() ?? 0;
      const at = this.count++ * 24;
      setWatchId(this.frames.view, at, id);
      this.frames.view.setUint32(at + 16, offset, true);
      this.frames.view.setUint32(at + 20, name?.length ?? 0, true);
    } catch (error) {
      growth.cancel();
      name?.cancel();
      throw error;
    }
  }
  pop(): { id: bigint; path: string } | undefined {
    if (!this.count) return;
    const at = --this.count * 24;
    const offset = this.frames.view.getUint32(at + 16, true);
    const length = this.frames.view.getUint32(at + 20, true);
    const path = length ? this.names.read(offset, length) : "";
    if (length) this.names.release(offset, length);
    return { id: watchId(this.frames.view, at), path };
  }
  close(): void {
    this.frames.close();
    this.names.close();
    this.control.release();
    this.count = 0;
  }
}
