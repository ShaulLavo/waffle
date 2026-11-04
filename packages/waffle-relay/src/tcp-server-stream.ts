import type { WebSocket } from "ws";
import { MessageTransport } from "./tcp-message-transport.js";
import { TcpServerConnection } from "./tcp-server-connection.js";
import type { TcpPolicy, TcpAdmissions, Resolver } from "./tcp-policy.js";
import type { TcpFlowCounters } from "./tcp-protocol.js";
export interface TcpQueueCounters extends Partial<TcpFlowCounters> {
  readonly toTargetBytes: number;
  readonly toClientBytes: number;
  readonly readAheadBytes: number;
}
export class ServerTcpStream extends TcpServerConnection {
  constructor(
    ws: WebSocket,
    policy: TcpPolicy,
    admissions: TcpAdmissions,
    release: () => void,
    resolve?: Resolver,
  ) {
    const transport = new MessageTransport({
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
        ws.on("message", message);
        ws.on("error", events.error);
        ws.once("close", close);
        return () => {
          ws.removeListener("message", message);
          ws.removeListener("error", events.error);
          ws.removeListener("close", close);
          ws.on("error", () => {});
        };
      },
    });
    super(
      transport,
      policy,
      admissions,
      release,
      () => {},
      () => ws.terminate(),
      resolve,
    );
    transport.start();
  }
}
