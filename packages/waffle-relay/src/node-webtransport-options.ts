import type { createNodeServer, NodeRelayOptions } from "./node-server.js";
import type { TcpServerOptions } from "./tcp-policy.js";
import type { WebTransportBind } from "./webtransport-address.js";
import type { EndpointFailure } from "./webtransport-lifecycle.js";

export interface TcpWebTransportOptions {
  readonly bind: WebTransportBind;
  readonly advertisedUrl?: string | URL;
  readonly certificate?: "rotating-hash" | { readonly cert: string; readonly key: string };
  readonly rotationMs?: number;
  readonly onEndpointFailure?: (failure: EndpointFailure) => void | Promise<void>;
}

export interface NodeWebTransportRelayOptions extends Omit<NodeRelayOptions, "tcp"> {
  readonly tcp: TcpServerOptions & { readonly webtransport: TcpWebTransportOptions };
}

type NodeRelay = ReturnType<typeof createNodeServer>;
export type NodeWebTransportRelayFactory = (
  options: NodeWebTransportRelayOptions,
) => NodeRelay & { readonly tcp: NonNullable<NodeRelay["tcp"]> };
