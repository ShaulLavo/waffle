/// <reference lib="webworker" />
import { NetHost } from "../browser/net/host.js";
import { AGAIN, type NetRequest } from "../browser/net/protocol.js";
import type { RuntimeNetworkLookupOptions } from "../index.js";

declare const self: DedicatedWorkerGlobalScope;
export type LookupWorkerMessage =
  | { kind: "net"; request: NetRequest }
  | { kind: "waiting" }
  | { kind: "failure"; message: string }
  | {
      kind: "result";
      head: string | number;
      error: string | number;
      messageEvents: number;
      polls: number;
    };
type Incoming =
  | { kind: "run"; ring: SharedArrayBuffer; hostname: string; options: RuntimeNetworkLookupOptions }
  | { kind: "event" };
let messageEvents = 0;
self.onmessage = ({ data }: MessageEvent<Incoming>) => {
  if (data.kind === "event") {
    messageEvents++;
    return;
  }
  const host = new NetHost(data.ring, (request) => {
    self.postMessage({ kind: "net", request } satisfies LookupWorkerMessage);
  });
  try {
    const handle = host.lookupStart(data.hostname, data.options);
    let head = host.lookupHead(handle);
    let polls = 0;
    self.postMessage({ kind: "waiting" } satisfies LookupWorkerMessage);
    while (head === AGAIN) {
      host.poll(-1);
      polls++;
      head = host.lookupHead(handle);
    }
    self.postMessage({
      kind: "result",
      head: typeof head === "number" ? head : new TextDecoder().decode(head),
      error: host.error(handle),
      messageEvents,
      polls,
    } satisfies LookupWorkerMessage);
  } catch (error) {
    self.postMessage({ kind: "failure", message: String(error) } satisfies LookupWorkerMessage);
  } finally {
    host.dispose();
  }
};
