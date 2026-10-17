import { expect, test } from "bun:test";
import { NetHost as RuntimeNetHost } from "@bun-wasm/runtime/browser/net/host";
import { AGAIN, BADF, Kind, type NetRequest, UNSUPPORTED } from "@bun-wasm/runtime/browser/net/protocol";
import { createRing, RingWriter } from "@bun-wasm/runtime/browser/net/ring";
import { NetHost } from "../src/net/host";
import { NetHelper } from "../src/net/helper";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("Network adapter did not make progress");
}

test("Bun slots decode grown guest memory and preserve transferred request bytes", () => {
  const messages: NetRequest[] = [];
  const host = new NetHost(createRing(), (message, transfer) => messages.push(structuredClone(message, { transfer })));
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const slots = host.slots();
  memory.grow(1);
  const bytes = new Uint8Array(memory.buffer);
  const meta = encode(JSON.stringify({ url: "https://network.invalid/", method: "POST" }));
  const body = encode("guest body");
  bytes.set(meta, 65536);
  bytes.set(body, 66000);
  expect(slots.fetch!(65536, meta.length, 66000, body.length)).toBeGreaterThan(0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "fetch", body });
  expect(bytes.subarray(66000, 66000 + body.length)).toEqual(body);
});

test("Bun sized-result slots return full length without overwriting a small buffer", async () => {
  const sab = createRing();
  const host = new NetHost(sab, () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const bytes = new Uint8Array(memory.buffer);
  const meta = encode(JSON.stringify({ url: "https://network.invalid/" }));
  bytes.set(meta, 32);
  const slots = host.slots();
  const handle = slots.fetch!(32, meta.length, 0, 0);
  expect(slots.fetch_head!(handle, 1000, 100)).toBe(AGAIN);
  const writer = new RingWriter(sab);
  try {
    const head = encode('{"status":201,"headers":[]}');
    await writer.write(handle, Kind.Head, head);
    bytes.fill(0x7f, 1000, 1100);
    expect(slots.fetch_head!(handle, 1000, head.length - 1)).toBe(head.length);
    expect(bytes.subarray(1000, 1000 + head.length)).toEqual(new Uint8Array(head.length).fill(0x7f));
    expect(slots.fetch_head!(handle, 1000, head.length)).toBe(head.length);
    expect(bytes.subarray(1000, 1000 + head.length)).toEqual(head);
    await writer.write(handle, Kind.Data, encode("hello"));
    expect(slots.read!(handle, 1200, 3)).toBe(3);
    expect(decode(bytes.subarray(1200, 1203))).toBe("hel");
    expect(slots.read!(handle, 1200, 3)).toBe(2);
    expect(decode(bytes.subarray(1200, 1202))).toBe("lo");
    expect(slots.read!(999, 1200, 3)).toBe(BADF);
  } finally {
    writer.dispose();
  }
});

test("Bun pointer slots and browser natives share the same generic handle state", () => {
  const host = new NetHost(createRing(), () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const slots = host.slots();
  const api = host.engineNet().natives;
  const call = (name: string, ...args: unknown[]) => Reflect.apply(api[name]!, null, args);
  const hostname = encode("localhost");
  new Uint8Array(memory.buffer).set(hostname, 128);
  const listener = slots.listen!(128, hostname.length, 0);
  const port = call("hostLocalPort", listener);
  const client = call("hostConnect", "localhost", port);
  const server = slots.accept!(listener);
  const request = encode("request");
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(request, 256);
  expect(slots.write!(client, 256, request.length)).toBe(request.length);
  bytes.fill(0, 256, 256 + request.length);
  expect(call("hostRead", server)).toEqual(request);
  const response = encode("response");
  expect(call("hostWrite", server, response)).toBe(response.length);
  response.fill(0);
  memory.grow(1);
  expect(slots.read!(client, 65536, 100)).toBe(8);
  expect(decode(new Uint8Array(memory.buffer, 65536, 8))).toBe("response");
  const length = slots.local_addr!(server, 66000, 200);
  expect(JSON.parse(decode(new Uint8Array(memory.buffer, 66000, length))).port).toBe(port);
  for (const handle of [client, server, listener]) expect(slots.close!(handle)).toBe(0);
});

test("Bun browser-native names and capability flags remain in the adapter", () => {
  const net = new NetHost(createRing(), () => {}).engineNet();
  const call = (name: string, ...args: unknown[]) => Reflect.apply(net.natives[name]!, null, args);
  expect(call("hostPoll")).toBe(UNSUPPORTED);
  expect(call("hostFetch", "malformed")).toBe(-1);
  expect(JSON.parse(call("hostError", 0)).message).toContain("malformed request metadata");
  expect(net.caps.poll).toBe(false);
  expect(net.caps.signal).toBe(false);
  expect(net.caps.fetch).toBe(true);
  expect(net.caps.connect).toBe(true);
  expect(typeof net.onNews).toBe("function");
});

test("Bun helper keeps installer cache policy outside the generic runtime", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  const opened: string[] = [];
  const cache = {
    async match(url: string) {
      expect(url).toBe("https://network.invalid/pkg.tgz");
      return new Response("cached tarball");
    },
  };
  const sab = createRing();
  const helper = new NetHelper(sab);
  const host = new RuntimeNetHost(sab, (request) => helper.handle(request));
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { async open(name: string) { opened.push(name); return cache; } } });
    globalThis.fetch = (async () => { throw new Error("Installer should use the cached response"); }) as typeof fetch;
    const handle = host.fetch(JSON.stringify({ url: "https://network.invalid/pkg.tgz", headers: [["accept", "application/vnd.bun.install-tarball"]] }));
    await until(() => typeof host.fetchHead(handle) !== "number");
    let body: Uint8Array | number = AGAIN;
    await until(() => { body = host.read(handle, 65536); return body instanceof Uint8Array; });
    if (typeof body === "number") throw new Error("Expected cached body");
    expect(decode(body)).toBe("cached tarball");
    expect(opened).toEqual(["bun-wasm-install-v1"]);
  } finally {
    helper.dispose();
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
