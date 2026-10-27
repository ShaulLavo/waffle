import { expect, test } from "bun:test";
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from "node:zlib";
import {
  body,
  decode,
  encode,
  handle,
  head,
  pair,
  settled,
  response,
} from "./loopback-fetch-fixture.js";

function compressedResponse(encoding: string, bytes: Uint8Array) {
  const headers = encode(
    `HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${bytes.length}\r\n\r\n`,
  );
  return new Uint8Array(Buffer.concat([headers, bytes]));
}
const text = "browser OS gzip response";
test("shared Worker decodes loopback gzip application bytes", async () => {
  const { server, client, listener, url } = await pair();
  const served = server.call({
    op: "respond",
    listener,
    bytes: compressedResponse("gzip", gzipSync(text)),
  });
  const id = await handle(client, { op: "fetch", url });
  expect(await head(client, id)).toMatchObject({
    status: 200,
    headers: expect.arrayContaining([["content-encoding", "gzip"]]),
  });
  expect(decode(await body(client, id))).toBe(text);
  await served;
});

test.each([
  ["deflate", deflateSync(text)],
  ["br", brotliCompressSync(text)],
  ["zstd", zstdCompressSync(text)],
  ["x-gzip", gzipSync(text)],
  ["GZip", gzipSync(text)],
  ["identity", encode(text)],
  ["gzip, br", brotliCompressSync(gzipSync(text))],
])("shared Worker decodes %s", async (encoding, bytes) => {
  const { server, client, listener, url } = await pair();
  const served = server.call({
    op: "respond",
    listener,
    bytes: compressedResponse(encoding, bytes),
  });
  const id = await handle(client, { op: "fetch", url });
  expect(await head(client, id)).toMatchObject({ status: 200 });
  expect(decode(await body(client, id))).toBe(text);
  await served;
});

test.each(["gzip", "deflate", "br", "zstd", "unsupported"])(
  "bad %s fails after the head through the body contract",
  async (encoding) => {
    const { server, client, listener, url } = await pair();
    const served = server.call({
      op: "respond",
      listener,
      bytes: compressedResponse(encoding, encode("not compressed")),
    });
    const id = await handle(client, { op: "fetch", url });
    expect(await head(client, id)).toMatchObject({ status: 200 });
    const failure = await body(client, id).then(
      () => "success",
      (error: unknown) => String(error),
    );
    expect(failure).toContain("Body failed:");
    await served;
  },
);

test("already-decoded external body retains Content-Encoding without a second decode", async () => {
  const { client } = await pair(
    async () => new Response(text, { headers: { "content-encoding": "gzip" } }),
  );
  const id = await handle(client, {
    op: "fetch",
    url: "https://fixture.invalid/external",
  });
  expect(await head(client, id)).toMatchObject({ status: 200 });
  expect(decode(await body(client, id))).toBe(text);
});

test("high-expansion gzip streams before EOF, stops at fetch credit and cancels its peer", async () => {
  const { server, client, listener, url } = await pair();
  const plain = new Uint8Array(8 << 20).fill(65);
  const zipped = gzipSync(plain);
  const id = await handle(client, { op: "fetch", url });
  const accepted = await settled(server, { op: "accept", handle: listener });
  if (typeof accepted !== "number" || accepted <= 0) throw Error("No virtual socket");
  const prefix = compressedResponse("gzip", zipped).subarray(0, -Math.ceil(zipped.length / 2));
  expect(await server.call({ op: "write", handle: accepted, bytes: prefix })).toBe(prefix.length);
  expect(await head(client, id)).toMatchObject({ status: 200 });
  const first = await settled(client, { op: "read", handle: id, cap: 65536 });
  expect(first).toBeInstanceOf(Uint8Array);
  if (!(first instanceof Uint8Array)) throw Error("No incremental decoded body");
  expect(first.every((value) => value === 65)).toBe(true);
  for (let index = 0; index < 100 && client.counts().inFlight[0] !== 512 * 1024; index++)
    await Bun.sleep(1);
  expect(client.counts().inFlight).toEqual([512 * 1024]);
  await Bun.sleep(10);
  expect(client.counts().inFlight).toEqual([512 * 1024]);
  await client.call({ op: "close", handle: id });
  for (let index = 0; index < 100 && client.counts().sockets !== 0; index++) await Bun.sleep(1);
  expect(client.counts()).toEqual({ jobs: 0, sockets: 0, connections: 0, inFlight: [] });
  expect(await server.call({ op: "write", handle: accepted, bytes: encode("suffix") })).toBe(-1);
});

