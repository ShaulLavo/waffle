import { DescriptorTable } from "../../core/descriptors";
import { FilesystemClient, type FilesystemConnection } from "../../fs";
import {
  createFilesystemDescriptorCodec,
  type FilesystemDescriptorToken,
} from "../../proc/filesystem-codec";
import { atomicHost } from "./wasi-atomic-host";

export interface OffsetRequest {
  connection: FilesystemConnection;
  token: FilesystemDescriptorToken;
  gate: SharedArrayBuffer;
  role: "holder" | "contender";
  operation: "write" | "read" | "append" | "seek";
}
export type OffsetEvent =
  | { kind: "holding" }
  | { kind: "parked"; attempts: number; waits: number }
  | { kind: "done"; errno: number; offset: number; byte: number; attempts: number; waits: number }
  | { kind: "error"; message: string; attempts: number; waits: number };

function observeLock(buffer: SharedArrayBuffer) {
  const compareExchange = Atomics.compareExchange;
  const wait = Atomics.wait;
  const counts = { attempts: 0, waits: 0 };
  function compare(
    array: Int32Array,
    index: number,
    expected: number,
    replacement: number,
  ): number {
    if (array.buffer !== buffer || index !== 0 || expected !== 0)
      return compareExchange(array, index, expected, replacement);
    counts.attempts++;
    if (counts.attempts - counts.waits > 64)
      throw new Error("offset contention exceeded 64 CAS attempts");
    return compareExchange(array, index, expected, replacement);
  }
  function park(array: Int32Array, index: number, expected: number, timeout?: number) {
    if (array.buffer !== buffer || index !== 0) return wait(array, index, expected, timeout);
    if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0)
      throw new Error("offset contention must use a finite positive wait");
    counts.waits++;
    if (counts.waits === 3) self.postMessage({ kind: "parked", ...counts });
    return wait(array, index, expected, counts.waits < 3 ? 0 : timeout);
  }
  Atomics.compareExchange = compare as typeof Atomics.compareExchange;
  Atomics.wait = park as typeof Atomics.wait;
  return counts;
}

const encoder = new TextEncoder();
const namespace = Array.from(encoder.encode("wasi_snapshot_preview1"));
const seekName = Array.from(encoder.encode("fd_seek"));
const seekModule = new WebAssembly.Module(
  Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      [1, 9, 1, 0x60, 4, 0x7f, 0x7e, 0x7f, 0x7f, 1, 0x7f],
      [2, namespace.length + seekName.length + 5, 1, namespace.length],
      namespace,
      [seekName.length],
      seekName,
      [0, 0],
    ),
  ),
);

function runOperation(host: ReturnType<typeof atomicHost>, operation: OffsetRequest["operation"]) {
  if (operation === "read") return host.calls.fd_read!(8, 0, 1, 1024);
  if (operation !== "seek") return host.calls.fd_write!(8, 0, 1, 1024);
  const seek = host.wasi.imports(seekModule).wasi_snapshot_preview1?.fd_seek;
  if (typeof seek !== "function") throw new Error("expected fd_seek import");
  return seek(8, 2n, 1, 1040);
}

self.onmessage = ({ data }: MessageEvent<OffsetRequest>) => {
  const client = new FilesystemClient(data.connection);
  const table = new DescriptorTable();
  const description = createFilesystemDescriptorCodec(client).import(data.token, 8);
  const fd = table.add(description, { rightsBase: 0x1fffffffn, rightsInheriting: 0n });
  const file = description.resource;
  if (file.kind !== "file" || !data.token.offset) throw new Error("expected shared file");
  const host = atomicHost(client, {});
  host.wasi.descriptors.inherit(8, table.get(fd)!);
  const gate = new Int32Array(data.gate);
  const write = client.write.bind(client);
  if (data.role === "holder")
    client.write = (...args) => {
      self.postMessage({ kind: "holding" });
      while (!Atomics.load(gate, 0)) Atomics.wait(gate, 0, 0);
      return write(...args);
    };
  const counts =
    data.role === "contender" ? observeLock(data.token.offset) : { attempts: 0, waits: 0 };
  host.iovecs([new Uint8Array([data.role === "holder" ? 72 : 80])]);
  try {
    const errno = runOperation(host, data.operation);
    self.postMessage({
      kind: "done",
      errno,
      offset: file.offset,
      byte: new Uint8Array(host.memory.buffer)[2048],
      ...counts,
    });
  } catch (error) {
    self.postMessage({ kind: "error", message: String(error), ...counts });
  } finally {
    self.close();
  }
};
