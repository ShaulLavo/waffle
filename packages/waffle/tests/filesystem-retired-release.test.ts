import { expect, test } from "bun:test";
import { FilesystemClient } from "../fs/client.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { retireRequestMemory } from "../fs/request-memory.js";

for (const state of [
  "unreaped",
  "unretired",
  "failed",
  "in-section",
  "messageerror",
  "protocol",
] as const) {
  test(`local reference release preserves ${state} transport failure`, () => {
    const pair = createFilesystemConnection();
    const client = new FilesystemClient(pair.client);
    const memory = pair.client.requests;
    const words = new BigInt64Array(memory.control);
    const tagged = (value: number) => (BigInt(memory.generation) << 32n) | BigInt(value);
    try {
      // Synthetic negative states exercise the guard, not actual retirement qualification.
      Atomics.store(new Int32Array(pair.client.revocations[0]!), 0, state === "unreaped" ? 1 : 2);
      if (state !== "unretired") retireRequestMemory(memory, state === "failed" ? 29 : 0);
      if (state === "in-section") Atomics.store(words, 7, tagged(1));
      Atomics.store(words, 1, tagged(state === "messageerror" ? 1 : state === "protocol" ? 3 : 2));
      expect(() => client.release(1)).toThrow(
        expect.objectContaining({
          code: "CLOSED",
          reason: state === "messageerror" || state === "protocol" ? state : "stale",
        }),
      );
    } finally {
      client.dispose();
      pair.server.port.close();
    }
  });
}
