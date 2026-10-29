import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { RingWriter } from "../../browser/net/ring.js";
import { Kind } from "../../browser/net/protocol.js";

export type GuestWatchWriterMessage =
  | { connection: FilesystemConnection; ring: SharedArrayBuffer; conn: number }
  | { write: number }
  | { dispose: true };

let state: { client: FilesystemClient; ring: RingWriter; conn: number; root: number } | undefined;

/** A second guest: a direct shared-memory write, then one byte to the watcher's listener. */
async function write(index: number): Promise<void> {
  const { client, ring, conn, root } = state!;
  const path = await client.asyncCall("resolve", [root, `w/d${index}`]);
  client.retain(path.node);
  try {
    const written = client.write(path.node, [new Uint8Array([index & 0xff])], 0);
    if (written !== 1) throw new Error(`direct write returned ${written}`);
    await ring.write(conn, Kind.Data, new Uint8Array([index & 0xff]));
  } finally {
    client.release(path.node);
  }
}

self.onmessage = ({ data }: MessageEvent<GuestWatchWriterMessage>) => {
  if ("connection" in data) {
    const client = new FilesystemClient(data.connection);
    void client.asyncCall("preopen", ["/"]).then((root: number) => {
      state = { client, ring: new RingWriter(data.ring), conn: data.conn, root };
      self.postMessage({ ready: true });
    });
    return;
  }
  if ("dispose" in data) {
    state?.client.dispose();
    state = undefined;
    self.postMessage({ disposed: true });
    return;
  }
  void write(data.write).then(
    () => self.postMessage({ wrote: data.write }),
    (error: unknown) => self.postMessage({ error: String(error) }),
  );
};
