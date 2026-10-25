/** @compileFixture Built and executed by node-wasi-descriptors.test.ts. */
import assert from "node:assert/strict";
import { WASI } from "node:wasi";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DescriptorTable, OpenDescription } from "../../core/descriptors.js";
import type { PipeEndpointHandle } from "../../proc/pipes.js";
import {
  nodeWasiDescriptor,
  installNodeWasiDescriptors,
  type NodeWasiGuard,
  type NodeWasiImports,
} from "../../proc/node-wasi.js";
import { createWorkerProcessTransport, WorkerProcessClient } from "../../proc/worker-client.js";
import { WorkerPipeBroker, WorkerPipeHost } from "../../proc/worker-pipes.js";

function isPipeEndpointHandle(value: unknown): value is PipeEndpointHandle {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("mode" in value) || (value.mode !== "read" && value.mode !== "write")) return false;
  if (!("buffer" in value) || !(value.buffer instanceof SharedArrayBuffer)) return false;
  if (!("wake" in value) || !(value.wake instanceof Int32Array)) return false;
  if (!("lifetime" in value) || !(value.lifetime instanceof SharedArrayBuffer)) return false;
  const numericKeys = ["capacity", "maxWriters", "maxReaders", "pid", "slot"] as const;
  return numericKeys.every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return (
      property !== undefined &&
      typeof property.value === "number" &&
      Number.isInteger(property.value)
    );
  });
}

const guest = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);
type WasiCall = (...args: (number | bigint)[]) => number;

