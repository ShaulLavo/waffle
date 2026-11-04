type SocketAddress = { readonly host: string; readonly port: number };

/** Launch-only sockets. Preview 1 has no standard connect or listen import. */
export interface Preview1SocketBinding {
  readonly fd: number;
  readonly socket: { readonly connect: SocketAddress } | { readonly listen: SocketAddress };
}

/** The complete structured-clone payload. No connector, stream or credential belongs here. */
export interface Preview1NetworkConnection {
  readonly ring: SharedArrayBuffer;
  readonly port: MessagePort;
  readonly sockets: readonly Preview1SocketBinding[];
}

/** Responsive-owner lifetime, transferred to launchWorker or retained by a manual launcher. */
export interface Preview1Network {
  readonly connection: Preview1NetworkConnection;
  dispose(): void;
}
