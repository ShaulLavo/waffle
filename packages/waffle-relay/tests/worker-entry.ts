import { createWorkerRelayHandler } from "../src/worker.js";

const relay = createWorkerRelayHandler({
  credential: "owned-worker-fixture-token-only",
  allowedOrigins: ["https://owned-page.example.test"],
  destinations: { mode: "fixed-origins", origins: ["https://owned-target.example.test"] },
});
export default { fetch: relay.fetch };
