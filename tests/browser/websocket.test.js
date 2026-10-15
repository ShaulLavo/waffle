import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

// A host may synchronously fail a write. Simulate that boundary so the race
// does not depend on the kernel delivering an EPIPE at a particular instant.
test("a failed close-frame write releases the close-handshake timer", () => {
  const factory = (0, eval)(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/websocket.js", import.meta.url), "utf8"));
  const api = factory({ require: () => ({ Buffer }), printError: (error) => { throw error; } });
  const timers = [];
  const schedule = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms) => {
    const timer = schedule(callback, ms);
    if (ms === 10000) timers.push(timer);
    return timer;
  });
  let closed = 0;
  const connection = {
    closed: false, queue: [],
    peer: () => ({ address: "127.0.0.1" }),
    write() { this.closed = true; this.onClose(); },
  };
  try {
    const { socket } = api.serverSocket(connection, () => ({ close() { closed++; } }), {}, () => {}, () => 0);
    socket.close(1000);
    expect(closed).toBe(1);
    expect(socket.readyState).toBe(3);
    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    spy.mockRestore();
  }
});
