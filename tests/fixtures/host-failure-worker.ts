import type { RuntimeWorkerRequest } from "../../browser/worker.js";
import { NetHost } from "../../browser/net/host.js";
import { createRing } from "../../browser/net/ring.js";
import { markStarted, reviveOutcome } from "../../proc/outcome.js";

globalThis.onmessage = ({ data }: MessageEvent<RuntimeWorkerRequest>) => {
  if (!data.outcome) throw new Error("missing terminal outcome");
  markStarted(reviveOutcome(data.outcome));
  const host = new NetHost(
    createRing(),
    (req) => globalThis.postMessage({ type: "net", req }),
    undefined,
    { shared: true },
  );
  host.listen("127.0.0.1", 3137);
  globalThis.postMessage({ type: "unexpected-return" });
};
