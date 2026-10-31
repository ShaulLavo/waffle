import type { TcpAdmissions, TcpPolicy } from "./tcp-policy.js";
import type { TcpQueueCounters } from "./tcp-server-stream.js";

export interface TcpDiscovery {
  readonly url: string;
  readonly certificateHashes?: readonly { readonly algorithm: "sha-256"; readonly value: string }[];
}
export interface TcpCarrierServer {
  readonly ready: Promise<void>;
  readonly counters: readonly TcpQueueCounters[];
  readonly failure: Promise<import("./webtransport-lifecycle.js").EndpointFailure>;
  discovery(): TcpDiscovery | null;
  status(): { state: string; generation: number; ownedEndpoints: number };
  revoke(): void;
  close(): Promise<void>;
}
export type TcpCarrierFactory = (policy: TcpPolicy, admissions: TcpAdmissions) => TcpCarrierServer;
