import { normalizeOptions } from "./policy.js";
import { createRelayHandler } from "./server.js";
import type { RelayServerOptions } from "./protocol.js";

/** Fixed-origin Worker adapter. Public mode needs a separate, proven egress connector. */
export function createWorkerRelayHandler(options: RelayServerOptions) {
  const policy = normalizeOptions(options);
  if (policy.destinations.mode === "public-https")
    throw new TypeError("Worker public HTTPS mode has no connection-validated egress connector");
  return createRelayHandler(policy, {
    async fetch(url, init) {
      const response = await globalThis.fetch(url.href, { ...init, redirect: "manual" });
      // Reading the Fetch body yields decoded bytes. Shared code removes wire encoding headers.
      return response;
    },
  });
}
