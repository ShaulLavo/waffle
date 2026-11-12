export const networkId = "network-browser: complete";
export const relayId = "network-relay-browser: complete";
export const networkLabels = [
  "runtime activation and loopback traffic construct zero WebAssembly.Memory/Instance and request no network.wasm",
  "network-only phase completes with zero process activation; final Preview 1 phase uses one real broker and the same ledger",
  "Preview 1 loopback listener accepts a same-runtime Bun-shaped peer, pending poll, NONBLOCK, duplex and half-close through the normal worker",
  "Unix path socket node, duplex, half-close and unlink across scoped workers; unscoped and external connects denied; abstract name served by an unscoped worker without a node",
  "runtime-owned IPv4 localhost lookup before any helper or worker exists",
  "IPv6 wildcard, loopback, mapped addresses and HTTP destination families across real workers",
  "paused HTTP bounded credit, read wakeups, streaming EOF and cancellation across workers and within one worker",
  "throwing listening hook rolls back publication before a healthy worker retry",
  "real worker duplex, peer identity and half-close",
  "bind conflict and namespace isolation",
  "failed startup, abrupt owner exit and unrelated socket survival",
  "HTTP over service-worker preview and cross-worker TCP",
] as const;
export type NetworkTarget = "chromium" | "firefox" | "webkit" | "ios-safari";
export const networkBudgets = () => ({
  hello: 20_000,
  heartbeat: 10_000,
  operation: 20_000,
  case: 600_000,
  group: 600_000,
  run: 600_000,
});
