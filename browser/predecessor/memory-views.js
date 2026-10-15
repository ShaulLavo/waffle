const hosts = new WeakMap();

export function memoryViews(memory) {
  const existing = hosts.get(memory);
  if (existing) return existing;
  let views;
  if (typeof memory.toResizableBuffer === "function") {
    // This also returns a growable SharedArrayBuffer for shared wasm memories.
    const buffer = memory.toResizableBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    views = { bytes: () => bytes, view: () => view };
  } else {
    views = { bytes: () => new Uint8Array(memory.buffer), view: () => new DataView(memory.buffer) };
  }
  // Bounded views still need their own range and must reject invalid guest pointers.
  views.range = (ptr, length) => new Uint8Array(memory.buffer, ptr, length);
  hosts.set(memory, views);
  return views;
}
