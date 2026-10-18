// @ts-check
/** @typedef {{ bytes(): Uint8Array, view(): DataView, range(ptr: number, length: number): Uint8Array }} Views */
/** @type {WeakMap<WebAssembly.Memory, Views>} */
const hosts = new WeakMap();

/** @param {WebAssembly.Memory & { toResizableBuffer?(): ArrayBuffer | SharedArrayBuffer }} memory
 * @returns {Views}
 */
export function memoryViews(memory) {
  const existing = hosts.get(memory);
  if (existing) return existing;
  /** @type {Views | undefined} */
  let views;
  if (typeof memory.toResizableBuffer === "function") {
    try {
      // This also returns a growable SharedArrayBuffer for shared wasm memories.
      const buffer = memory.toResizableBuffer();
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      views = {
        bytes: () => bytes,
        view: () => view,
        range: (ptr, length) => new Uint8Array(memory.buffer, ptr, length),
      };
    } catch {
      // Some hosts expose the conversion but reject it for this memory.
    }
  }
  if (!views) {
    let buffer = memory.buffer;
    let bytes = new Uint8Array(buffer);
    let view = new DataView(buffer);
    const refresh = () => {
      const current = memory.buffer;
      // Compare identity, not length: grow(0) can detach an unshared fixed buffer.
      if (current === buffer) return;
      buffer = current;
      bytes = new Uint8Array(buffer);
      view = new DataView(buffer);
    };
    views = {
      bytes: () => {
        refresh();
        return bytes;
      },
      view: () => {
        refresh();
        return view;
      },
      range: (ptr, length) => new Uint8Array(memory.buffer, ptr, length),
    };
  }
  // Bounded views still need their own range and must reject invalid guest pointers.
  hosts.set(memory, views);
  return views;
}
