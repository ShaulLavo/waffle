import { connect, type Socket } from "node:net";
import type { RuntimeNetwork } from "../index.js";
import { NetHost } from "../browser/net/host.js";
import { AGAIN } from "../browser/net/protocol.js";
import { createRing } from "../browser/net/ring.js";
import type { PreviewRouter } from "../browser/preview.js";

interface Peer {
  socket: Socket;
  chunks: Uint8Array[];
  ended: boolean;
  readEnded: boolean;
  writable: boolean;
}

/** Test-only byte bridge to one known native server. No HTTP or Vite behavior is adapted. */
export function previewNetworkFixture(
  network: RuntimeNetwork,
  routers: readonly PreviewRouter[],
  nativePort: number,
  virtualPort: number,
) {
  const ring = createRing();
  const events: string[] = [];
  const errors: string[] = [];
  const peers = new Map<number, Peer>();
  const helper = network.createHelper({
    ring,
    fetch: async () => {
      throw Error("External fetch forbidden");
    },
    hooks: {
      listening(port) {
        events.push(`listening ${port}`);
        for (const router of routers) router.register(port, helper);
      },
      stopped(port) {
        events.push(`stopped ${port}`);
        for (const router of routers) router.unregister(port, helper);
      },
    },
  });
  const host = new NetHost(ring, helper.handle, undefined, { shared: true });
  let listener = 0;
  let disposed = false;

  function fail(error: unknown): void {
    errors.push(String(error));
  }

  function flush(handle: number, peer: Peer): void {
    while (peer.chunks.length) {
      const bytes = peer.chunks[0]!;
      const count = host.write(handle, bytes);
      if (count === AGAIN) return;
      if (count <= 0) {
        peer.socket.destroy();
        return;
      }
      if (count < bytes.length) peer.chunks[0] = bytes.subarray(count);
      else peer.chunks.shift();
    }
    if (peer.ended) host.shutdown(handle);
    else peer.socket.resume();
  }

  function read(handle: number, peer: Peer): void {
    while (!peer.readEnded && peer.writable) {
      const bytes = host.read(handle, 65536);
      if (bytes === AGAIN) return;
      if (typeof bytes === "number") {
        if (bytes < 0) fail(Error(`Virtual read failed: ${bytes}`));
        peer.readEnded = true;
        peer.socket.end();
        return;
      }
      peer.writable = peer.socket.write(bytes);
    }
  }

  function accept(handle: number): void {
    const socket = connect({ host: "127.0.0.1", port: nativePort });
    const peer: Peer = { socket, chunks: [], ended: false, readEnded: false, writable: true };
    peers.set(handle, peer);
    socket.on("data", (bytes) => {
      socket.pause();
      if (typeof bytes === "string") throw Error("Native socket decoded raw bytes");
      peer.chunks.push(bytes);
      flush(handle, peer);
    });
    socket.on("drain", () => {
      peer.writable = true;
      read(handle, peer);
    });
    socket.on("end", () => {
      peer.ended = true;
      flush(handle, peer);
    });
    socket.on("error", fail);
    socket.on("close", () => {
      host.close(handle);
      peers.delete(handle);
    });
  }

  function pump(): void {
    if (disposed) return;
    let handle = host.accept(listener);
    while (handle > 0) {
      accept(handle);
      handle = host.accept(listener);
    }
    for (const [id, peer] of peers) {
      flush(id, peer);
      read(id, peer);
    }
  }

  return {
    events,
    errors,
    get connections() {
      return peers.size;
    },
    listen() {
      listener = host.listen("127.0.0.1", virtualPort);
      if (listener < 1) throw Error(`Virtual listen failed: ${host.error(0)}`);
      host.onNews(pump);
    },
    stopListening() {
      host.close(listener);
    },
    async close() {
      if (disposed) return;
      disposed = true;
      const sockets = Array.from(peers.values(), (peer) => peer.socket);
      const closed = sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      );
      host.dispose();
      helper.dispose();
      await Promise.all(closed);
      peers.clear();
    },
  };
}
