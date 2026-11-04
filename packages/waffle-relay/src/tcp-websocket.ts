import { MessageTransport } from "./tcp-message-transport.js";
import { TcpFlow } from "./tcp-flow.js";
import { clientFlow } from "./tcp-client-flow.js";
import {
  RelayConnectError,
  parseReply,
  connectError,
  type TcpStream,
  type TcpTarget,
} from "./tcp-protocol.js";

export interface WebSocketEvents {
  open(): void;
  message(data: unknown): void;
  close(code: number): void;
  error(): void;
}
/** Trusted host adapter, not a guest capability. */
export interface ClientWebSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void | Promise<void>;
  close(code: number): void;
  listen(events: WebSocketEvents): () => void;
  terminate?(): void;
}
function browserWebSocket(url: string): ClientWebSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    listen(events) {
      const message = (event: MessageEvent<unknown>) => events.message(event.data);
      const close = (event: CloseEvent) => events.close(event.code);
      ws.addEventListener("open", events.open);
      ws.addEventListener("message", message);
      ws.addEventListener("close", close);
      ws.addEventListener("error", events.error);
      return () => {
        ws.removeEventListener("open", events.open);
        ws.removeEventListener("message", message);
        ws.removeEventListener("close", close);
        ws.removeEventListener("error", events.error);
      };
    },
  };
}
export function openWebSocket(options: {
  endpoint: string;
  factory?: (url: string) => ClientWebSocket;
  destination: TcpTarget;
  token: string;
  signal: AbortSignal;
  windowBytes: number;
}): { opened: Promise<TcpStream>; closed: Promise<void> } {
  const opened = Promise.withResolvers<TcpStream>();
  const complete = Promise.withResolvers<void>();
  const ws = (options.factory ?? browserWebSocket)(options.endpoint);
  let flow: TcpFlow | undefined;
  const abort = () => {
    if (flow) void flow.reset(options.signal.reason, 1);
    else {
      opened.reject(options.signal.reason);
      void transport.reset(1).then(complete.resolve, complete.reject);
    }
  };
  const transport = new MessageTransport(ws, (text) => {
    const reply = parseReply(text);
    if (!reply.ok) {
      opened.reject(connectError(reply.code));
      void transport.reset(1).then(complete.resolve, complete.reject);
      return;
    }
    flow = new TcpFlow(options.windowBytes, reply.window, transport);
    transport.attach(flow);
    const client = clientFlow(flow, reply.remote, options.signal);
    void client.closed.then(complete.resolve, complete.reject);
    opened.resolve(client.stream);
  });
  transport.setFault(() => {
    const error = new RelayConnectError(flow ? "ECONNRESET" : "ENETUNREACH");
    opened.reject(error);
    if (flow) void flow.reset(error, 1);
    else void transport.reset(1).then(complete.resolve, complete.reject);
  });
  transport.start(() => {
    if (options.signal.aborted) return;
    const text = JSON.stringify({
      v: 1,
      token: options.token,
      ...options.destination,
      window: options.windowBytes,
    });
    if (new TextEncoder().encode(text).length > 8192) {
      opened.reject(new RelayConnectError("EACCES"));
      void transport.reset(1).then(complete.resolve, complete.reject);
      return;
    }
    void Promise.resolve(ws.send(text)).catch(() => {
      opened.reject(new RelayConnectError("ENETUNREACH"));
      void transport.reset(1).then(complete.resolve, complete.reject);
    });
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  void complete.promise
    .finally(() => options.signal.removeEventListener("abort", abort))
    .catch(() => {});
  return { opened: opened.promise, closed: complete.promise };
}
