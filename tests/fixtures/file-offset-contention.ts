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
}
export type OffsetEvent =
  | { kind: "holding" }
  | { kind: "parked"; attempts: number; waits: number }
  | { kind: "done"; errno: number; offset: number; attempts: number; waits: number }
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
    if (counts.attempts > 64) throw new Error("offset contention exceeded 64 CAS attempts");
    return compareExchange(array, index, expected, replacement);
  }
  function park(array: Int32Array, index: number, expected: number, timeout?: number) {
    if (array.buffer !== buffer || index !== 0) return wait(array, index, expected, timeout);
    counts.waits++;
    if (counts.waits === 3) self.postMessage({ kind: "parked", ...counts });
    return wait(array, index, expected, counts.waits < 3 ? 0 : timeout);
  }
  // Only this worker's lock operations are observed. All calls delegate to the native atomics.
  Atomics.compareExchange = compare as typeof Atomics.compareExchange;
  Atomics.wait = park as typeof Atomics.wait;
  return counts;
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
  if (data.role === "holder") client.write = (...args) => {
    self.postMessage({ kind: "holding" });
    while (!Atomics.load(gate, 0)) Atomics.wait(gate, 0, 0);
    return write(...args);
  };
  const counts = data.role === "contender" ? observeLock(data.token.offset) : { attempts: 0, waits: 0 };
  host.iovecs([new Uint8Array([data.role === "holder" ? 72 : 80])]);
  try {
    const errno = host.calls.fd_write!(8, 0, 1, 1024);
    self.postMessage({ kind: "done", errno, offset: file.offset, ...counts });
  } catch (error) {
    self.postMessage({ kind: "error", message: String(error), ...counts });
  } finally {
    self.close();
  }
};
