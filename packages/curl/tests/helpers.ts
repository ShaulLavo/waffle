import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Socket } from "node:net";
import type { CurlInvocation, CurlOutput } from "../src/types.ts";

const cleanups = new Set<() => Promise<void>>();
export async function cleanupFixtures(): Promise<void> {
  for (const cleanup of cleanups) await cleanup();
  cleanups.clear();
}

export function capture() {
  const chunks: Uint8Array[] = [];
  let closed = 0;
  let aborted = 0;
  const output: CurlOutput = {
    async write(bytes, signal) {
      signal.throwIfAborted();
      chunks.push(bytes.slice());
    },
    async close(signal) {
      signal.throwIfAborted();
      closed++;
    },
    async abort() {
      aborted++;
    },
  };
  return {
    output,
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString(),
    state: () => ({ closed, aborted }),
  };
}

export function invocation(argv: readonly string[], input = new Uint8Array()) {
  const stdout = capture();
  const file = capture();
  const controller = new AbortController();
  const errors: string[] = [];
  const written: string[] = [];
  let reads = 0;
  const call: CurlInvocation = {
    argv,
    signal: controller.signal,
    timeoutMs: 1500,
    fetch,
    stdin: new Blob([input]).stream(),
    stdout: stdout.output,
    stderr: async (text) => {
      errors.push(text);
    },
    files: {
      async read() {
        reads++;
        return new Blob([input]).stream();
      },
      async write(path, signal) {
        signal.throwIfAborted();
        written.push(path);
        return file.output;
      },
    },
  };
  return { call, stdout, file, errors, written, controller, reads: () => reads };
}

export async function fixture() {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.sendDate = false;
    route(req, res, timers);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (server.listening || Array.from(sockets).some((socket) => !socket.destroyed))
      throw new Error("fixture cleanup incomplete");
  };
  cleanups.add(cleanup);
  // Explicit owned loopback ports. An occupied port is never reused or killed.
  await listen(server, [46271, 46272, 46273]);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP port");
  return { url: `http://127.0.0.1:${address.port}`, requests, cleanup };
}

async function listen(server: Server, ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    try {
      await listenAt(server, port);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE")
        throw error;
    }
  }
  throw new Error("all explicit fixture ports are occupied");
}

function listenAt(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failure = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", failure);
      resolve();
    };
    server.once("error", failure);
    server.once("listening", ready);
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  timers: Set<ReturnType<typeof setTimeout>>,
): void {
  if (req.url === "/stall") return;
  if (req.url === "/echo") {
    void echo(req, res);
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/ok" });
    res.end("redirect");
    return;
  }
  if (req.url === "/post-redirect") {
    res.writeHead(307, { location: "/echo" });
    res.end();
    return;
  }
  if (req.url === "/partial" || req.url === "/drip") {
    partial(req, res, timers);
    return;
  }
  const status = req.url === "/missing" ? 404 : 200;
  const body = status === 404 ? "missing\n" : "hello\n";
  res.writeHead(status, {
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(body),
    "x-fixture": "owned",
  });
  res.end(body);
}

function partial(
  req: IncomingMessage,
  res: ServerResponse,
  timers: Set<ReturnType<typeof setTimeout>>,
): void {
  res.writeHead(200, { "content-type": "text/plain", "content-length": "100000" });
  res.write("prefix\n");
  if (req.url !== "/partial") return;
  timers.add(setTimeout(() => res.destroy(), 40));
}

async function echo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.stringify({
    method: req.method,
    body: Buffer.concat(chunks).toString("base64"),
    header: req.headers["x-test"] ?? null,
    type: req.headers["content-type"] ?? null,
  });
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
