import { isIP } from "node:net";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  Http3Server,
  type WebTransportSession,
  type WebTransportBidirectionalStream,
} from "@fails-components/webtransport";
import { createNodeServer, type NodeRelayOptions } from "./node-server.js";
import { canonicalOrigin } from "./tcp-destination.js";
import { createCertificate, type CertificateMaterial } from "./webtransport-certificate.js";
import { ServerWebTransportStream } from "./tcp-webtransport-server-stream.js";
import type { TcpAdmissions, TcpPolicy, TcpServerOptions } from "./tcp-policy.js";
import {
  WebTransportLifecycle,
  rotationDependencies,
  type EndpointFailure,
  type LifecycleBudget,
  type RotationTestDependencies,
  type ManagedEndpoint,
} from "./webtransport-lifecycle.js";
import { nativeResetReason } from "./webtransport-native.js";

const PATH = "/v1/tcp/wt";
export interface TcpWebTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly certificate?: "rotating-hash" | { readonly cert: string; readonly key: string };
  readonly rotationMs?: number;
  readonly onEndpointFailure?: (failure: EndpointFailure) => void | Promise<void>;
}
export interface NodeWebTransportRelayOptions extends Omit<NodeRelayOptions, "tcp"> {
  readonly tcp: TcpServerOptions & { readonly webtransport: TcpWebTransportOptions };
}
export function createNodeWebTransportRelayServer(options: NodeWebTransportRelayOptions) {
  const relay = createNativeRelay(options, rotationDependencies).relay;
  const tcp = relay.tcp;
  if (!tcp) throw new Error("Missing TCP relay");
  return Object.freeze({ ...relay, tcp });
}

export function createNativeRelay(
  options: NodeWebTransportRelayOptions,
  dependencies: RotationTestDependencies,
) {
  const selected = options.tcp.webtransport;
  validateOptions(selected);
  const endpoints = new Set<NativeEndpoint>();
  let lifecycle: WebTransportLifecycle;
  const relay = createNodeServer(options, (policy, admissions) => {
    const certificate = selected.certificate;
    const hashMode = !certificate || certificate === "rotating-hash";
    lifecycle = new WebTransportLifecycle(
      {
        rotationMs: selected.rotationMs ?? 7 * 86400000,
        hashMode,
        certificate: (signal, remaining) =>
          hashMode
            ? createCertificate(signal, remaining)
            : Promise.resolve(parseCertificate(certificate)),
        construct: (record, live) => {
          const endpoint = new NativeEndpoint(
            selected,
            record.certificate,
            policy,
            admissions,
            live,
            record.generation,
          );
          endpoints.add(endpoint);
          void endpoint.disposed.then(
            () => endpoints.delete(endpoint),
            () => {},
          );
          return endpoint;
        },
        discovery: (material) => ({
          url: endpointURL(selected),
          ...(hashMode ? { certificateHashes: [material.hash] } : {}),
        }),
        onEndpointFailure: selected.onEndpointFailure,
        log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      },
      dependencies,
    );
    return {
      ready: lifecycle.ready,
      failure: lifecycle.failure,
      get counters() {
        return Array.from(endpoints).flatMap((endpoint) => endpoint.counters);
      },
      discovery: () => lifecycle.discovery(),
      status: () => lifecycle.status(),
      closeBudget: () => lifecycle.closeBudget(),
      revoke: () => lifecycle.revoke(),
      close: () => lifecycle.close(),
    };
  });
  return { relay, lifecycle: () => lifecycle };
}

