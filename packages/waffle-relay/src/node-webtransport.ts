import { verifyNativeInstallation } from "./webtransport-integrity.js";
export type {
  TcpWebTransportOptions,
  NodeWebTransportRelayOptions,
} from "./node-webtransport-options.js";
export type { WebTransportBind } from "./webtransport-address.js";
export type { EndpointFailure } from "./webtransport-lifecycle.js";

await verifyNativeInstallation();
const adapter = await import("./node-webtransport-internal.js");
export const createNodeWebTransportRelayServer = adapter.createNodeWebTransportRelayServer;
