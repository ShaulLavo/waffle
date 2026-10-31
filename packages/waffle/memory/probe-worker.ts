import { PAGE_BYTES, PROBE_CEILING_BYTES, type ProbeResult } from "./reservations.js";
function growable(maxByteLength: number): SharedArrayBuffer {
  const value: unknown = Reflect.construct(SharedArrayBuffer, [0, { maxByteLength }]);
  if (!(value instanceof SharedArrayBuffer)) throw new TypeError("invalid probe buffer");
  return value;
}
function counted(create: () => object, retained: object[]): boolean {
  try {
    retained.push(create());
    return false;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return true;
  }
}
const retained: object[] = [];
function probe(): ProbeResult {
  let growableBytes = 0;
  let step = 256 * 1024 ** 2;
  while (growableBytes < PROBE_CEILING_BYTES) {
    try {
      retained.push(growable(step));
      growableBytes += step;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (step === 16 * 1024 ** 2) break;
      step = 16 * 1024 ** 2;
    }
  }
  if (growableBytes === 0) throw new RangeError("No growable shared memory available");
  const ceilingReached = growableBytes >= PROBE_CEILING_BYTES;
  const test = 64 * 1024 ** 2;
  const counts = ceilingReached
    ? { "fixed-buffer": true, "shared-memory": true, "private-memory": true }
    : {
        "fixed-buffer": counted(() => new SharedArrayBuffer(test), retained),
        "shared-memory": counted(
          () => new WebAssembly.Memory({ initial: 1, maximum: test / PAGE_BYTES, shared: true }),
          retained,
        ),
        "private-memory": counted(
          () => new WebAssembly.Memory({ initial: 1, maximum: test / PAGE_BYTES }),
          retained,
        ),
      };
  // Keep all successful reservations reachable until the owning worker is terminated.
  self.postMessage({ growableBytes, ceilingReached, counts });
  void retained.length;
  return { growableBytes, ceilingReached, counts };
}
self.onmessage = () => {
  try {
    probe();
  } catch (error) {
    setTimeout(() => {
      throw error;
    });
  }
};