test("large decoded output finishes intact across many Fetch windows", async () => {
  const { server, client, listener, url } = await pair();
  const plain = new Uint8Array((3 << 20) + 127).fill(66);
  const serving = server.call({
    op: "respond",
    listener,
    bytes: compressedResponse("gzip", gzipSync(plain)),
  });
  const id = await handle(client, { op: "fetch", url });
  await head(client, id);
  const decoded = await body(client, id);
  expect(decoded.length).toBe(plain.length);
  expect(decoded.every((value) => value === 66)).toBe(true);
  await serving;
  expect(client.counts()).toEqual({ jobs: 0, sockets: 0, connections: 0, inFlight: [] });
});

test.each([204, 304])(
  "status %s with Content-Encoding has no compressed body to decode",
  async (status) => {
    const { server, client, listener, url } = await pair();
    const serving = server.call({
      op: "respond",
      listener,
      bytes: response(status, "Content-Encoding: gzip\r\n"),
    });
    const id = await handle(client, { op: "fetch", url });
    expect(await head(client, id)).toMatchObject({ status });
    expect(await body(client, id)).toHaveLength(0);
    await serving;
  },
);

test("a redirect discards encoded bytes without decoding them", async () => {
  const { server, client, listener, url } = await pair();
  const first = server.call({
    op: "respond",
    listener,
    bytes: response(302, "Content-Encoding: gzip\r\nLocation: /done\r\n", "invalid gzip"),
  });
  const id = await handle(client, { op: "fetch", url });
  await first;
  const final = server.call({ op: "respond", listener, bytes: response(200, "", "done") });
  expect(await head(client, id)).toMatchObject({ status: 200, redirected: true });
  expect(decode(await body(client, id))).toBe("done");
  await final;
});

test("HEAD preserves encoding headers without starting a decoder", async () => {
  const { server, client, listener, url } = await pair();
  const serving = server.call({
    op: "respond",
    listener,
    bytes: encode("HTTP/1.1 200 OK\r\nContent-Encoding: unsupported\r\nContent-Length: 44\r\n\r\n"),
  });
  const id = await handle(client, { op: "fetch", url, method: "HEAD" });
  expect(await head(client, id)).toMatchObject({ status: 200 });
  expect(await body(client, id)).toHaveLength(0);
  await serving;
});

test("platform-unavailable codecs fail the body without an encoded fallback", async () => {
  const original = globalThis.DecompressionStream;
  class RestrictedDecoder extends original {
    constructor(format: CompressionFormat) {
      if (String(format) === "brotli") throw new TypeError("Codec unavailable on this platform");
      super(format);
    }
  }
  globalThis.DecompressionStream = RestrictedDecoder;
  try {
    const { server, client, listener, url } = await pair();
    const serving = server.call({
      op: "respond",
      listener,
      bytes: compressedResponse("br", brotliCompressSync(text)),
    });
    const id = await handle(client, { op: "fetch", url });
    expect(await head(client, id)).toMatchObject({ status: 200 });
    const failure = await body(client, id).then(
      () => "success",
      (error: unknown) => String(error),
    );
    expect(failure).toContain("Codec unavailable on this platform");
    await serving;
    expect(client.counts()).toEqual({ jobs: 0, sockets: 0, connections: 0, inFlight: [] });
  } finally {
    globalThis.DecompressionStream = original;
  }
});
