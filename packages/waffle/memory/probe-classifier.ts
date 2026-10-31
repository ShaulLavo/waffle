import { PROBE_CEILING_BYTES, type ProbeResult } from "./reservations.js";

function reserve(
  allocate: (maxByteLength: number) => object,
  retained: object[],
  chunk: number,
): boolean {
  try {
    retained.push(allocate(chunk));
    return true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}
/** Stops at the first refusal after success. Held bytes are an observation, never a budget. */
export function classify(
  allocate: (maxByteLength: number) => object,
  retained: object[],
): ProbeResult {
  let chunkBytes = PROBE_CEILING_BYTES;
  let reachedBytes = 0;
  while (reachedBytes < PROBE_CEILING_BYTES) {
    if (reserve(allocate, retained, chunkBytes)) {
      reachedBytes += chunkBytes;
      continue;
    }
    if (reachedBytes > 0) return { reachedBytes, chunkBytes, ceilingReached: false };
    if (chunkBytes === 256 * 1024 ** 2)
      return { reachedBytes: 0, chunkBytes: 0, ceilingReached: false };
    chunkBytes /= 2;
  }
  return { reachedBytes, chunkBytes, ceilingReached: true };
}
