import type { Stream } from "./descriptors.js";

function discard(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

/** Process-local character devices do not create nodes or retain filesystem payloads. */
export function createNullDevice(fdflags = 0): Stream {
  return {
    kind: "device",
    device: "null",
    fdflags,
    read: () => 0,
    tryRead: () => 0,
    write: discard,
    tryWrite: discard,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    close() {},
  };
}
