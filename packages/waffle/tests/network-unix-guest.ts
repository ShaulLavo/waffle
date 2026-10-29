/// <reference lib="webworker" />
// A guest NetHost on its own thread: path calls block on real reply cells and poll sleeps on the ring.
import { NetHost } from "../browser/net/host.js";
import type { NetRequest } from "../browser/net/protocol.js";

declare const self: DedicatedWorkerGlobalScope;
export type GuestCall = {
  kind: "call";
  id: number;
  method: keyof NetHost & string;
  args: unknown[];
};
export type GuestMessage =
  | { kind: "net"; request: NetRequest }
  | { kind: "return"; id: number; value: unknown; ms: number }
  | { kind: "throw"; id: number; message: string };

let host: NetHost | undefined;
self.onmessage = ({
  data,
}: MessageEvent<{ kind: "start"; ring: SharedArrayBuffer } | GuestCall>) => {
  if (data.kind === "start") {
    host = new NetHost(
      data.ring,
      (request, transfer) =>
        self.postMessage({ kind: "net", request } satisfies GuestMessage, transfer ?? []),
      undefined,
      { shared: true },
    );
    return;
  }
  const started = performance.now();
  try {
    const method = Reflect.get(host!, data.method) as (...args: unknown[]) => unknown;
    const value = method.apply(host, data.args);
    const ms = performance.now() - started;
    self.postMessage({ kind: "return", id: data.id, value, ms } satisfies GuestMessage);
  } catch (error) {
    self.postMessage({ kind: "throw", id: data.id, message: String(error) } satisfies GuestMessage);
  }
};
