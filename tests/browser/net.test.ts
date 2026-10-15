// Unit tests for the browser networking bridge pieces: bun test tests/net.test.ts (from web/).
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ResponseParser, type ResponseHead, serializeRequest } from "../src/net/http1";
import { CAPACITY, RingReader, RingWriter, createRing } from "../src/net/ring";
import { installHostSlots, trampolineModule } from "../src/net/trampoline";
import { MemFS } from "../src/fs";
import { Wasi } from "../src/wasi";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

test("trampoline module forwards each arity to its import", () => {
  const bytes = trampolineModule([1, 3, 4, 1]);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const calls: number[][] = [];
  const h = {
    f0: (a: number) => (calls.push([a]), a + 1),
    f1: (a: number, b: number, c: number) => (calls.push([a, b, c]), a + b + c),
    f2: (a: number, b: number, c: number, d: number) => (calls.push([a, b, c, d]), -4),
    f3: () => 7,
  };
  const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), { h }).exports;
  // The exports are wasm functions: a funcref table accepts them.
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  for (let i = 0; i < 4; i++) table.grow(1, exports[`f${i}`] as never);
  expect((table.get(0) as Function)(41)).toBe(42);
  expect((table.get(1) as Function)(1, 2, 3)).toBe(6);
  expect((table.get(2) as Function)(1, 2, 3, 4)).toBe(-4);
  expect((table.get(3) as Function)(5)).toBe(7);
  expect(calls).toEqual([[41], [1, 2, 3], [1, 2, 3, 4]]);
});

const bunWasm = join(import.meta.dir, "../../dist/bun.wasm");
test.skipIf(!existsSync(bunWasm))("installHostSlots fills bun.wasm's slot table", () => {
  const module = new WebAssembly.Module(readFileSync(bunWasm));
  const wasi = new Wasi({ args: ["bun"], env: {}, fs: new MemFS(), preopens: { "/": "/" }, stdout() {}, stderr() {}, sleep() {} });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const installed = installHostSlots(instance, { poll: () => 0, fetch: () => -1, close: () => 0 });
  expect(installed).toEqual(["poll", "fetch", "close"]);
  const ptr = (instance.exports.bun_wasm_host_slots as () => number)();
  const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
  expect(view.getUint32(ptr, true)).toBe(1);
  expect(view.getUint32(ptr + 4, true)).toBe(16);
  const table = instance.exports.__indirect_function_table as WebAssembly.Table;
  const slot = (i: number) => view.getUint32(ptr + 8 + 4 * i, true);
  expect(slot(0)).toBeGreaterThan(0);
  expect(slot(2)).toBe(0); // fetch_head not provided
  expect((table.get(slot(1)) as Function)(0, 0, 0, 0)).toBe(-1);
});

test("ring keeps records in order across the wrap point and waits when full", async () => {
  const sab = createRing();
  const writer = new RingWriter(sab);
  const reader = new RingReader(sab);
  const chunk = new Uint8Array(60_000).fill(7);
  const total = Math.ceil((CAPACITY * 3) / chunk.length); // three laps around the ring
  let received = 0;
  let bytes = 0;
  // Fire every write at once: the queue must hold them until the reader makes room.
  const writes = Array.from({ length: total }, (_, i) => writer.write(i + 1, 2, chunk.subarray(0, chunk.length - i)));
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
      data: (c) => (out.body += decode(c)),
      end: () => (out.ended = true),
      error: (m) => (out.error = m),
    },
    isHead,
  );
  for (const c of chunks) parser.push(encode(c));
  return { out, parser };
}

test("response parser: content-length, split anywhere", () => {
  const raw = "HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nX-A: 1\r\nX-A: 2\r\nContent-Length: 5\r\n\r\nhello";
  for (let cut = 1; cut < raw.length; cut++) {
    const { out } = parse([raw.slice(0, cut), raw.slice(cut)]);
    expect(out.head).toEqual({ status: 201, statusText: "Created", headers: [["content-type", "text/plain"], ["x-a", "1"], ["x-a", "2"], ["content-length", "5"]] });
    expect(out.body).toBe("hello");
    expect(out.ended).toBe(true);
  }
});

test("response parser: chunked with trailers, 100 Continue, until-close, HEAD", () => {
  const chunked = parse(["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel", "lo\r\n6;ext=1\r\n world\r\n0\r\nx-t: 1\r\n\r\n"]);
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
    { method: "POST", target: "/api?x=1", headers: [["Content-Type", "text/plain"], ["Host", "evil"], ["Connection", "keep-alive"]], body: encode("hi") },
    "localhost:3000",
  );
  expect(decode(bytes)).toBe("POST /api?x=1 HTTP/1.1\r\nhost: localhost:3000\r\nContent-Type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi");
});

test("raw preview connections preserve upgrade and duplex frame bytes", async () => {
  const { NetHelper } = await import("../src/net/helper");
  const sab = createRing();
  const reader = new RingReader(sab);
  const helper = new NetHelper(sab);
  const received: Uint8Array[] = [];
  let ended = false;
  try {
    helper.handle({ type: "listen", id: 1, port: 3000, host: "localhost" });
    const connection = helper.connect(3000, {
      data: (bytes) => received.push(bytes),
      end: () => { ended = true; },
      error: (message) => { throw new Error(message); },
    });
    expect(connection).not.toBeNull();
    connection!.write(encode("GET /hmr HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
    await Bun.sleep(1);
    const announced = reader.drain();
    expect(announced[0]!.kind).toBe(5);
    const conn = JSON.parse(decode(announced[0]!.payload)).conn;
    expect(decode(announced[1]!.payload)).toContain("Upgrade: websocket");
    helper.handle({ type: "write", id: conn, data: encode("HTTP/1.1 101 Switching Protocols\r\n\r\n") });
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
  } finally { helper.dispose(); }
});
