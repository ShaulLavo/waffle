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
      closed: number;
      followup?: LookupResult;
    };
interface LookupResult {
  head: string | number;
  error: string | number;
  polls: number;
  closed: number;
}
type Incoming =
  | {
      kind: "run";
      ring: SharedArrayBuffer;
      hostname: string;
      options: RuntimeNetworkLookupOptions;
      followup?: string;
    }
  | { kind: "event" };
let messageEvents = 0;
function lookup(
  host: NetHost,
  hostname: string,
  options: RuntimeNetworkLookupOptions,
): LookupResult {
  const handle = host.lookupStart(hostname, options);
  let head = host.lookupHead(handle);
  let polls = 0;
  self.postMessage({ kind: "waiting" } satisfies LookupWorkerMessage);
  while (head === AGAIN) {
    host.poll(-1);
    polls++;
    head = host.lookupHead(handle);
  }
  const result = {
    head: typeof head === "number" ? head : new TextDecoder().decode(head),
    error: host.error(handle),
    polls,
  };
  host.close(handle);
  const closed = host.lookupHead(handle);
  if (typeof closed !== "number") throw Error("Closed lookup retained head bytes");
  return { ...result, closed };
}

self.onmessage = ({ data }: MessageEvent<Incoming>) => {
  if (data.kind === "event") {
    messageEvents++;
    return;
  }
  const host = new NetHost(data.ring, (request) => {
    self.postMessage({ kind: "net", request } satisfies LookupWorkerMessage);
  });
  try {
    const result = lookup(host, data.hostname, data.options);
    const followup = data.followup ? lookup(host, data.followup, {}) : undefined;
    self.postMessage({
      kind: "result",
      ...result,
      messageEvents,
      followup,
    } satisfies LookupWorkerMessage);
  } catch (error) {
    self.postMessage({ kind: "failure", message: String(error) } satisfies LookupWorkerMessage);
  } finally {
    host.dispose();
  }
};
