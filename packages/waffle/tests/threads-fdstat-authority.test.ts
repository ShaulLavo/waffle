import { expect, test } from "bun:test";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { createThreadLaneOwner, THREAD_LANE_BYTES } from "../thread/lane.ts";
import { outcomeWord, serializeOutcome, readOutcome } from "../proc/outcome.ts";
import type { GuestWorkerRequest } from "../thread/guest-worker.ts";
import type { FdstatAuthorityEvent } from "./threads-fdstat-authority-worker.ts";
import { guestModule, i32, call, store } from "./threads-guest-module.ts";
import { serviceFixture } from "./threads-service-fixture.ts";

test("actual guest fdstat has live native canaries and zero mutable-native observations", async () => {
  const fixture = await serviceFixture();
  const channel = new MessageChannel();
  const reply = new SharedArrayBuffer(THREAD_LANE_BYTES);
  const thread = { directory: "test", pid: 1, tid: 1 };
  const outcome = outcomeWord();
  const worker = new Worker(new URL("./threads-fdstat-authority-worker.ts", import.meta.url).href);
  const idle = Promise.withResolvers<void>();
  const events: FdstatAuthorityEvent[] = [];
  const failures: unknown[] = [];
  const owner = createThreadLaneOwner({
    thread,
    lane: { port: channel.port1, reply },
    terminal: () => readOutcome(outcome) !== null,
    failed: (error) => {
      failures.push(error);
      idle.reject(error);
    },
    dispatcher: {
      dispatch(key, request) {
        if (request.kind === "spawn") throw new Error("unexpected spawn");
        return fixture.service.submit(key, request);
      },
    },
  });
  const deadline = setTimeout(
    () => idle.reject(new Error("fdstat authority guest did not idle")),
    2000,
  );
  worker.onmessage = ({ data }: MessageEvent<FdstatAuthorityEvent>) => {
    events.push(data);
    if (data.kind === "ready") worker.postMessage({ kind: "enter" });
    if (data.kind === "host-idle") idle.resolve();
  };
  worker.onerror = (error) => idle.reject(new Error(error.message));
  try {
    const module = await compileThreadGuest(
      guestModule({
        imports: [{ name: "fd_fdstat_get", params: [0x7f, 0x7f] }],
        initial: store(32, i32(fixture.fd).concat(i32(256), call(0))),
      }),
    );
    const request: GuestWorkerRequest = {
      thread,
      module,
      memory: fixture.memory,
      entry: { kind: "initial" },
      outcome: serializeOutcome(outcome),
      signal: new SharedArrayBuffer(4),
      waits: new SharedArrayBuffer(12),
      lane: { port: channel.port2, reply },
      args: [],
      env: {},
    };
    worker.postMessage(request, [channel.port2]);
    await idle.promise;
    expect(events).toContainEqual({ kind: "fdstat-canaries", count: 8 });
    expect(events).toContainEqual({ kind: "fdstat-observations", count: 0 });
    expect(readOutcome(outcome)).toMatchObject({ kind: "exited", code: 0 });
    expect(new Int32Array(fixture.memory.buffer)[8]).toBe(0);
    expect(new DataView(fixture.memory.buffer).getUint8(256)).toBe(4);
    expect(failures).toEqual([]);
  } finally {
    clearTimeout(deadline);
    await owner.retire();
    worker.terminate();
    channel.port2.close();
    await fixture.dispose();
  }
});