class NativeEndpoint implements ManagedEndpoint {
  readonly ready: Promise<unknown>;
  readonly closed: Promise<unknown>;
  private readonly disposal = Promise.withResolvers<void>();
  readonly disposed = this.disposal.promise;
  private readonly server: Http3Server;
  private readonly sessions = new Set<WebTransportSession>();
  private readonly streams = new Set<ServerWebTransportStream>();
  private readonly leases = new Map<
    number,
    { epoch: number; timer: ReturnType<typeof setTimeout> }
  >();
  private nextLease = 0;
  private epoch = 0;
  private fenced = false;
  private stopping: Promise<void> | undefined;
  private readonly accepting: Promise<void>;
  private reason: "shutdown" | "certificate-rotation" = "shutdown";
  constructor(
    options: TcpWebTransportOptions,
    certificate: CertificateMaterial,
    private readonly policy: TcpPolicy,
    private readonly admissions: TcpAdmissions,
    private readonly live: () => boolean,
    private readonly generation: number,
  ) {
    this.server = new Http3Server({
      host: options.host,
      port: options.port,
      secret: randomBytes(32).toString("hex"),
      cert: certificate.cert,
      privKey: certificate.key,
      defaultDatagramsReadableMode: "bytes",
      initialStreamFlowControlWindow: Math.max(65536, policy.limits.windowBytes),
      streamShouldAutoTuneReceiveWindow: false,
      streamFlowControlWindowSizeLimit: Math.max(65536, policy.limits.windowBytes),
      initialSessionFlowControlWindow: Math.max(65536, policy.limits.windowBytes),
      sessionShouldAutoTuneReceiveWindow: false,
      sessionFlowControlWindowSizeLimit: Math.max(65536, policy.limits.windowBytes),
      maxConnections: 64,
      quicheNodeSocketOptions: { reuseAddr: false },
    });
    this.ready = this.server.ready;
    this.closed = this.server.closed;
    void this.ready.catch(() => {});
    void this.closed.catch(() => {});
    this.server.setRequestCallback(({ header }: { header: Record<string, unknown> }) =>
      Promise.resolve(this.admitSession(header)),
    );
    this.accepting = this.accept(this.server.sessionStream(PATH).getReader());
    void this.accepting.catch(() => {});
  }
  get counters() {
    return Array.from(this.streams, (stream) => stream.counters);
  }
  start(): void {
    this.server.startServer();
  }
  fence(reason: "shutdown" | "certificate-rotation", budget?: LifecycleBudget): void {
    if (this.fenced) return;
    this.fenced = true;
    this.epoch++;
    this.reason = reason;
    for (const lease of this.leases.values()) clearTimeout(lease.timer);
    this.leases.clear();
    for (const stream of this.streams) stream.revoke(reason, budget);
    for (const session of this.sessions) session.close({ closeCode: 4, reason });
  }
  stop(budget: LifecycleBudget): Promise<void> {
    this.stopping ??= this.shutdown(budget);
    return this.stopping;
  }
  private admitSession(header: Record<string, unknown>): object {
    if (header[":path"] !== PATH || !allowedOrigin(header.origin, this.policy.origins))
      return { status: 403 };
    if (!this.live() || this.fenced || this.leases.size + this.sessions.size >= 64)
      return { status: 503 };
    const id = ++this.nextLease;
    this.leases.set(id, {
      epoch: this.epoch,
      timer: setTimeout(() => this.leases.delete(id), 10000),
    });
    return { status: 200, path: PATH, userData: { lease: id, generation: this.generation } };
  }
  private async accept(
    reader: import("node:stream/web").ReadableStreamDefaultReader<WebTransportSession>,
  ): Promise<void> {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        this.startSession(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  private startSession(session: WebTransportSession): void {
    const ticket = this.consumeLease(session);
    if (!ticket || !this.live() || this.fenced || this.sessions.size >= 64) {
      session.close({ closeCode: 4, reason: this.reason });
      return;
    }
    this.sessions.add(session);
    const timeout = setTimeout(
      () => session.close({ closeCode: 3, reason: "authentication-timeout" }),
      10000,
    );
    void session.closed
      .finally(() => {
        clearTimeout(timeout);
        this.sessions.delete(session);
      })
      .catch(() => {});
    void this.readSession(session, () => clearTimeout(timeout)).catch(() =>
      session.close({ closeCode: 1, reason: "carrier-loss" }),
    );
    void this.drainUnsupported(session).catch(() => {});
  }
  private consumeLease(session: WebTransportSession): boolean {
    if (!("userData" in session)) return false;
    const data = session.userData;
    if (!data || typeof data !== "object" || !("lease" in data) || typeof data.lease !== "number")
      return false;
    const lease = this.leases.get(data.lease);
    if (!lease) return false;
    clearTimeout(lease.timer);
    this.leases.delete(data.lease);
    return lease.epoch === this.epoch;
  }
  private async readSession(
    session: WebTransportSession,
    authenticated: () => void,
  ): Promise<void> {
    const reader = session.incomingBidirectionalStreams.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        this.acceptStream(session, next.value, authenticated);
      }
    } finally {
      reader.releaseLock();
    }
  }
  private acceptStream(
    session: WebTransportSession,
    stream: WebTransportBidirectionalStream,
    authenticated: () => void,
  ): void {
    let release: () => void;
    try {
      if (!this.live() || this.fenced) throw new Error("fenced");
      release = this.admissions.reserve();
    } catch {
      void stream.readable.cancel(nativeResetReason(3)).catch(() => {});
      void stream.writable.abort(nativeResetReason(3)).catch(() => {});
      return;
    }
    const connection = new ServerWebTransportStream(
      stream,
      this.policy,
      this.admissions,
      release,
      authenticated,
      () => session.close({ closeCode: 1, reason: "cleanup" }),
      session.closed,
    );
    this.streams.add(connection);
    void connection.done.then(
      () => this.streams.delete(connection),
      () => {},
    );
  }
  private async drainUnsupported(session: WebTransportSession): Promise<void> {
    const reader = session.incomingUnidirectionalStreams.getReader();
    const datagrams = session.datagrams.readable.getReader();
    const drain = async () => {
      while (!(await datagrams.read()).done) {}
    };
    void drain()
      .finally(() => datagrams.releaseLock())
      .catch(() => {});
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        void next.value.cancel(nativeResetReason(3)).catch(() => {});
      }
    } finally {
      reader.releaseLock();
    }
  }
  private async shutdown(budget: LifecycleBudget): Promise<void> {
    this.fence(this.reason, budget);
    await budget
      .cleanup(Promise.allSettled(Array.from(this.sessions, (session) => session.closed)), 1000)
      .catch(() => {});
    budget.remaining();
    this.server.stopServer();
    budget.remaining();
    await budget.cleanup(this.closed, 5000);
    await budget.cleanup(this.accepting);
    await budget.cleanup(Promise.all(Array.from(this.streams, (stream) => stream.done)));
    if (this.sessions.size || this.streams.size || this.leases.size)
      throw new Error("Native endpoint cleanup is unsettled");
    this.disposal.resolve();
  }
}
function parseCertificate(value: TcpWebTransportOptions["certificate"]): CertificateMaterial {
  if (!value || value === "rotating-hash") throw new TypeError("Missing certificate");
  const parsed = new X509Certificate(value.cert);
  return {
    ...value,
    starts: Date.parse(parsed.validFrom),
    expires: Date.parse(parsed.validTo),
    hash: { algorithm: "sha-256", value: "" },
  };
}
function allowedOrigin(value: unknown, origins: Set<string>): boolean {
  if (typeof value !== "string") return false;
  try {
    return origins.has(canonicalOrigin(value));
  } catch {
    return false;
  }
}
function endpointURL(options: TcpWebTransportOptions): string {
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  return `https://${host}:${options.port}${PATH}`;
}
function validateOptions(options: TcpWebTransportOptions): void {
  if (
    !isIP(options.host) ||
    options.host === "0.0.0.0" ||
    options.host === "::" ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new TypeError("WebTransport requires an explicit numeric interface and port");
}
