import { Wasi } from "../../core/wasi.js";
import {
  RIGHT_FD_FILESTAT_GET,
  RIGHT_FD_READ,
  RIGHT_FD_SEEK,
  RIGHT_FD_TELL,
} from "../../core/rights.js";
import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { guestModule } from "./publication-wasm.js";

const wasiMod = guestModule("wasi_snapshot_preview1", [
  {
    name: "path_open",
    parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
  },
  { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
]);

self.onmessage = ({ data }: MessageEvent<{ connection: FilesystemConnection }>) => {
  const client = new FilesystemClient(data.connection);
  try {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const wasi = new Wasi({
      args: ["worker"],
      env: {},
      fs: client,
      preopens: { "/": "/" },
      namespaces: { env: { memory } },
      stdout() {},
      stderr() {},
      sleep() {},
    });
    const imports = wasi.imports(wasiMod);
    const instance = new WebAssembly.Instance(wasiMod, imports);
    wasi.start(instance);
    const exports = imports.wasi_snapshot_preview1 as Record<string, (...args: any[]) => number>;
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const encoded = new TextEncoder().encode("etc/machine-id");
    bytes.set(encoded, 1024);
    const rights = RIGHT_FD_READ | RIGHT_FD_SEEK | RIGHT_FD_TELL | RIGHT_FD_FILESTAT_GET;
    const errno = exports.path_open!(3, 1, 1024, encoded.length, 0, rights, 0n, 0, 2048);
    if (errno !== 0) {
      self.postMessage({ machineId: client.machineId, errno, text: "" });
      return;
    }
    const fd = view.getUint32(2048, true);
    view.setUint32(4096, 4200, true);
    view.setUint32(4100, 64, true);
    const readErrno = exports.fd_read!(fd, 4096, 1, 4120);
    const count = view.getUint32(4120, true);
    const text = new TextDecoder().decode(bytes.subarray(4200, 4200 + count));
    self.postMessage({ machineId: client.machineId, errno: readErrno, text });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    client.dispose();
  }
};
