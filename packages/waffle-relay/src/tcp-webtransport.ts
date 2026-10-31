import { StreamTransport } from "./tcp-frame-stream.js";
import { TcpFlow } from "./tcp-flow.js";
import { clientFlow } from "./tcp-client-flow.js";
import { ByteChannel, browserResetReason, type ByteStream } from "./tcp-byte-channel.js";
import { cancellable, deadline } from "./tcp-async.js";
import {
  DRAIN_MS,
  MAX_OPEN_BYTES,
  RelayConnectError,
  connectError,
  encodeOpenHeader,
  parseReply,
  record,
  type TcpStream,
  type TcpTarget,
} from "./tcp-protocol.js";

export interface WebTransportLike {
  readonly ready: Promise<void>;
  readonly closed: Promise<unknown>;
  createBidirectionalStream(): Promise<ByteStream>;
  close(info?: { closeCode: number; reason: string }): void;
}
export type WebTransportFactory = (
  url: string,
  options: {
    readonly serverCertificateHashes?: readonly {
      readonly algorithm: "sha-256";
      readonly value: ArrayBuffer;
    }[];
  },
) => WebTransportLike;
export class WebTransportAttemptError extends Error {
  constructor(readonly retryable: boolean) {
    super("WebTransport unavailable");
  }
}
export interface WebTransportAttempt {
  readonly opened: Promise<TcpStream>;
  readonly closed: Promise<void>;
}
interface Session {
  readonly transport: WebTransportLike;
  readonly ended: AbortController;
  readonly clients: Set<{ closed: Promise<void> }>;
}
interface ConnectOptions {
  readonly token: string;
  readonly target: TcpTarget;
  readonly signal: AbortSignal;
  readonly windowBytes: number;
}

