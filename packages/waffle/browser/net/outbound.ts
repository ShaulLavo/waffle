import type { PeerAddr } from "./protocol.js";

export interface NetOutboundTarget {
  /** Guest-supplied hostname or non-loopback IP literal, unresolved. */
  readonly host: string;
  /** Destination port, 1 through 65535. */
  readonly port: number;
}

export interface NetOutboundStream {
  /** EOF is the peer's FIN. Errors reset the connection. Supply bounded, pull-driven chunks. */
  readonly readable: ReadableStream<Uint8Array>;
  /** close() sends our FIN after queued bytes; abort() resets the connection. */
  readonly writable: WritableStream<Uint8Array>;
  /** Actual remote endpoint chosen by the connector. */
  readonly remote: PeerAddr;
}

/** Page-owned capability. Honor abort during opening and after open to release underlying I/O. */
export type NetConnect = (
  target: NetOutboundTarget,
  signal: AbortSignal,
) => Promise<NetOutboundStream>;

export type NetConnectErrorCode =
  | "EACCES"
  | "ECONNREFUSED"
  | "ENOTFOUND"
  | "ETIMEDOUT"
  | "EHOSTUNREACH"
  | "ENETUNREACH"
  | "ECONNRESET";

export class NetConnectError extends Error {
  readonly code: NetConnectErrorCode;

  constructor(code: NetConnectErrorCode, message: string) {
    super(message);
    this.name = "NetConnectError";
    this.code = code;
  }
}
