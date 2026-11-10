import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { frame, Frames, plistLimits } from "./inspector-plist.js";
import { InspectorStream, inspectorEnvelope, type InspectorEnvelope } from "./inspector-stream.js";
import { HostConsumers } from "./owned-consumers.js";

function respond(socket: Socket): void {
  const parser = new Frames();
  const answer = () => {
    const one = frame({ __selector: "event-one", __argument: { url: "https://owned.test/one" } });
    const two = frame({
      __selector: "event-two",
      __argument: { workerId: "real-framing-control" },
    });
    socket.write(one.subarray(0, 2));
    socket.write(Buffer.concat([one.subarray(2), two]));
  };
  socket.on("data", (bytes) => parser.feed(Buffer.from(bytes), answer));
}

test("real Unix stream handles fragmented and batched messages while a send waits", async () => {
  const root = await mkdtemp("/work/tmp/wi-cpu-");
  const path = join(root, "s");
  const sockets = new Set<Socket>();
  const received = Promise.withResolvers<void>();
  const events: InspectorEnvelope[] = [];
  const consumers = new HostConsumers();
  let loss: unknown;
  const server = createServer((socket) => {
    sockets.add(socket);
    respond(socket);
  });
  // Teardown is installed before connecting. No task server/process survives this CPU control.
  let stream: InspectorStream | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    stream = await InspectorStream.connect(
      path,
      consumers,
      (event) => {
        events.push(event);
        if (events.length === 2) received.resolve();
      },
      (error) => {
        loss = error;
      },
    );
    await stream.send("request", { data: "not Safari" });
    await received.promise;
    expect(events.map((event) => event.selector)).toEqual(["event-one", "event-two"]);
    expect(events[1]?.argument.workerId).toBe("real-framing-control");
    expect(loss).toBeUndefined();
  } finally {
    await stream?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  expect(await consumers.join(100)).toBe(true);
});

test("real framing rejects malformed, oversized and incomplete input rather than yielding empty events", () => {
  const parser = new Frames();
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(plistLimits.frame + 1);
  expect(() => parser.feed(oversized, () => {})).toThrow("exceeds");
  expect(() => parser.feed(Buffer.alloc(0), () => {})).toThrow("earlier failure");
  expect(() => inspectorEnvelope({ __selector: "bad", __argument: [] }, 1)).toThrow("argument");
  const split = new Frames();
  split.feed(frame({ __selector: "x" }).subarray(0, 9), () => {
    throw new Error("unexpected complete frame");
  });
  expect(split.atBoundary()).toBe(false);
});