export class WebTransportCarrier {
  private session: Session | undefined;
  private pending: Promise<Session> | undefined;
  private revoked = false;
  private readonly receipts = new Set<Promise<void>>();
  constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly fetch: typeof fetch;
      readonly factory?: WebTransportFactory;
    },
  ) {}
  open(options: ConnectOptions): WebTransportAttempt {
    const completion = Promise.withResolvers<void>();
    const opened = this.connect(options, completion.resolve);
    return { opened, closed: completion.promise };
  }
  revoke(): void {
    this.revoked = true;
    if (this.session) this.dropSession(this.session);
  }
  async close(): Promise<void> {
    this.revoke();
    await this.pending?.catch(() => {});
    await Promise.all(Array.from(this.receipts));
  }
  private async connect(options: ConnectOptions, finish: () => void): Promise<TcpStream> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new RelayConnectError("ENETUNREACH")), 3000);
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    let session: Session | undefined;
    let channel: ByteChannel | undefined;
    let framed: StreamTransport | undefined;
    let admitted = false;
    let replied = false;
    try {
      session = await cancellable(this.getSession(options.token, signal), signal);
      const allocation = session.transport.createBidirectionalStream();
      this.ownLateStream(allocation, signal);
      const raw = await cancellable(allocation, signal);
      framed = new StreamTransport(
        raw,
        options.windowBytes,
        browserResetReason,
        session.transport.closed,
      );
      channel = framed.channel;
      // Once submitted, remote target admission is ambiguous. This connect must never replay.
      admitted = true;
      await cancellable(
        channel.writer.write(
          encodeOpenHeader({
            v: 1,
            token: options.token,
            ...options.target,
            window: options.windowBytes,
          }),
        ),
        signal,
      );
      const reply = parseReply(await cancellable(channel.header(MAX_OPEN_BYTES, true), signal));
      replied = true;
      if (!reply.ok) {
        if (channel.bufferedBytes) throw new RelayConnectError("ECONNRESET");
        throw connectError(reply.code);
      }
      const flow = new TcpFlow(options.windowBytes, reply.window, framed);
      const client = clientFlow(flow, reply.remote, options.signal, session.ended.signal);
      session.clients.add(client);
      this.ownCleanup(client.closed, false);
      void client.closed
        .finally(() => {
          session?.clients.delete(client);
          finish();
        })
        .catch(() => {});
      void framed.readFrames(flow).catch(() => {});
      return client.stream;
    } catch (error) {
      if (framed) this.ownCleanup(framed.reset(3));
      if (session && !session.clients.size && !replied) this.dropSession(session);
      finish();
      if (options.signal.aborted) throw options.signal.reason;
      if (replied) throw error;
      throw new WebTransportAttemptError(!admitted);
    } finally {
      clearTimeout(timer);
    }
  }
  private getSession(token: string, signal: AbortSignal): Promise<Session> {
    if (this.revoked) return Promise.reject(new RelayConnectError("EACCES"));
    if (this.pending) return this.pending;
    if (this.session && !this.session.ended.signal.aborted) return Promise.resolve(this.session);
    this.pending ??= this.createSession(token, signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async createSession(token: string, signal: AbortSignal): Promise<Session> {
    const config = await discover(this.options.endpoint, token, this.options.fetch, signal);
    signal.throwIfAborted();
    const transport = (this.options.factory ?? browserFactory)(config.url, config.options);
    const session: Session = { transport, ended: new AbortController(), clients: new Set() };
    this.session = session;
    void transport.closed.then(
      () => this.lost(session),
      () => this.lost(session),
    );
    try {
      await cancellable(transport.ready, signal);
      signal.throwIfAborted();
      if (this.revoked) throw new RelayConnectError("EACCES");
      return session;
    } catch (error) {
      this.dropSession(session);
      throw error;
    }
  }
  private lost(session: Session): void {
    session.ended.abort(new RelayConnectError("ECONNRESET"));
    if (this.session === session) this.session = undefined;
  }
  private dropSession(session: Session): void {
    this.lost(session);
    session.transport.close({ closeCode: 0, reason: "cleanup" });
    this.ownCleanup(session.transport.closed.then(() => {}));
  }
  private ownCleanup(receipt: Promise<void>, terminal = true): void {
    const bounded = terminal ? deadline(receipt, DRAIN_MS) : receipt;
    this.receipts.add(bounded);
    void bounded.then(
      () => this.receipts.delete(bounded),
      () => {},
    );
  }
  private ownLateStream(promise: Promise<ByteStream>, signal: AbortSignal): void {
    void promise.then(
      (stream) => {
        if (!signal.aborted) return;
        this.ownCleanup(
          Promise.allSettled([
            stream.readable.cancel(browserResetReason(3)),
            stream.writable.abort(browserResetReason(3)),
          ]).then(() => {}),
        );
      },
      () => {},
    );
  }
}

async function discover(
  endpoint: string,
  token: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
) {
  const response = await cancellable(
    fetcher(`${endpoint}v1/tcp/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    }),
    signal,
  );
  if (!response.ok) throw new WebTransportAttemptError(true);
  const body = await readDiscoveryBody(response, signal);
  const value: unknown = JSON.parse(body);
  if (!record(value) || value.v !== 1 || !record(value.webtransport))
    throw new WebTransportAttemptError(true);
  const url = value.webtransport.url;
  if (typeof url !== "string") throw new WebTransportAttemptError(true);
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/v1/tcp/wt"
  )
    throw new WebTransportAttemptError(true);
  const hashes = value.webtransport.certificateHashes;
  if (hashes === undefined) return { url, options: {} };
  if (!Array.isArray(hashes) || !hashes.length || hashes.length !== 1)
    throw new WebTransportAttemptError(true);
  return { url, options: { serverCertificateHashes: hashes.map(parseHash) } };
}
async function readDiscoveryBody(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new WebTransportAttemptError(true);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await cancellable(reader.read(), signal);
      if (next.done) break;
      length += next.value.length;
      if (length > 8192) throw new WebTransportAttemptError(true);
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseHash(value: unknown): { algorithm: "sha-256"; value: ArrayBuffer } {
  if (
    !record(value) ||
    value.algorithm !== "sha-256" ||
    typeof value.value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.value)
  )
    throw new WebTransportAttemptError(true);
  const bytes = Uint8Array.from(atob(value.value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
  const canonical = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (bytes.length !== 32 || canonical !== value.value) throw new WebTransportAttemptError(true);
  return { algorithm: "sha-256", value: bytes.buffer };
}
function browserFactory(
  url: string,
  options: Parameters<WebTransportFactory>[1],
): WebTransportLike {
  if (typeof WebTransport !== "function") throw new WebTransportAttemptError(true);
  return new WebTransport(url, {
    serverCertificateHashes: options.serverCertificateHashes?.slice(),
  });
}
