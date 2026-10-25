import type { SharedFilesystemState } from "../../fs/shared";
import { PAGE } from "../../fs/protocol";

export function measureTruncatePages(shared: SharedFilesystemState) {
  const counts = { reserved: 0, copied: 0 };
  const reserve = Reflect.get(shared, "reserveVersionPage");
  if (typeof reserve !== "function") throw new Error("version page reservation missing");
  const set = Uint8Array.prototype.set;
  Reflect.set(shared, "reserveVersionPage", function (this: SharedFilesystemState, slot: number) {
    const physical = Reflect.apply(reserve, this, [slot]);
    counts.reserved++;
    return physical;
  });
  Uint8Array.prototype.set = function (source, offset) {
    if (
      this.byteLength === PAGE &&
      this.buffer instanceof SharedArrayBuffer &&
      source instanceof Uint8Array &&
      source.byteLength === PAGE &&
      source.buffer instanceof SharedArrayBuffer
    )
      counts.copied++;
    return set.call(this, source, offset);
  };
  return {
    counts,
    restore() {
      Reflect.set(shared, "reserveVersionPage", reserve);
      Uint8Array.prototype.set = set;
    },
  };
}
