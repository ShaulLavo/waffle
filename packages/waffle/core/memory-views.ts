export interface MemoryViews {
  bytes(): Uint8Array;
  view(): DataView;
  range(ptr: number, length: number): Uint8Array;
}

type ResizableMemory = WebAssembly.Memory & {
  toResizableBuffer?(): ArrayBuffer | SharedArrayBuffer;
};

const hosts = new WeakMap<WebAssembly.Memory, MemoryViews>();
const fixedHosts = new WeakMap<WebAssembly.Memory, MemoryViews>();

export function memoryViews(
  memory: ResizableMemory,
  conversion: "allowed" | "forbidden" = "allowed",
): MemoryViews {
  const cache = conversion === "forbidden" ? fixedHosts : hosts;
  const existing = cache.get(memory);
  if (existing) return existing;
  let views: MemoryViews | undefined;
  if (conversion === "allowed" && typeof memory.toResizableBuffer === "function") {
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
  cache.set(memory, views);
  return views;
}
