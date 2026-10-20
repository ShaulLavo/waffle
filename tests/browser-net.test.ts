// Generic networking regressions moved with the transport, HTTP framing and handle services.
import { expect, test } from "bun:test";
import { ResponseParser, type ResponseHead, serializeRequest } from "../browser/net/http1";
import { MAX_RECORD } from "../browser/net/protocol";
import { CAPACITY, RingReader, RingWriter, createRing } from "../browser/net/ring";
import { MemFS } from "../fs/memory";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const noFetch = async (): Promise<Response> => {
  throw new Error("Unexpected external fetch");
};

test("ring keeps records in order across the wrap point and waits when full", async () => {
  const sab = createRing();
  const writer = new RingWriter(sab);
  const reader = new RingReader(sab);
  const chunk = new Uint8Array(60_000).fill(7);
  const total = Math.ceil((CAPACITY * 3) / chunk.length); // three laps around the ring
  let received = 0;
  let bytes = 0;
  // Fire every write at once: the queue must hold them until the reader makes room.
  const writes = Array.from({ length: total }, (_, i) =>
    writer.write(i + 1, 2, chunk.subarray(0, chunk.length - i)),
  );
  while (received < total) {
    await Bun.sleep(1);
    for (const record of reader.drain()) {
      expect(record.handle).toBe(received + 1);
      expect(record.payload.length).toBe(chunk.length - received);
      expect(record.payload.every((b) => b === 7)).toBe(true);
      received++;
      bytes += record.payload.length;
    }
  }
  await Promise.all(writes);
  expect(bytes).toBeGreaterThan(CAPACITY);
  expect(reader.drain()).toEqual([]);
});

function parse(chunks: string[], isHead = false) {
  const out = { head: null as ResponseHead | null, body: "", ended: false, error: "" };
  const parser = new ResponseParser(
    {
      head: (h) => (out.head = h),
      data: (c) => {
        out.body += decode(c);
      },
      end: () => (out.ended = true),
      error: (m) => (out.error = m),
    },
    isHead,
  );
  for (const c of chunks) parser.push(encode(c));
  return { out, parser };
}

test("response parser: content-length, split anywhere", () => {
  const raw =
    "HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nX-A: 1\r\nX-A: 2\r\nContent-Length: 5\r\n\r\nhello";
  for (let cut = 1; cut < raw.length; cut++) {
    const { out } = parse([raw.slice(0, cut), raw.slice(cut)]);
    expect(out.head).toEqual({
      status: 201,
      statusText: "Created",
      headers: [
        ["content-type", "text/plain"],
        ["x-a", "1"],
        ["x-a", "2"],
        ["content-length", "5"],
      ],
    });
    expect(out.body).toBe("hello");
    expect(out.ended).toBe(true);
  }
});

test("response parser: chunked with trailers, 100 Continue, until-close, HEAD", () => {
  const chunked = parse([
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel",
    "lo\r\n6;ext=1\r\n world\r\n0\r\nx-t: 1\r\n\r\n",
  ]);
  expect(chunked.out.head?.status).toBe(200);
  expect(chunked.out.body).toBe("hello world");
  expect(chunked.out.ended).toBe(true);

  const close = parse(["HTTP/1.1 200 OK\r\n\r\nstream", "ing"]);
  expect(close.out.ended).toBe(false);
  close.parser.end();
  expect(close.out.body).toBe("streaming");
  expect(close.out.ended).toBe(true);

  const head = parse(["HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n"], true);
  expect(head.out.ended).toBe(true);

  const broken = parse(["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"]);
  broken.parser.end();
  expect(broken.out.error).toContain("mid-response");
});

test("request serialization sets host, length and connection: close", () => {
  const bytes = serializeRequest(
    {
      method: "POST",
      target: "/api?x=1",
      headers: [
        ["Content-Type", "text/plain"],
        ["Host", "evil"],
        ["Connection", "keep-alive"],
      ],
      body: encode("hi"),
    },
    "localhost:3000",
  );
  expect(decode(bytes)).toBe(
    "POST /api?x=1 HTTP/1.1\r\nhost: localhost:3000\r\nContent-Type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi",
  );
});

