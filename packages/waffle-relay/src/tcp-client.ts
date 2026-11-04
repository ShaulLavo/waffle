import { canonicalDestination } from "./tcp-destination.js";
import { cancellable } from "./tcp-async.js";
import { RelayConnectError, type TcpStream, type TcpTarget } from "./tcp-protocol.js";
import type { ClientWebSocket } from "./tcp-websocket.js";
import type { WebTransportCarrier, WebTransportFactory } from "./tcp-webtransport.js";

export interface RelayConnectOptions {
  readonly endpoint: string | URL;
  readonly getToken: () => string | Promise<string>;
  readonly carriers?: readonly ("webtransport" | "websocket")[];
  /** Trusted Node/Bun transport sets the required Origin; browsers supply it themselves. */
  readonly webSocket?: (url: string) => ClientWebSocket;
  readonly windowBytes?: number;
  readonly connectTimeoutMs?: number;
  /** Trusted discovery transport. Browser credentials are never included implicitly. */
  readonly fetch?: typeof fetch;
  readonly webTransport?: WebTransportFactory;
}
export function createRelayConnect(options: RelayConnectOptions) {
  return new RelayConnector(options).capability;
}
class RelayConnector {
  private readonly options: RelayConnectOptions;
  private readonly endpoint: string;
  private readonly carriers: readonly ("webtransport" | "websocket")[];
  private readonly maximum: number;
  private readonly deadline: number;
  private readonly jobs = new Set<{ abort: AbortController; done: Promise<void> }>();
  private webtransport: WebTransportCarrier | undefined;
  private fallbackUntil = 0;
  private lastCarrier: "webtransport" | "websocket" | null = null;
  private revoked = false;
  private closing: Promise<void> | undefined;
  readonly capability;
  constructor(options: RelayConnectOptions) {
    this.options = { ...options };
    this.endpoint = endpointURL(options.endpoint);
    this.carriers = options.carriers?.slice() ?? ["webtransport", "websocket"];
    this.maximum = options.windowBytes ?? 262144;
    this.deadline = options.connectTimeoutMs ?? 15000;
    validateOptions(this.carriers, this.maximum, this.deadline);
    const currentCarrier = () => this.lastCarrier;
    this.capability = Object.freeze({
      get carrier() {
        return currentCarrier();
      },
      connect: (target: TcpTarget, signal: AbortSignal) => this.connect(target, signal),
      revoke: () => this.revoke(),
      close: () => this.close(),
    });
  }
  private async connect(target: TcpTarget, signal: AbortSignal): Promise<TcpStream> {
    if (this.revoked) throw new RelayConnectError("EACCES");
    signal.throwIfAborted();
    const destination = checkedDestination(target);
    const abort = new AbortController();
    const completion = Promise.withResolvers<void>();
    const job = { abort, done: completion.promise };
    this.jobs.add(job);
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      this.jobs.delete(job);
      completion.resolve();
    };
    let receipt: Promise<void> | undefined;
    const timer = setTimeout(() => abort.abort(new RelayConnectError("ETIMEDOUT")), this.deadline);
    try {
      const token = await cancellable(Promise.resolve().then(this.options.getToken), abort.signal);
      const connection = await this.open(destination, token, abort.signal);
      receipt = connection.closed;
      void receipt.then(finish, finish);
      const stream = await connection.opened;
      this.lastCarrier = connection.carrier;
      return stream;
    } catch (error) {
      abort.abort(error);
      if (!receipt) finish();
      if (signal.aborted) throw signal.reason;
      throw error instanceof RelayConnectError ? error : new RelayConnectError("ENETUNREACH");
    } finally {
      clearTimeout(timer);
    }
  }
  private async open(target: TcpTarget, token: string, signal: AbortSignal) {
    const available = this.options.webTransport || typeof WebTransport === "function";
    const probe =
      available && this.carriers[0] === "webtransport" && Date.now() >= this.fallbackUntil;
    if (probe) {
      const attempt = await this.tryWebTransport(target, token, signal);
      if (attempt) return attempt;
    }
    if (!this.carriers.includes("websocket")) throw new RelayConnectError("ENETUNREACH");
    const { openWebSocket } = await cancellable(import("./tcp-websocket.js"), signal);
    signal.throwIfAborted();
    return {
      ...openWebSocket({
        endpoint: websocketURL(this.endpoint),
        factory: this.options.webSocket,
        destination: target,
        token,
        signal,
        windowBytes: this.maximum,
      }),
      carrier: "websocket" as const,
    };
  }
  private async tryWebTransport(target: TcpTarget, token: string, signal: AbortSignal) {
    const { WebTransportCarrier, WebTransportAttemptError } = await cancellable(
      import("./tcp-webtransport.js"),
      signal,
    );
    this.webtransport ??= new WebTransportCarrier({
      endpoint: this.endpoint,
      fetch: this.options.fetch ?? globalThis.fetch,
      factory: this.options.webTransport,
    });
    const attempt = this.webtransport.open({ target, token, signal, windowBytes: this.maximum });
    try {
      const stream = await attempt.opened;
      return {
        opened: Promise.resolve(stream),
        closed: attempt.closed,
        carrier: "webtransport" as const,
      };
    } catch (error) {
      if (error instanceof WebTransportAttemptError && error.retryable)
        this.fallbackUntil = Date.now() + 300000;
      if (error instanceof WebTransportAttemptError && !error.retryable)
        throw new RelayConnectError("ECONNRESET");
      if (!(error instanceof WebTransportAttemptError)) throw error;
      signal.throwIfAborted();
      return;
    }
  }
  private revoke(): void {
    this.revoked = true;
    this.webtransport?.revoke();
    for (const job of this.jobs) job.abort.abort(new RelayConnectError("ECONNRESET"));
  }
  private close(): Promise<void> {
    this.revoke();
    this.closing ??= Promise.all(
      Array.from(this.jobs, (job) => job.done).concat([
        this.webtransport?.close() ?? Promise.resolve(),
      ]),
    ).then(() => {});
    return this.closing;
  }
}
function validateOptions(carriers: readonly string[], maximum: number, deadline: number): void {
  if (
    !carriers.length ||
    carriers.some((value) => value !== "websocket" && value !== "webtransport")
  )
    throw new TypeError("Invalid TCP carriers");
  if (
    !Number.isInteger(maximum) ||
    maximum < 16384 ||
    maximum > 262144 ||
    !Number.isInteger(deadline) ||
    deadline < 1 ||
    deadline > 2147483647
  )
    throw new TypeError("Invalid TCP client limits");
}
function checkedDestination(target: TcpTarget): TcpTarget {
  try {
    return canonicalDestination(target);
  } catch {
    throw new RelayConnectError("EACCES");
  }
}
function endpointURL(value: string | URL): string {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TypeError("Invalid TCP relay endpoint");
  if (url.protocol !== "https:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    throw new TypeError("Remote TCP relay requires HTTPS");
  return url.href;
}
function websocketURL(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = "/v1/tcp";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
