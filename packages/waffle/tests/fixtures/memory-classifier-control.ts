export {};
// Capture the production intrinsics before the constructor observer is installed.
await import("../../memory/reservations.js");
let fixed = 0;
let memories = 0;
let successful = false;
const attempts: number[] = [];
const NativeBuffer = globalThis.SharedArrayBuffer;
const NativeMemory = WebAssembly.Memory;
class CapturedBuffer {
  readonly maxByteLength: number;
  readonly growable: boolean;
  constructor(length: number, options?: { maxByteLength: number }) {
    if (!options) fixed++;
    const maximum = options?.maxByteLength ?? length;
    attempts.push(maximum);
    if (maximum > 8 * 1024 ** 3 || successful) throw new RangeError("bounded classifier pool");
    successful = true;
    this.maxByteLength = maximum;
    this.growable = options !== undefined;
  }
}
globalThis.SharedArrayBuffer = CapturedBuffer as unknown as typeof SharedArrayBuffer;
WebAssembly.Memory = new Proxy(NativeMemory, {
  construct() {
    memories++;
    throw new RangeError("counted sub-probe");
  },
});
const post = self.postMessage.bind(self);
self.postMessage = (result: unknown) => post({ result, fixed, memories, attempts });
try {
  await import("../../memory/probe-worker.js");
  self.dispatchEvent(new MessageEvent("message", { data: {} }));
} finally {
  globalThis.SharedArrayBuffer = NativeBuffer;
  WebAssembly.Memory = NativeMemory;
}
