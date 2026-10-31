import { expect, test } from "bun:test";
import { createRelayConnect } from "../src/tcp-client.js";
import { frameCredit, parseFrame } from "../src/tcp-protocol.js";
import type { ClientWebSocket, WebSocketEvents } from "../src/tcp-websocket.js";

const target = { host: "db.example", port: 80 };
function fixture(
  reply: string | null = JSON.stringify({
    v: 1,
    ok: true,
    remote: { address: "8.8.8.8", port: 80, family: "IPv4" },
  }),
) {
  let events: WebSocketEvents | undefined;
  let closes = 0,
    detached = 0;
  const frames: (string | Uint8Array)[] = [];
  const socket: ClientWebSocket = {
    bufferedAmount: 0,
    send(data) {
      frames.push(data);
      if (typeof data === "string" && reply !== null) queueMicrotask(() => events!.message(reply));
    },
    close(code) {
      closes++;
      queueMicrotask(() => events?.close(code));
    },
    listen(value) {
      events = value;
      queueMicrotask(() => value.open());
      return () => {
        detached++;
        events = undefined;
      };
    },
  };
  const relay = createRelayConnect({
    endpoint: "https://relay.example/",
    getToken: () => "fixture",
    windowBytes: 8,
    webSocket: () => socket,
    connectTimeoutMs: 20,
  });
  return {
    relay,
    frames,
    get events() {
      return events!;
    },
    get closes() {
      return closes;
    },
    get detached() {
      return detached;
    },
  };
}
test("client admits no payload until the one successful open, then waits for credit", async () => {
  const run = fixture();
  try {
    const stream = await run.relay.connect(target, new AbortController().signal);
    expect(run.frames.length).toBe(1);
    const writer = stream.writable.getWriter();
    let completed = false;
    const write = writer.write(new Uint8Array(16)).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(completed).toBe(false);
    expect(stream.counters.sendOutstandingBytes).toBe(8);
    run.events.message(frameCredit(8));
    await write;
    expect(
      run.frames
        .filter((frame) => frame instanceof Uint8Array)
        .map((frame) => parseFrame(frame as Uint8Array).kind),
    ).toEqual(["data", "data"]);
    await run.relay.close();
    expect(run.closes).toBe(1);
    expect(run.detached).toBe(1);
  } finally {
    await run.relay.close();
  }
});
test("receive queue withholds credit until an actual read and rejects data after FIN", async () => {
  const run = fixture();
  try {
    const stream = await run.relay.connect(target, new AbortController().signal);
    run.events.message(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(stream.counters.receiveQueuedBytes).toBe(8);
    expect(run.frames.length).toBe(1);
    const reader = stream.readable.getReader();
    expect((await reader.read()).value?.length).toBe(8);
    expect(stream.counters.receiveQueuedBytes).toBe(0);
    expect(run.frames.length).toBe(2);
    run.events.message(new Uint8Array([1]));
    run.events.message(new Uint8Array([0, 1]));
    await run.relay.close();
    expect(run.closes).toBe(1);
    expect(run.detached).toBe(1);
  } finally {
    await run.relay.close();
  }
});
test("pre-reply carrier loss is final in N2 and no established connection reconnects", async () => {
  const run = fixture(null);
  const opening = run.relay.connect(target, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 1));
  run.events.close(1006);
  await expect(opening).rejects.toHaveProperty("code", "ENETUNREACH");
  await run.relay.close();
  expect(run.detached).toBe(1);
  expect(run.frames.length).toBe(1);
});
test("opening timeout cleans up the carrier before close resolves", async () => {
  const run = fixture(null);
  await expect(run.relay.connect(target, new AbortController().signal)).rejects.toHaveProperty(
    "code",
    "ETIMEDOUT",
  );
  await run.relay.close();
  expect(run.detached).toBe(1);
  expect(run.closes).toBe(1);
});
test("failed open reply is final and simultaneous FIN/reset settles once", async () => {
  const denied = fixture('{"v":1,"ok":false,"code":"relay-auth"}');
  await expect(denied.relay.connect(target, new AbortController().signal)).rejects.toHaveProperty(
    "code",
    "EACCES",
  );
  await denied.relay.close();
  expect(denied.closes).toBe(1);
  const run = fixture();
  const stream = await run.relay.connect(target, new AbortController().signal);
  const writer = stream.writable.getWriter();
  await writer.close();
  run.events.message(new Uint8Array([1]));
  run.relay.revoke();
  await run.relay.close();
  expect(run.detached).toBe(1);
  expect(run.closes).toBe(1);
});
test("no carrier, remote cleartext and invalid endpoint fail without allocating a socket", async () => {
  const onlyWT = createRelayConnect({
    endpoint: "https://relay.example/",
    getToken: () => "fixture",
    carriers: ["webtransport"],
  });
  await expect(onlyWT.connect(target, new AbortController().signal)).rejects.toHaveProperty(
    "code",
    "ENETUNREACH",
  );
  await onlyWT.close();
  for (const endpoint of [
    "http://remote.example/",
    "https://user@relay.example/",
    "https://relay.example/?token=x",
    "https://relay.example/else",
  ])
    expect(() => createRelayConnect({ endpoint, getToken: () => "fixture" })).toThrow();
});

test("ambiguous destinations fail as redacted policy errors before token retrieval", async () => {
  let calls = 0;
  const relay = createRelayConnect({
    endpoint: "https://relay.example/",
    getToken: () => {
      calls++;
      return "fixture";
    },
  });
  await expect(
    relay.connect({ host: "127.1", port: 80 }, new AbortController().signal),
  ).rejects.toHaveProperty("code", "EACCES");
  expect(calls).toBe(0);
  await relay.close();
});
