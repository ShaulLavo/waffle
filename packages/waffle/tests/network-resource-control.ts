import assert from "node:assert/strict";
import { instantiate } from "../browser/net/network.buffer.js";

const form = process.argv[2],
  mode = process.argv[3];
const imports = { waffle_tcp_host: { io: () => -10 } };
const exports =
  form === "wasm"
    ? (
        await WebAssembly.instantiate(
          await Bun.file(new URL("../browser/net/network.wasm", import.meta.url)).arrayBuffer(),
          imports,
        )
      ).instance.exports
    : instantiate(imports);
const memory = exports.memory;
if (
  typeof memory !== "object" ||
  memory === null ||
  !("buffer" in memory) ||
  !(memory.buffer instanceof ArrayBuffer) ||
  !("grow" in memory) ||
  typeof memory.grow !== "function"
)
  throw Error("Missing memory");
function call(name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw Error(`Missing ${name}`);
  const value: unknown = fn(...args);
  if (typeof value !== "number") throw Error("Invalid result");
  return value;
}
function retainedPeers(): number {
  let admitted = 0;
  for (let attempt = 0; attempt < 17000; attempt++) {
    const id = call("net_connect", 4, 12345);
    if (id === -17) continue;
    assert.ok(id > 0);
    admitted++;
    call("net_close", id);
  }
  return admitted;
}

try {
  call("tcp_buffer");
  const before = memory.buffer.byteLength;
  if (mode === "envelope") {
    memory.grow(16320 - before / 65536);
    const size = memory.buffer.byteLength;
    const id = call("net_pair"),
      peer = call("net_peer", id);
    assert.equal(call("net_write", id, 1), -17);
    assert.equal(memory.buffer.byteLength, size);
    assert.equal(call("net_take", peer, 1), 0);
    assert.equal(call("net_writable", id), 1);
    call("net_close", id);
    call("net_close", peer);
    assert.equal(call("net_usage", 0), 0);
  } else {
    call("net_listen", 4, 12345);
    const admitted = retainedPeers();
    assert.equal(admitted, 256);
    assert.equal(memory.buffer.byteLength, before);
    assert.equal(call("net_usage", 0), 512);
    call("net_close", 2);
    assert.ok(call("net_connect", 4, 12345) > 0);
    assert.equal(memory.buffer.byteLength, before);
  }
  console.log(JSON.stringify({ form, mode, result: "pass" }));
} finally {
  call("tcp_dispose");
}
