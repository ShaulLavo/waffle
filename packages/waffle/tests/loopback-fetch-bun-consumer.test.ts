import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { body, decode, encode, handle, head, pair } from "./loopback-fetch-fixture.js";

const consumerRoot = process.env.BUN_WASM_SOURCE;
const consumerTest = consumerRoot ? test : test.skip;

function factory(source: string): (...args: unknown[]) => unknown {
  const value: unknown = new Function(`return (\n${source.trim().replace(/;$/, "")}\n)`)();
  if (typeof value !== "function") throw Error("Consumer module is not a factory");
  return (...args) => Reflect.apply(value, undefined, args);
}

class ConsumerResponse extends Response {
  static _setNetwork(response: Response, url: string, redirected: boolean) {
    Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } });
  }
}

async function consumerFetch(wireHead: unknown, bytes: Uint8Array) {
  if (!consumerRoot) throw Error("BUN_WASM_SOURCE is required");
  const source = join(consumerRoot, "crates/bunwasm-runtime/src/js");
  const compressionSource = await readFile(join(source, "compression_streams.ts"), "utf8");
  const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `export default ${compressionSource}`,
  );
  let codecCalls = 0;
  const compression = factory(transpiled.replace("export default", ""))({
    native: {
      streams: {
        release() {},
        webCodec() {
          codecCalls++;
          throw Error("Already-decoded body reached the consumer codec");
        },
      },
    },
  });
  let read = false;
  let closed = 0;
  let pump = () => {};
  const context = {
    native: {
      hostCaps: 1,
      platformInfo: { version: "contract-test" },
      hostFetch: () => 1,
      hostFetchHead: () => JSON.stringify(wireHead),
      hostRead: () => {
        if (read) return 0;
        read = true;
        return bytes.slice();
      },
      hostClose: () => {
        closed++;
      },
      hostError: () => JSON.stringify({ name: "TypeError", message: "body failed" }),
      wake: () => queueMicrotask(() => pump()),
    },
    web: { Request, Response: ConsumerResponse, Headers, ReadableStream, DOMException },
    require(name: string) {
      if (name === "compression_streams") return compression;
      if (name === "http_common") return {};
      if (name === "websocket") return { clientClass: () => class {} };
      throw Error(`Unexpected consumer module: ${name}`);
    },
  };
  const api = factory(await readFile(join(source, "net.js"), "utf8"))(context);
  const pumpIo: unknown = Reflect.get(context, "pumpIo");
  if (typeof pumpIo !== "function") throw Error("Consumer did not install its I/O pump");
  pump = () => {
    Reflect.apply(pumpIo, context, []);
  };
  if (
    typeof api !== "object" ||
    api === null ||
    !("fetch" in api) ||
    typeof api.fetch !== "function"
  )
    throw Error("Consumer Fetch is missing");
  const response: unknown = await Reflect.apply(api.fetch, api, ["http://localhost:32216/"]);
  if (!(response instanceof Response)) throw Error("Consumer Fetch did not return a Response");
  const text = await response.text();
  return { text, codecCalls, closed, headers: Array.from(response.headers) };
}

consumerTest.each([false, true])(
  "real Bun consumer bodyEncoding contract, external=%s",
  async (external) => {
    const text = "bodyEncoding is absent because Waffle already decoded this body";
    const { server, client, listener, url } = await pair(
      async () => new Response(text, { headers: { "content-encoding": "gzip" } }),
    );
    const zipped = gzipSync(text);
    const headers = encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${zipped.length}\r\n\r\n`,
    );
    const serving = external
      ? Promise.resolve()
      : server.call({
          op: "respond",
          listener,
          bytes: new Uint8Array(Buffer.concat([headers, zipped])),
        });
    const id = await handle(client, {
      op: "fetch",
      url: external ? "https://fixture.invalid/decoded" : url,
    });
    const wireHead = await head(client, id);
    const bytes = await body(client, id);
    expect(decode(bytes)).toBe(text);
    expect(wireHead).not.toHaveProperty("bodyEncoding");
    const result = await consumerFetch(wireHead, bytes);
    expect(result.text).toBe(text);
    expect(result.codecCalls).toBe(0);
    expect(result.closed).toBe(1);
    expect(result.headers).toContainEqual(["content-encoding", "gzip"]);
    await serving;
  },
);