function fixture(root: string) {
  const transport = createWorkerProcessTransport();
  const messages: Parameters<WorkerProcessClient["options"]["postMessage"]>[0][] = [];
  const broker = new WorkerPipeBroker();
  const host = new WorkerPipeHost({
    transport,
    postMessage(message) {
      messages.push(message);
      if (message.operation !== "pipe") return;
      if (!isPipeEndpointHandle(message.handle))
        throw new TypeError("invalid pipe endpoint handle");
      broker.attach(message.handle);
    },
  });
  const descriptors = new DescriptorTable();
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: host.codec(),
    createPipe: () => host.createPipe(),
    postMessage: (message) => messages.push(message),
  });
  client.installBindings();
  const wasi = new WASI({
    version: "preview1",
    args: [],
    env: {},
    preopens: { "/": root },
    returnOnExit: true,
  });
  const imports = wasi.getImportObject() as NodeWasiImports;
  const state: { memory?: WebAssembly.Memory } = {};
  const guard: NodeWasiGuard =
    (fn) =>
    (...args) =>
      fn(...args);
  installNodeWasiDescriptors(
    imports,
    () => {
      if (!(state.memory instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
      return state.memory;
    },
    descriptors,
    1,
    client,
    () => false,
    guard,
  );
  const instance = new WebAssembly.Instance(guest, imports);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
  state.memory = memory;
  wasi.start(instance);
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const call = (name: string, ...args: (number | bigint)[]) => {
    const fn = imports.wasi_snapshot_preview1[name];
    if (!fn) throw new Error(`Missing WASI import ${name}`);
    return (fn as WasiCall)(...args);
  };
  const open = () => {
    const path = new TextEncoder().encode("data");
    bytes().set(path, 256);
    const rights = 2n | 4n | 32n | 64n | (1n << 21n) | (1n << 27n);
    assert.equal(call("path_open", 3, 0, 256, path.length, 0, rights, 0n, 0, 128), 0);
    return view().getUint32(128, true);
  };
  const poll = (subscriptions: readonly { type: number; fd: number; userdata?: bigint }[]) => {
    bytes().fill(0, 1024, 3076);
    subscriptions.forEach((item, index) => {
      const ptr = 1024 + index * 48;
      view().setBigUint64(ptr, item.userdata ?? BigInt(index), true);
      view().setUint8(ptr + 8, item.type);
      view().setUint32(ptr + 16, item.fd, true);
    });
    const status = call("poll_oneoff", 1024, 2048, subscriptions.length, 3072);
    const events = status
      ? []
      : Array.from({ length: view().getUint32(3072, true) }, (_, index) => {
          const ptr = 2048 + index * 32;
          return { userdata: view().getBigUint64(ptr, true), type: view().getUint8(ptr + 10) };
        });
    return { status, events };
  };
  const createPipe = client.options.createPipe;
  if (!createPipe) throw new Error("Missing pipe factory");
  return { broker, client, descriptors, view, bytes, call, open, poll, createPipe };
}

const root = mkdtempSync(join(process.env.WAFFLE_SCRATCH_ROOT ?? tmpdir(), "waffle-node-wasi-"));
writeFileSync(join(root, "data"), "file-data");
const f = fixture(root);
try {
  const probe = f.open();
  const nativeFd = nodeWasiDescriptor(f.descriptors.get(probe));
  assert.notEqual(nativeFd, undefined);
  assert.equal(f.call("fd_close", probe), 0);
  const [reader, writer] = f.createPipe();
  f.descriptors.openAt(nativeFd!, reader, 2n | (1n << 27n), 0n);
  const opened = f.open();
  assert.notEqual(opened, nativeFd);
  assert.equal(nodeWasiDescriptor(f.descriptors.get(opened)), nativeFd);
  assert.equal(f.call("fd_seek", opened, 0n, 0, 160), 0);
  f.view().setUint32(192, 512, true);
  f.view().setUint32(196, 32, true);
  assert.equal(f.call("fd_read", opened, 192, 1, 200), 0);
  assert.equal(
    new TextDecoder().decode(f.bytes().subarray(512, 512 + f.view().getUint32(200, true))),
    "file-data",
  );
  assert.equal(f.call("fd_fdstat_get", nativeFd!, 256), 0);
  assert.equal(f.view().getUint8(256), 6);
  assert.equal(f.call("fd_filestat_get", opened, 256), 0);
  assert.equal(f.view().getUint8(272), 4);
  const duplicate = f.descriptors.dup(opened);
  const duplicateNativeFd = nodeWasiDescriptor(f.descriptors.get(duplicate));
  assert.equal(f.call("fd_fdstat_set_rights", duplicate, 2n, 0n), 0);
  assert.equal(f.call("fd_renumber", opened, duplicate), 0);
  assert.equal(nodeWasiDescriptor(f.descriptors.get(duplicate)), duplicateNativeFd);
  assert.equal(f.call("fd_close", duplicate), 0);
  assert.equal(f.call("fd_close", duplicate), 8);
  assert.equal(f.descriptors.get(nativeFd!)?.resource, reader);
  const native = { kind: "file" as const, handle: 1, nodeWasiFd: 1, offset: 0, append: false };
  f.descriptors.inherit(7, {
    description: new OpenDescription(native),
    resource: native,
    rightsBase: (1n << 6n) | (1n << 27n),
    rightsInheriting: 0n,
  });
  const [pipeReader, pipeWriter] = f.createPipe();
  f.descriptors.openAt(8, pipeReader, 2n | (1n << 27n), 0n);
  assert.equal(pipeWriter.tryWrite?.([new Uint8Array([7])]), 1);
  const nativeOnly = f.poll([{ type: 2, fd: 7 }]);
  assert.equal(nativeOnly.status, 0);
  assert.equal(f.view().getUint32(1040, true), 7);
  const mixed = f.poll([
    { type: 2, fd: 7, userdata: 7n },
    { type: 1, fd: 8, userdata: 8n },
  ]);
  assert.equal(mixed.status, 0);
  assert.deepEqual(
    mixed.events.map((event) => event.userdata),
    [7n, 8n],
  );
  assert.deepEqual(
    mixed.events.map((event) => event.type),
    [2, 1],
  );
  assert.equal(f.view().getUint32(1040, true), 7);
  assert.equal(f.view().getUint32(1088, true), 8);
  pipeWriter.close?.();
  f.descriptors.close(7);
  pipeReader.close?.();
  writer.close?.();
  console.log("Node WASI descriptor routing and mixed poll passed");
} finally {
  f.descriptors.dispose();
  f.broker.dispose();
  rmSync(root, { force: true, recursive: true });
}
