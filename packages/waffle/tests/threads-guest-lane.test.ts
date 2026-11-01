import { expect, test } from "bun:test";
import { createThreadLaneOwner, THREAD_LANE_BYTES } from "../thread/lane.ts";
import { serviceFixture } from "./threads-service-fixture.ts";

for (const invalid of ["repeat", "gap", "overlap", "malformed"] as const) {
  test(`owner retires ${invalid} calls without a second dispatch`, async () => {
    const fixture = await serviceFixture();
    const channel = new MessageChannel();
    const reply = new SharedArrayBuffer(THREAD_LANE_BYTES);
    const failed = Promise.withResolvers<void>();
    let dispatched = 0;
    const owner = createThreadLaneOwner({
      thread: { directory: "test", pid: 1, tid: 2 },
      lane: { port: channel.port1, reply },
      terminal: () => false,
      failed: () => {
        fixture.service.cancelAll();
        failed.resolve();
      },
      dispatcher: {
        async dispatch(call, request) {
          dispatched++;
          if (request.kind === "spawn") throw new Error("unexpected spawn");
          return fixture.service.submit(call, request);
        },
      },
    });
    const deadline = setTimeout(() => failed.reject(new Error("lane did not retire")), 2000);
    try {
      if (invalid === "malformed") {
        channel.port2.postMessage({
          sequence: 1,
          request: { kind: "read", fd: fixture.fd, spans: [null] },
        });
      } else if (invalid === "gap") {
        channel.port2.postMessage({ sequence: 2, request: { kind: "tell", fd: fixture.fd } });
      } else {
        channel.port2.postMessage({
          sequence: 1,
          request: { kind: "read", fd: fixture.fd, spans: [{ address: 256, length: 4 }] },
        });
        await fixture.event("held");
        channel.port2.postMessage({
          sequence: invalid === "repeat" ? 1 : 2,
          request: { kind: "tell", fd: fixture.fd },
        });
      }
      await failed.promise;
      fixture.send({ kind: "release" });
      await owner.retire();
      expect(dispatched).toBe(invalid === "gap" || invalid === "malformed" ? 0 : 1);
      expect(Atomics.load(new Int32Array(reply), 1)).toBe(1);
      expect(Atomics.load(new Int32Array(reply), 0)).toBe(0);
      expect(Array.from(new Uint8Array(fixture.memory.buffer, 256, 4))).toEqual([0, 0, 0, 0]);
    } finally {
      clearTimeout(deadline);
      fixture.send({ kind: "release" });
      fixture.service.cancelAll();
      await owner.retire();
      channel.port2.close();
      await fixture.dispose();
    }
  });
}
