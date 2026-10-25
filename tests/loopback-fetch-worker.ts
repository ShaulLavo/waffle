/// <reference lib="webworker" />
import { NetHost } from "../browser/net/host.js";
import { AGAIN, type NetRequest } from "../browser/net/protocol.js";

declare const self: DedicatedWorkerGlobalScope;
export type FetchCommand =
  | {
      op: "fetch";
      url: string;
      redirect?: RequestRedirect;
      method?: string;
      headers?: [string, string][];
      body?: Uint8Array;
    }
  | { op: "head" | "error" | "close"; handle: number }
  | { op: "read"; handle: number; cap: number }
  | { op: "listen"; port: number }
  | { op: "respond"; listener: number; bytes: Uint8Array };
export type FetchMessage =
  | { kind: "net"; request: NetRequest }
  | { kind: "ready" }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; message: string };
type Incoming = { ring: SharedArrayBuffer } | { id: number; command: FetchCommand };

function read(host: NetHost, handle: number): Uint8Array | number {
  let value = host.read(handle, 65536);
  while (value === AGAIN) {
    host.poll(1000);
    value = host.read(handle, 65536);
  }
  return value;
}

function respond(host: NetHost, listener: number, bytes: Uint8Array) {
  let handle = host.accept(listener);
  while (handle === AGAIN) {
    host.poll(1000);
    handle = host.accept(listener);
  }
  if (handle < 0) throw Error(`accept: ${handle}`);
  let request = "";
  let length = Infinity;
  while (request.length < length) {
    const chunk = read(host, handle);
    if (typeof chunk === "number") throw Error(`request ended: ${chunk}`);
    request += new TextDecoder().decode(chunk);
    const split = request.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const content = /\r\ncontent-length:\s*(\d+)/i.exec(request.slice(0, split));
    length = split + 4 + Number(content?.[1] ?? 0);
  }
  let written = 0;
  while (written < bytes.length) {
    const count = host.write(handle, bytes.subarray(written));
    if (count === AGAIN) {
      host.poll(1000);
      continue;
    }
    if (count < 0) break;
    written += count;
  }
  host.shutdown(handle);
  host.close(handle);
  return { request, written };
}

function execute(host: NetHost, command: FetchCommand): unknown {
  switch (command.op) {
    case "fetch":
      return host.fetch(JSON.stringify(command), command.body ?? null);
    case "head":
      return host.fetchHead(command.handle);
    case "error":
      return host.error(command.handle);
    case "close":
      return host.close(command.handle);
    case "read":
      return host.read(command.handle, command.cap);
    case "listen":
      return host.listen("localhost", command.port);
    case "respond":
      return respond(host, command.listener, command.bytes);
  }
}
let host: NetHost;
self.onmessage = ({ data }: MessageEvent<Incoming>) => {
  if ("ring" in data) {
    host = new NetHost(
      data.ring,
      (request, transfer = []) =>
        self.postMessage({ kind: "net", request } satisfies FetchMessage, { transfer }),
      undefined,
      { shared: true },
    );
    self.postMessage({ kind: "ready" } satisfies FetchMessage);
    return;
  }
  try {
    self.postMessage({
      kind: "result",
      id: data.id,
      value: execute(host, data.command),
    } satisfies FetchMessage);
  } catch (error) {
    self.postMessage({ kind: "error", id: data.id, message: String(error) } satisfies FetchMessage);
  }
};
