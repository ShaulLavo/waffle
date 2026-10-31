import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { canonicalDestination, canonicalOrigin, destinationKey } from "./tcp-destination.js";
import { mintRelayToken, tokenKey, verifyRelayToken } from "./token.js";
import { DRAIN_MS, MAX_DATA_BYTES, TCP_PATH, TcpFailure, record } from "./tcp-protocol.js";
import { TcpAdmissions, tcpPolicy, type TcpServerOptions } from "./tcp-policy.js";
import { ServerTcpStream } from "./tcp-server-stream.js";
import type { TcpCarrierFactory } from "./tcp-carrier.js";

export function createTcpRelay(
  options: TcpServerOptions,
  origins: readonly string[],
  carrier?: TcpCarrierFactory,
) {
  const policy = tcpPolicy(options, origins);
  const admissions = new TcpAdmissions(policy.limits);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_DATA_BYTES + 1,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const streams = new Set<ServerTcpStream>();
  const webtransport = carrier?.(policy, admissions);
  const denials = new Set<Promise<void>>();
  const issuerKey = policy.issuer && tokenKey(policy.issuer.credential);
  let revoked = false;
  const revoke = () => {
    revoked = true;
    for (const stream of streams) stream.revoke();
  };
  function denyUpgrade(
    code: "relay-origin" | "limit",
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (denials.size >= 8) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const receipt = Promise.withResolvers<void>();
      denials.add(receipt.promise);
      const timer = setTimeout(() => ws.terminate(), DRAIN_MS);
      ws.on("error", () => {});
      ws.once("close", () => {
        clearTimeout(timer);
        denials.delete(receipt.promise);
        receipt.resolve();
      });
      ws.send(JSON.stringify({ v: 1, ok: false, code }));
      ws.close(1000);
    });
  }
  return {
    ready: webtransport?.ready ?? Promise.resolve(),
    failure: webtransport?.failure,
    status: webtransport?.status,
    revoke() {
      revoke();
      webtransport?.revoke();
    },
    get active() {
      return admissions.active;
    },
    get counters() {
      return Array.from(streams, (stream) => stream.counters).concat(webtransport?.counters ?? []);
    },
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      try {
        if (request.url !== TCP_PATH || request.method !== "GET") {
          rejectUpgrade(socket, 404);
          return;
        }
        try {
          requireOrigin(request, policy.origins);
        } catch {
          denyUpgrade("relay-origin", request, socket, head);
          return;
        }
        if (revoked) {
          rejectUpgrade(socket, 503);
          return;
        }
        let release: () => void;
        try {
          release = admissions.reserve();
        } catch {
          denyUpgrade("limit", request, socket, head);
          return;
        }
        socket.once("error", release);
        socket.once("close", release);
        wss.handleUpgrade(request, socket, head, (ws) => {
          socket.removeListener("error", release);
          socket.removeListener("close", release);
          const stream = new ServerTcpStream(ws, policy, admissions, release);
          streams.add(stream);
          void stream.done.then(
            () => streams.delete(stream),
            () => {},
          );
        });
      } catch (error) {
        rejectUpgrade(socket, error instanceof TcpFailure && error.code === "limit" ? 429 : 403);
      }
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const path = request.url;
      if (path === "/healthz" || path === "/readyz") {
        const available = !revoked && (!webtransport || webtransport.status().state === "serving");
        json(response, path === "/readyz" && !available ? 503 : 200, {
          ok: path === "/healthz" || available,
          ...(path === "/readyz" && webtransport ? { webtransport: available } : {}),
        });
        return true;
      }
      if (path !== `${TCP_PATH}/session` && path !== `${TCP_PATH}/token`) return false;
      try {
        const origin = requireOrigin(request, policy.origins);
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        if (revoked) {
          json(response, 503, { code: "unavailable" });
          return true;
        }
        if (request.method === "OPTIONS") {
          response.setHeader("access-control-allow-methods", "POST");
          response.setHeader("access-control-allow-headers", "authorization, content-type");
          response.writeHead(204).end();
          return true;
        }
        if (request.method !== "POST") {
          json(response, 405, { code: "method" });
          return true;
        }
        const bearer = authorization(request);
        if (path.endsWith("/session")) {
          await verifyRelayToken(await policy.key, bearer);
          json(response, 200, {
            v: 1,
            webtransport: webtransport?.discovery() ?? null,
          });
          return true;
        }
        if (!policy.issuer || !issuerKey) {
          json(response, 404, { code: "not-found" });
          return true;
        }
        await requireIssuer(bearer, await issuerKey);
        const body = await readBody(request, policy.limits.maxOpenBytes);
        const parsed: unknown = JSON.parse(body);
        if (
          !record(parsed) ||
          !Array.isArray(parsed.dst) ||
          parsed.dst.length > 128 ||
          typeof parsed.sub !== "string"
        )
          throw new TcpFailure("relay-auth");
        const dst = parsed.dst.map((value: unknown) => {
          if (!record(value) || typeof value.host !== "string" || typeof value.port !== "number")
            throw new TcpFailure("relay-auth");
          return canonicalDestination({ host: value.host, port: value.port });
        });
        const allowed = new Set(policy.issuer.destinations.map(destinationKey));
        if (dst.some((entry) => !allowed.has(destinationKey(entry))))
          throw new TcpFailure("relay-auth");
        const token = await mintRelayToken(policy.secret, {
          exp: Math.floor(Date.now() / 1000) + policy.issuer.ttlSeconds,
          sub: parsed.sub,
          dst,
        });
        if (revoked) {
          json(response, 503, { code: "unavailable" });
          return true;
        }
        json(response, 200, { token });
      } catch (error) {
        json(response, error instanceof TcpFailure && error.code === "relay-origin" ? 403 : 401, {
          code: error instanceof TcpFailure ? error.code : "relay-auth",
        });
      }
      return true;
    },
    async close(): Promise<void> {
      revoke();
      webtransport?.revoke();
      await Promise.all(Array.from(streams, (stream) => stream.done).concat(Array.from(denials)));
      await webtransport?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
function requireOrigin(request: IncomingMessage, origins: Set<string>): string {
  let value: string | undefined;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]!.toLowerCase() !== "origin") continue;
    if (value !== undefined) throw new TcpFailure("relay-origin");
    value = request.rawHeaders[i + 1]!;
  }
  if (!value || !origins.has(canonicalOrigin(value))) throw new TcpFailure("relay-origin");
  return value;
}
function authorization(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new TcpFailure("relay-auth");
  return value.slice(7);
}
async function requireIssuer(value: string, key: CryptoKey): Promise<void> {
  if (value.length > 4096) throw new TcpFailure("relay-auth");
  const bytes = new TextEncoder().encode("waffle-relay-issuer-v1");
  const candidate = await tokenKey(value);
  const signature = await crypto.subtle.sign("HMAC", candidate, bytes);
  if (!(await crypto.subtle.verify("HMAC", key, signature, bytes)))
    throw new TcpFailure("relay-auth");
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.writeHead(status).end(JSON.stringify(value));
}
function rejectUpgrade(socket: Duplex, status: number): void {
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const timer = setTimeout(() => socket.destroy(), DRAIN_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}
async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => request.destroy(), 5000);
  try {
    for await (const chunk of request) {
      if (!(chunk instanceof Buffer) || (size += chunk.length) > maximum)
        throw new TcpFailure("relay-auth");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}
