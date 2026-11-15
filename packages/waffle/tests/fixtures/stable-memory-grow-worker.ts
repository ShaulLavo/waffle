export {};

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ memory: WebAssembly.Memory; pages: number }>) => {
  const { memory, pages } = event.data;
  const previous = memory.grow(pages);
  new Uint8Array(memory.buffer)[previous * 65536] = 42;
  self.postMessage(previous);
};
