import { WebSocket } from "ws";
import { canonicalOrigin } from "./tcp-destination.js";
import type { ClientWebSocket } from "./tcp-websocket.js";

/** Node/Bun do not synthesize a page Origin. Keep it explicit in trusted host code. */
export function createNodeWebSocket(origin: string): (url: string) => ClientWebSocket {
  const selected = canonicalOrigin(origin);
  return (url) => {
    const ws = new WebSocket(url, {
      origin: selected,
      perMessageDeflate: false,
      maxPayload: 65537,
      followRedirects: false,
    });
    return {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send: (data) =>
        new Promise<void>((resolve, reject) =>
          ws.send(data, (error) => (error ? reject(error) : resolve())),
        ),
      close: (code) => ws.close(code),
      terminate: () => ws.terminate(),
      listen(events) {
        const message = (data: import("ws").RawData, binary: boolean) =>
          events.message(binary ? data : data.toString());
        const close = (code: number) => events.close(code);
        ws.on("open", events.open);
        ws.on("message", message);
        ws.on("close", close);
        ws.on("error", events.error);
        return () => {
          ws.removeListener("open", events.open);
          ws.removeListener("message", message);
          ws.removeListener("close", close);
          ws.removeListener("error", events.error);
          // A late platform error after forced termination has no application owner.
          ws.on("error", () => {});
        };
      },
    };
  };
}
