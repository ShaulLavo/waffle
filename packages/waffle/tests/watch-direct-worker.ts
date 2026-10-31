import { FilesystemClient } from "../fs/client.js";
import type { FilesystemConnection } from "../fs/protocol.js";

self.onmessage = async ({
  data,
}: MessageEvent<{
  connection: FilesystemConnection;
  control: SharedArrayBuffer;
  mode?: "watch";
}>) => {
  const client = new FilesystemClient(data.connection);
  const control = new Int32Array(data.control);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    if (data.mode === "watch") {
      const watch = await client.watch(root, { recursive: true });
      self.postMessage("ready");
      self.postMessage(await watch.next());
      await watch.close();
      return;
    }
    const path = await client.asyncCall("resolve", [root, "one"]);
    client.retain(path.node);
    client.shared.onContention = () => {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
    };
    self.postMessage("ready");
    Atomics.wait(control, 0, 0);
    const written = client.write(path.node, [new Uint8Array([91])], 0);
    self.postMessage({ written, sequence: client.shared.watch.sequence });
  } finally {
    client.dispose();
  }
};
