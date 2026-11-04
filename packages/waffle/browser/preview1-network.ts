import type { Runtime } from "../runtime.js";
import type { NetConnect } from "./net/outbound.js";
import type { NetRequest } from "./net/protocol.js";
import { createRing } from "./net/ring.js";
import type { Preview1Network, Preview1SocketBinding } from "./preview1-network-types.js";
export type {
  Preview1Network,
  Preview1NetworkConnection,
  Preview1SocketBinding,
} from "./preview1-network-types.js";

export interface Preview1NetworkOptions {
  readonly sockets: readonly Preview1SocketBinding[];
  readonly connect?: NetConnect;
}

function snapshot(bindings: readonly Preview1SocketBinding[]): Preview1SocketBinding[] {
  const seen = new Set<number>();
  return bindings.map(({ fd, socket }) => {
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff || seen.has(fd))
      throw new RangeError("invalid or duplicate socket descriptor");
    seen.add(fd);
    if ("connect" in socket && "listen" in socket)
      throw new TypeError("socket binding requires either connect or listen");
    const listening = "listen" in socket;
    const { host, port } = listening ? socket.listen : socket.connect;
    if (typeof host !== "string" || !host || host.includes("\0"))
      throw new TypeError("socket target requires a hostname");
    const minimum = listening ? 0 : 1;
    if (!Number.isInteger(port) || port < minimum || port > 65535)
      throw new RangeError(`socket target requires a port in ${minimum}..65535`);
    return listening
      ? { fd, socket: { listen: { host, port } } }
      : { fd, socket: { connect: { host, port } } };
  });
}

/** Build one launch's helper on the responsive owner. Empty bindings do not activate networking. */
export async function createPreview1Network(
  runtime: Pick<Runtime, "network">,
  options: Preview1NetworkOptions,
): Promise<Preview1Network | undefined> {
  const sockets = snapshot(options.sockets);
  if (!sockets.length) return;
  const connect = options.connect;
  const network = await runtime.network();
  const ring = createRing();
  const channel = new MessageChannel();
  try {
    const helper = network.createHelper({
      ring,
      connect,
      fetch: async () => {
        throw new Error("Preview 1 fetch is unavailable");
      },
    });
    channel.port1.onmessage = ({ data }: MessageEvent<NetRequest>) => helper.handle(data);
    let disposed = false;
    return {
      connection: { ring, port: channel.port2, sockets },
      dispose() {
        if (disposed) return;
        disposed = true;
        channel.port1.close();
        channel.port2.close();
        helper.dispose();
      },
    };
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
}
