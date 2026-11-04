import { TcpServerConnection } from "./tcp-server-connection.js";
import { StreamTransport } from "./tcp-frame-stream.js";
import { nativeResetReason } from "./webtransport-native.js";
import type { ByteStream } from "./tcp-byte-channel.js";
import type { TcpPolicy, TcpAdmissions, Resolver } from "./tcp-policy.js";
export class ServerWebTransportStream extends TcpServerConnection {
  constructor(
    stream: ByteStream,
    policy: TcpPolicy,
    admissions: TcpAdmissions,
    release: () => void,
    authenticated: () => void,
    closeSession: () => void,
    sessionClosed: Promise<unknown>,
    resolve?: Resolver,
  ) {
    super(
      new StreamTransport(stream, policy.limits.windowBytes, nativeResetReason, sessionClosed),
      policy,
      admissions,
      release,
      authenticated,
      closeSession,
      resolve,
    );
  }
}