test("raw preview connections preserve upgrade and duplex frame bytes", async () => {
  const { NetHelper } = await import("../browser/net/helper");
  const sab = createRing();
  const reader = new RingReader(sab);
  const helper = new NetHelper(sab, noFetch);
  const received: Uint8Array[] = [];
  let ended = false;
  try {
    helper.handle({ type: "listen", id: 1, port: 3000, host: "localhost" });
    const connection = helper.connect(3000, {
      data: (bytes) => {
        received.push(bytes);
      },
      end: () => {
        ended = true;
      },
      error: (message) => {
        throw new Error(message);
      },
    });
    expect(connection).not.toBeNull();
    connection!.write(
      encode("GET /hmr HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
    );
    await Bun.sleep(1);
    const announced = reader.drain();
    expect(announced[0]!.kind).toBe(5);
    const conn = JSON.parse(decode(announced[0]!.payload)).conn;
    expect(decode(announced[1]!.payload)).toContain("Upgrade: websocket");
    helper.handle({
      type: "write",
      id: conn,
      data: encode("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
    });
    helper.handle({ type: "write", id: conn, data: new Uint8Array([0x82, 3, 0, 254, 255]) });
    expect(ended).toBe(false);
    expect(received[1]).toEqual(new Uint8Array([0x82, 3, 0, 254, 255]));
    connection!.write(new Uint8Array([0x89, 0x80, 1, 2, 3, 4]));
    await Bun.sleep(1);
    expect(reader.drain()[0]!.payload).toEqual(new Uint8Array([0x89, 0x80, 1, 2, 3, 4]));
    const big = new Uint8Array(130000).fill(42);
    connection!.write(big);
    connection!.write(new Uint8Array([7, 8, 9]));
    big.fill(0);
    await Bun.sleep(1);
    const queued = reader.drain();
    expect(queued.map((record) => record.payload.length)).toEqual([65536, 64464, 3]);
    expect(queued[0]!.payload[0]).toBe(42);
    expect(queued[1]!.payload.at(-1)).toBe(42);
    expect(queued[2]!.payload).toEqual(new Uint8Array([7, 8, 9]));
    helper.handle({ type: "close", id: conn });
    expect(ended).toBe(true);
    expect(helper.connect(9999, { data() {}, end() {}, error() {} })).toBeNull();
  } finally {
    helper.dispose();
  }
});

test("disposing a full ring releases blocked writes and drops queued records", async () => {
  const sab = createRing();
  const writer = new RingWriter(sab);
  const reader = new RingReader(sab);
  const bytes = new Uint8Array(MAX_RECORD);
  await Promise.all(Array.from({ length: 15 }, (_, id) => writer.write(id, 2, bytes)));
  const pending = writer.write(16, 2, bytes);
  await Bun.sleep(1);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    writer.dispose();
    const released = await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 100);
      }),
    ]);
    expect(released).toBe(true);
    expect(reader.drain()).toHaveLength(15);
    await writer.write(17, 2, bytes);
    expect(reader.drain()).toHaveLength(0);
  } finally {
    clearTimeout(timeout);
    reader.drain();
    await pending;
  }
});

test("shared-filesystem notifications wake HMR without replaying stale saved bytes", async () => {
  const { NetHelper } = await import("../browser/net/helper");
  const { NetHost } = await import("../browser/net/host");
  const sab = createRing();
  const fs = new MemFS();
  const replacements: string[] = [];
  const helper = new NetHelper(sab, noFetch);
  const host = new NetHost(
    sab,
    () => {},
    (path, bytes) => {
      replacements.push(path);
      fs.writeFile(path, bytes);
    },
  );
  try {
    for (const latest of ["newer", "", "x".repeat(MAX_RECORD * 2)]) {
      // Save A, queue its wakeup, then commit save B before the guest consumes A.
      // The old changeFile(A) path used to write A again at this point, rolling B back.
      fs.writeFile("/app.ts", "older");
      await helper.notifyFileChanged("/app.ts");
      fs.writeFile("/app.ts", latest);
      expect(host.poll(0)).toBe(1);
      expect(decode(fs.readFile("/app.ts")!)).toBe(latest);
      expect(replacements).toEqual([]);
      await helper.notifyFileChanged("/app.ts");
      host.poll(0);
      expect(decode(fs.readFile("/app.ts")!)).toBe(latest);
    }
    // Callers that have not written the shared filesystem can still replace a guest file.
    await helper.changeFile("/app.ts", "direct replacement");
    host.poll(0);
    expect(decode(fs.readFile("/app.ts")!)).toBe("direct replacement");
    expect(replacements).toEqual(["/app.ts"]);
  } finally {
    helper.dispose();
  }
});

test("shared-filesystem notifications reject invalid paths and stopped workers", async () => {
  const { NetHelper } = await import("../browser/net/helper");
  const helper = new NetHelper(createRing(), noFetch);
  try {
    await expect(helper.notifyFileChanged("relative.ts")).rejects.toThrow(
      "Expected an absolute guest path",
    );
    await expect(helper.notifyFileChanged("/bad\0path")).rejects.toThrow(
      "Expected an absolute guest path",
    );
    helper.dispose();
    await expect(helper.notifyFileChanged("/app.ts")).rejects.toThrow("The server stopped");
  } finally {
    helper.dispose();
  }
});

test("stopping a worker rejects a file update blocked behind a full ring", async () => {
  const { NetHelper } = await import("../browser/net/helper");
  const sab = createRing();
  const reader = new RingReader(sab);
  const helper = new NetHelper(sab, noFetch);
  const pending = helper.changeFile("/app.ts", new Uint8Array(CAPACITY * 2)).then(
    () => null,
    (error: unknown) => error,
  );
  await Bun.sleep(1);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    helper.dispose();
    const error = await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("not released"), 100);
      }),
    ]);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("File update remained blocked after disposal");
    expect(error.message).toBe("The server stopped");
  } finally {
    clearTimeout(timeout);
    reader.drain();
    helper.dispose();
    await pending;
  }
});
