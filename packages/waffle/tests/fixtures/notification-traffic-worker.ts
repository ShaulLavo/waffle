import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { attachPipeEndpoint, type PipeEndpointHandle } from "../../proc/pipes.js";
import { RingReader, RingWriter } from "../../browser/net/ring.js";
import { Kind } from "../../browser/net/protocol.js";

export interface TrafficRequest {
  filesystem: FilesystemConnection;
  pipe: { reader: PipeEndpointHandle; writer: PipeEndpointHandle };
  ring: SharedArrayBuffer;
  /** Stop, completed rounds, start gate. */
  progress: Int32Array;
  mode: "queued" | "empty" | "filesystem";
}

async function traffic(request: TrafficRequest): Promise<void> {
  const fs = new FilesystemClient(request.filesystem);
  const reader = attachPipeEndpoint(request.pipe.reader);
  const writer = attachPipeEndpoint(request.pipe.writer);
  const network = new RingWriter(request.ring);
  const drain = new RingReader(request.ring);
  const byte = new Uint8Array([81]);
  const received = new Uint8Array(1);
  let rounds = 0;
  try {
    const root = await fs.asyncCall("preopen", ["/"]);
    const path = await fs.asyncCall("resolve", [root, "traffic"]);
    fs.retain(path.node);
    globalThis.postMessage({ type: "ready" });
    if (Atomics.wait(request.progress, 2, 0, 10_000) === "timed-out")
      throw new Error("traffic entry handshake missing");
    const batch = async () => {
      const pending: Promise<void>[] = [];
      const count = request.mode === "queued" ? 64 : 1;
      for (let index = 0; index < count; index++) {
        if (fs.write(path.node, [byte], 0) !== 1) throw new Error("filesystem write failed");
        if (request.mode === "filesystem") continue;
        transfer();
        pending.push(network.write(1, Kind.Data, byte));
      }
      await Promise.all(pending);
      drain.drain();
    };
    const deadline = performance.now() + 20_000;
    while (!Atomics.load(request.progress, 0)) {
      if (performance.now() >= deadline) throw new Error("traffic stop handshake missing");
      await batch();
      Atomics.store(request.progress, 1, ++rounds);
      Atomics.notify(request.progress, 1);
      if (rounds === 1) globalThis.postMessage({ type: "running" });
    }
    fs.release(path.node);
  } finally {
    network.dispose();
    reader.close();
    writer.close();
    fs.dispose();
  }
  globalThis.postMessage({ type: "stopped", rounds });

  function transfer(): void {
    if (writer.tryWrite([byte]) !== 1 || reader.tryRead([received]) !== 1)
      throw new Error("pipe traffic failed");
  }
}

globalThis.onmessage = ({ data }: MessageEvent<TrafficRequest>) => {
  void traffic(data).catch((error: unknown) =>
    globalThis.postMessage({ type: "error", message: String(error) }),
  );
};
