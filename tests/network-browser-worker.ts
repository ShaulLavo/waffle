/// <reference lib="webworker" />
import { NetHost } from "../browser/net/host.js";
import { AGAIN, type NetRequest } from "../browser/net/protocol.js";

declare const self: DedicatedWorkerGlobalScope;
export type NetworkCommand =
  | { op: "listen"; port: number }
  | { op: "fetch"; url: string }
  | { op: "head" | "poll"; handle: number }
  | { op: "connect"; port: number }
  | { op: "accept"; handle: number }
  | { op: "read"; handle: number; cap: number }
  | { op: "write"; handle: number; bytes: Uint8Array }
  | { op: "shutdown" | "close" | "addr" | "peer"; handle: number }
  | { op: "serve"; listener: number }
  | { op: "dispose" };
export type NetworkWorkerMessage =
  | { kind: "net"; request: NetRequest }
  | { kind: "ready" }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; message: string };
type Incoming =
  | { kind: "init"; ring: SharedArrayBuffer; failPort?: number }
  | { kind: "command"; id: number; command: NetworkCommand };

function incoming(host: NetHost, handle: number): Uint8Array | number {
  let value = host.read(handle, 65536);
  while (value === AGAIN) {
    host.poll(1000);
    value = host.read(handle, 65536);
  }
  return value;
}

function serve(host: NetHost, listener: number): string {
  let handle = host.accept(listener);
  while (handle === AGAIN) {
    host.poll(1000);
    handle = host.accept(listener);
  }
  if (handle < 0) throw Error(`accept failed ${handle}`);
  let request = "";
  const decoder = new TextDecoder();
  let length = Infinity;
  while (request.length < length) {
    const chunk = incoming(host, handle);
    if (typeof chunk === "number") throw Error(`HTTP request ended early ${chunk}`);
    request += decoder.decode(chunk, { stream: true });
    const split = request.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const content = /\r\ncontent-length:\s*(\d+)/i.exec(request.slice(0, split));
    length = split + 4 + Number(content?.[1] ?? 0);
  }
  const first = request.slice(0, request.indexOf("\r\n"));
  const body = request.slice(request.indexOf("\r\n\r\n") + 4);
  const response = JSON.stringify({ first, body });
  const bytes = new TextEncoder().encode(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${response.length}\r\nConnection: close\r\n\r\n${response}`,
  );
  let at = 0;
  while (at < bytes.length) {
    const count = host.write(handle, bytes.subarray(at));
    if (count === AGAIN) {
      host.poll(1000);
      continue;
    }
    if (count < 0) throw Error(`write failed ${count}`);
    at += count;
  }
  host.shutdown(handle);
  host.close(handle);
  return request;
}

function execute(host: NetHost, command: NetworkCommand): unknown {
  switch (command.op) {
    case "fetch":
      return host.fetch(JSON.stringify({ url: command.url }));
    case "head":
      return host.fetchHead(command.handle);
    case "poll":
      return host.poll(0);
    case "listen":
      return host.listen("localhost", command.port);
    case "connect":
      return host.connect("localhost", command.port);
    case "accept":
      return host.accept(command.handle);
    case "read":
      return host.read(command.handle, command.cap);
    case "write":
      return host.write(command.handle, command.bytes);
    case "shutdown":
      return host.shutdown(command.handle);
    case "close":
      return host.close(command.handle);
    case "addr":
      return host.localAddr(command.handle);
    case "peer":
      return host.peerAddr(command.handle);
    case "serve":
      return serve(host, command.listener);
    case "dispose":
      host.dispose();
      return 0;
  }
}

let host: NetHost | undefined;
self.onmessage = (event: MessageEvent<Incoming>) => {
  const input = event.data;
  if (input.kind === "init") {
    host = new NetHost(
      input.ring,
      (request, transfer = []) => {
        self.postMessage({ kind: "net", request } satisfies NetworkWorkerMessage, { transfer });
      },
      undefined,
      { shared: true },
    );
    const failedPort = input.failPort ?? 0;
    if (failedPort > 0) {
      host.listen("localhost", failedPort);
      throw Error("Injected startup failure after network allocation");
    }
    self.postMessage({ kind: "ready" } satisfies NetworkWorkerMessage);
    return;
  }
  try {
    if (!host) throw Error("Host not initialized");
    const value = execute(host, input.command);
    self.postMessage({ kind: "result", id: input.id, value } satisfies NetworkWorkerMessage);
  } catch (error) {
    self.postMessage({
      kind: "error",
      id: input.id,
      message: String(error),
    } satisfies NetworkWorkerMessage);
  }
};
