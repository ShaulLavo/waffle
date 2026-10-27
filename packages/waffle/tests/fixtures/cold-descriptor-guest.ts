import { Wasi } from "../../core/wasi";
import { FilesystemClient, type FilesystemConnection } from "../../fs";
import {
  createFilesystemDescriptorCodec,
  type FilesystemDescriptorToken,
} from "../../proc/filesystem-codec";
import { guestFunction, guestModule } from "./publication-wasm";

const module = guestModule("wasi_snapshot_preview1", [
  { name: "fd_pread", parameters: ["i32", "i32", "i32", "i64", "i32"] },
]);

self.onmessage = ({
  data,
}: MessageEvent<{
  connection: FilesystemConnection;
  token: FilesystemDescriptorToken;
  reads: readonly { offset: number; length: number }[];
}>) => {
  const client = new FilesystemClient(data.connection);
  const memory = new WebAssembly.Memory({ initial: 4 });
  Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: client,
    preopens: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  try {
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(instance);
    const pread = guestFunction(instance, "fd_pread");
    const description = createFilesystemDescriptorCodec(client).import(data.token, 2);
    const fd = wasi.descriptors.add(description, {
      rightsBase: 0x1fffffffn,
      rightsInheriting: 0n,
    });
    const results = data.reads.map(({ offset, length }) => {
      const view = new DataView(memory.buffer);
      view.setUint32(0, 2048, true);
      view.setUint32(4, length, true);
      new Uint8Array(memory.buffer, 2048, length).fill(201);
      const error = pread(fd, 0, 1, BigInt(offset), 1024);
      const count = view.getUint32(1024, true);
      return { error, count, bytes: Array.from(new Uint8Array(memory.buffer, 2048, length)) };
    });
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ failure: String(error) });
  } finally {
    wasi.descriptors.dispose();
    client.dispose();
  }
};
