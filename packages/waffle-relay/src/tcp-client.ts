import { canonicalDestination } from "./tcp-destination.js";
import { RelayConnectError, type TcpStream, type TcpTarget } from "./tcp-protocol.js";
import type { ClientWebSocket } from "./tcp-websocket.js";

export interface RelayConnectOptions {
  readonly endpoint: string | URL;
  readonly getToken: () => string | Promise<string>;
  readonly carriers?: readonly ("webtransport" | "websocket")[];
  /** Trusted Node/Bun transport sets the required Origin; browsers supply it themselves. */
  readonly webSocket?: (url: string) => ClientWebSocket;
  readonly windowBytes?: number;
  readonly connectTimeoutMs?: number;
}
export function createRelayConnect(options: RelayConnectOptions) {
  const endpoint = endpointURL(options.endpoint);
  const carriers = options.carriers?.slice() ?? ["webtransport", "websocket"];
  if (
    !carriers.length ||
    carriers.some((value) => value !== "websocket" && value !== "webtransport")
  )
    throw new TypeError("Invalid TCP carriers");
  const maximum = options.windowBytes ?? 262144;
  const deadline = options.connectTimeoutMs ?? 15000;
  if (
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 262144 ||
    !Number.isInteger(deadline) ||
    deadline < 1 ||
    deadline > 2147483647
  )
    throw new TypeError("Invalid TCP client limits");
  const getToken = options.getToken;
  const factory = options.webSocket;
  const jobs = new Set<{ abort: AbortController; done: Promise<void> }>();
  let revoked = false;
  let carrier: "websocket" | null = null;
  let closing: Promise<void> | undefined;
  const revoke = () => {
    revoked = true;
    for (const job of jobs) job.abort.abort(new RelayConnectError("ECONNRESET"));
  };
  return Object.freeze({
    get carrier() {
      return carrier;
    },
    async connect(target: TcpTarget, signal: AbortSignal): Promise<TcpStream> {
      if (revoked) throw new RelayConnectError("EACCES");
      signal.throwIfAborted();
      const destination = checkedDestination(target);
      const abort = new AbortController();
      const completion = Promise.withResolvers<void>();
      const job = { abort, done: completion.promise };
      jobs.add(job);
      const cancel = () => abort.abort(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      const finish = () => {
        signal.removeEventListener("abort", cancel);
        jobs.delete(job);
        completion.resolve();
      };
      let allocated = false;
      const timer = setTimeout(() => abort.abort(new RelayConnectError("ETIMEDOUT")), deadline);
      try {
        // N3 adds the complete WebTransport probe here. N2 makes no WebTransport attempt.
        if (!carriers.includes("websocket")) throw new RelayConnectError("ENETUNREACH");
        const token = await cancellable(Promise.resolve().then(getToken), abort.signal);
        const { openWebSocket } = await cancellable(import("./tcp-websocket.js"), abort.signal);
        abort.signal.throwIfAborted();
        const connection = openWebSocket({
          endpoint,
          factory,
          destination,
          token,
          signal: abort.signal,
          windowBytes: maximum,
        });
        allocated = true;
        void connection.closed.then(finish);
        const stream = await connection.opened;
        carrier = "websocket";
        return stream;
      } catch (error) {
        abort.abort(error);
        // If no carrier was allocated, there is nothing to join.
        if (!allocated) finish();
        throw error instanceof RelayConnectError || signal.aborted
          ? error
          : new RelayConnectError("ENETUNREACH");
      } finally {
        clearTimeout(timer);
      }
    },
    revoke,
    close(): Promise<void> {
      closing ??= (revoke(), Promise.all(Array.from(jobs, (job) => job.done)).then(() => {}));
      return closing;
    },
  });
}
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw signal.reason;
  }
  const cancellation = Promise.withResolvers<never>();
  const abort = () => cancellation.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, cancellation.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function checkedDestination(target: TcpTarget): TcpTarget {
  try {
    return canonicalDestination(target);
  } catch {
    throw new RelayConnectError("EACCES");
  }
}
function endpointURL(value: string | URL): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Invalid TCP relay endpoint");
  }
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
  url.pathname = "/v1/tcp";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
