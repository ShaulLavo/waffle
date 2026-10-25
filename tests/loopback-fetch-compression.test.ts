import { expect, test } from "bun:test";
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from "node:zlib";
import { body, decode, encode, handle, head, pair } from "./loopback-fetch-fixture.js";

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
    await expect(body(client, id)).rejects.toThrow("Body failed:");
    await served;
  },
);

test("already-decoded external body retains Content-Encoding without a second decode", async () => {
  const { client, url } = await pair(
    async () => new Response(text, { headers: { "content-encoding": "gzip" } }),
  );
  const id = await handle(client, {
    op: "fetch",
    url: `${url}/../external`.replace("localhost:32216", "fixture.invalid"),
  });
  expect(await head(client, id)).toMatchObject({ status: 200 });
  expect(decode(await body(client, id))).toBe(text);
});
