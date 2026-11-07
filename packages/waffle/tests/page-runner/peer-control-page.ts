import { startPage } from "./page-main.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { record } from "./protocol.js";

declare const PEER_CONTROL: string;
const mode = PEER_CONTROL;
const post = globalThis.fetch.bind(globalThis);
let held = false;
if (["peer-ack-held", "peer-ack-lost", "peer-inactive-heartbeat"].includes(mode)) {
  globalThis.fetch = async (input, init) => {
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const peer = window.__suiteConfiguration.role === "peer";
    if (mode === "peer-inactive-heartbeat" && peer && record(body) && body.kind === "heartbeat")
      return new Response();
    const response = await post(input, init);
    if (!record(body) || body.kind !== "transition-ready") return response;
    if (mode === "peer-ack-held" && !held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (mode === "peer-ack-lost") throw new Error("CONTROL_ACK_LOST");
    return response;
  };
}
startPage({
  list: async () => ["peer"],
  run: {
    kind: "host",
    peer: async () => {},
    teardown: async () => ({ coordinator: true }),
  },
  finish: cleanupStorage,
});
