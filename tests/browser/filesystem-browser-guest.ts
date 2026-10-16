import { FilesystemClient, revokeFilesystem } from "@bun-wasm/runtime/fs";
self.onmessage = ({ data }) => {
  const fs = new FilesystemClient(data.connection);
  try {
    if (data.action === "writers") {
      // Native-engine guest polyfills replace MessageChannel before Bun.spawn forks a client.
      const native = globalThis.MessageChannel;
      try {
        Object.assign(globalThis, { MessageChannel: class { constructor() { throw new Error("guest MessageChannel used by host transport"); } } });
        const connection = fs.fork();
        revokeFilesystem(connection); fs.sweep(); connection.port.close();
      } finally { globalThis.MessageChannel = native; }
      const prefix = crypto.randomUUID();
      for (let i = 0; i < 20; i++) fs.writeFile(`/${prefix}-${i}`, new Uint8Array([i]));
      self.postMessage({ ok: true });
      return;
    }
    const root = fs.preopen("/");
    const from = fs.resolve(root, "shared");
    const to = fs.resolve(root, "renamed");
    if (typeof from === "number" || from.node === undefined || typeof to === "number") throw new Error("fixture paths");
    fs.retain(from.node);
    const bytes = new Uint8Array(6);
    fs.read(from.node, [bytes], 0);
    const original = new TextDecoder().decode(bytes);
    if (fs.rename(from, to)) throw new Error("rename failed");
    const renamed = fs.resolve(root, "renamed");
    if (typeof renamed === "number" || fs.removePath(renamed, false)) throw new Error("unlink failed");
    fs.writeFile("/shared", "replacement");
    fs.write(from.node, [new TextEncoder().encode("after!")], 0);
    fs.read(from.node, [bytes], 0);
    fs.release(from.node);
    self.postMessage({ original, detached: new TextDecoder().decode(bytes) });
  } catch (error) { self.postMessage({ error: String(error) }); }
  // Do not dispose here: the page revokes after receiving the completed writes, just as on kill.
};
