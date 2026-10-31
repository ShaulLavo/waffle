import { expect, test } from "bun:test";
import { loadNetworkModule } from "../browser/net/module.js";

test("standalone module instances isolate state, copy bytes and revoke stale tokens", async () => {
  const compiled = await loadNetworkModule();
  const a = compiled.create();
  const b = compiled.create();
  try {
    expect(a.call("net_listen", 60, 0)).toBe(49152);
    expect(b.call("net_connect", 4, 49152)).toBe(-5);
    const client = a.call("net_connect", 4, 49152);
    const server = a.call("net_peer", client);
    expect(client).toBeGreaterThan(0);
    expect(server).toBeGreaterThan(client);
    expect(a.write("net_write", client, new Uint8Array([1, 2, 3]))).toBe(3);
    expect(a.read("net_take", server, 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(a.call("net_shutdown", client)).toBe(0);
    expect(a.call("net_ended", server)).toBe(1);
    expect(a.call("net_close", client)).toBe(0);
    expect(a.write("net_write", client, new Uint8Array([4]))).toBe(-2);
  } finally {
    a.dispose();
    b.dispose();
  }
  expect(() => a.call("net_listen", 4, 0)).toThrow(/disposed/);
});

test("browser default host denies native OS operations even through standalone exports", async () => {
  const owner = (await loadNetworkModule()).create();
  try {
    expect(owner.call("tcp_listen_default", 0)).toBe(-10);
    expect(owner.call("net_listen", 4, 0)).toBe(49152);
    expect(owner.call("net_connect", 0, 49152)).toBe(-10);
  } finally {
    owner.dispose();
  }
});

test("network ABI rejects oversized buffers and invalid tokens without copying unrelated memory", async () => {
  const owner = (await loadNetworkModule()).create();
  try {
    expect(() => owner.write("net_write", 1, new Uint8Array(owner.capacity + 1))).toThrow(
      RangeError,
    );
    expect(owner.call("net_write", 0xffff, 1)).toBe(-2);
    expect(owner.call("net_take", 0xffff, 1)).toBe(-2);
    expect(owner.call("net_consumed", 0xffff, 1)).toBe(0);
  } finally {
    owner.dispose();
  }
});

test("module imports only the explicit OS adapter, with no WASI or shared memory", async () => {
  const bytes = await Bun.file(
    new URL("../browser/net/network.wasm", import.meta.url),
  ).arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([
    { module: "waffle_tcp_host", name: "io", kind: "function" },
  ]);
});
