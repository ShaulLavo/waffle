import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { permissionsHost } from "./permissions-guest.js";

let state: { fs: FilesystemClient; handle: number; prior: Uint8Array } | undefined;
self.onmessage = ({ data }: MessageEvent<FilesystemConnection | { inspect: true }>) => {
  if ("inspect" in data) {
    if (!state) throw new Error("worker not initialized");
    const { fs, handle, prior } = state;
    const host = permissionsHost(fs);
    try {
      const errno = host.call("file");
      self.postMessage({
        errno,
        words: host.words(),
        permissions: fs.permissions(handle),
        read: fs.read(handle, [new Uint8Array(6)], 0),
        write: fs.write(handle, [new Uint8Array([1])], 0),
        resize: fs.resize(handle, 0, true),
        prior: Array.from(prior),
      });
    } finally {
      host.wasi.descriptors.dispose();
      fs.release(handle);
      fs.dispose();
      state = undefined;
    }
    return;
  }
  const fs = new FilesystemClient(data);
  try {
    const root = fs.preopen("/");
    const path = fs.resolve(root, "file");
    if (typeof path === "number" || path.node === undefined) throw new Error("missing fixture");
    fs.retain(path.node);
    const prior = new Uint8Array(6);
    if (fs.read(path.node, [prior], 0) !== 6) throw new Error("initial read failed");
    if (fs.write(path.node, [prior], 0) !== 6) throw new Error("initial write failed");
    state = { fs, handle: path.node, prior };
    self.postMessage({ cached: path.node });
  } catch (error) {
    fs.dispose();
    throw error;
  }
};
