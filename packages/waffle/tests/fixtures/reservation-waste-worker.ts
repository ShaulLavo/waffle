const allocations: number[] = [];
const NativeSharedBuffer = SharedArrayBuffer;
globalThis.SharedArrayBuffer = new Proxy(NativeSharedBuffer, {
  construct(target, args) {
    const buffer: unknown = Reflect.construct(target, args);
    if (!(buffer instanceof NativeSharedBuffer)) throw new Error("expected shared backing");
    allocations.push(buffer.byteLength);
    return buffer;
  },
});
const postMessage = self.postMessage.bind(self);
self.postMessage = (message: unknown) => postMessage({ message, allocations: allocations.slice() });
await import("../../browser/fs-worker.js");
postMessage({ loaded: true });

export {};
