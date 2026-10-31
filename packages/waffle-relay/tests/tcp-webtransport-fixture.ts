import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type JSHandle } from "playwright";
import type { createNodeRelayServer, TcpLog } from "waffle-relay/node";
import { mintRelayToken } from "waffle-relay/token";
import type { TcpQueueCounters } from "../src/tcp-server-stream.js";

const scratch = mkdtempSync(join(process.env.NETWORK_SCRATCH_ROOT ?? "/work/tmp", "wn3-"));
const sockets = new Set<Socket>();
let pauseTargets = false;
const bulk = new WeakSet<Socket>();
const windowBytes = Number(process.env.WAFFLE_TEST_WINDOW ?? 262144);
assert.ok(windowBytes === 65536 || windowBytes === 262144);
const slowTimers = new Set<ReturnType<typeof setTimeout>>();
const slowUploads = new WeakMap<Socket, { bytes: number; valid: boolean }>();
const slowReceipts: { bytes: number; valid: boolean }[] = [];
function slowTarget(socket: Socket, bytes: Buffer): boolean {
  const upload = slowUploads.get(socket);
  if (upload) {
    upload.bytes += bytes.length;
    upload.valid &&= bytes.every((byte) => byte === 9);
    return true;
  }
  if (bytes.toString() === "SLOWUP") {
    const receipt = { bytes: 0, valid: true };
    slowUploads.set(socket, receipt);
    slowReceipts.push(receipt);
    bulk.add(socket);
    socket.end("target-fin");
    return true;
  }
  if (bytes.toString() !== "SLOWDOWN") return false;
  bulk.add(socket);
  const timer = setTimeout(() => {
    slowTimers.delete(timer);
    if (!socket.destroyed) socket.end(Buffer.alloc(131072, 7));
  }, 5500);
  slowTimers.add(timer);
  return true;
}
async function sendBulk(socket: Socket): Promise<void> {
  const bytes = Buffer.alloc(65536, 7);
  try {
    for (let offset = 0; offset < 64 * 1024 * 1024; offset += bytes.length)
      await new Promise<void>((resolve, reject) =>
        socket.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
    socket.end();
  } catch {
    socket.destroy();
  }
}
type ClientRelay = ReturnType<typeof import("../src/tcp-client.js").createRelayConnect>;
type TcpStream = import("../src/tcp-protocol.js").TcpStream;
const logs: TcpLog[] = [];
const target = { host: "echo.waffle.internal", port: 9000 };
const secret = crypto.getRandomValues(new Uint8Array(32));
const echo = createTcpServer({ allowHalfOpen: true }, (socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
  socket.on("data", (bytes) => {
    if (slowTarget(socket, typeof bytes === "string" ? Buffer.from(bytes) : bytes)) return;
    if (bytes.toString() === "BULK") {
      bulk.add(socket);
      void sendBulk(socket);
      return;
    }
    if (bytes.toString() === "RESET") {
      socket.resetAndDestroy();
      return;
    }
    socket.write(bytes);
  });
  socket.on("end", () => {
    if (!bulk.has(socket)) socket.end();
  });
  if (pauseTargets) socket.pause();
});
const pageServer = createHttpServer((request, response) => {
  if (request.url === "/client.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(readFileSync(join(scratch, "client.js")));
    return;
  }
  response.end("<!doctype html><title>WebTransport fixture</title>");
});
let relay: ReturnType<typeof createNodeRelayServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    for (const timer of slowTimers) clearTimeout(timer);
    slowTimers.clear();
    const receipts = await Promise.allSettled([browser?.close(), relay?.close()]);
    await Promise.all(
      Array.from(sockets, async (socket) => {
        const closed = once(socket, "close").catch(() => {});
        socket.destroy();
        await closed;
      }),
    );
    await Promise.all(
      [echo, pageServer].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    assert.equal(sockets.size, 0);
    assert.equal(relay?.tcp?.active ?? 0, 0);
    assert.equal(echo.listening, false);
    assert.equal(pageServer.listening, false);
    rmSync(scratch, { recursive: true, force: true });
    assert.ok(
      receipts.every((receipt) => receipt.status === "fulfilled"),
      "relay cleanup failed",
    );
  })();
  return cleanupPromise;
}
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));
process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
const timeout = setTimeout(() => void cleanup().finally(() => process.exit(1)), 90000);
async function listen(server: typeof echo | typeof pageServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function udpPort(): Promise<number> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    return socket.address().port;
  } finally {
    await new Promise<void>((resolve) => socket.close(resolve));
  }
}
try {
  execFileSync(
    "bun",
    [
      "build",
      resolve(import.meta.dirname, "../src/tcp-client.ts"),
      "--target=browser",
      `--outfile=${scratch}/client.js`,
    ],
    { stdio: "pipe" },
  );
  const origin = `http://127.0.0.1:${await listen(pageServer)}`;
  let scheduled = () => {};
  let wall = Date.now();
  const internalModule = new URL("../dist/node-webtransport-internal.js", import.meta.url).href;
  const { createNativeRelay }: typeof import("../src/node-webtransport-internal.js") = await import(
    internalModule
  );
  const echoPort = await listen(echo);
  const native = createNativeRelay(
    {
      credential: "separate-http-fixture-credential",
      allowedOrigins: [origin],
      tcp: {
        tokenSecret: secret,
        destinations: [{ ...target, connect: { host: "127.0.0.1", port: echoPort } }],
        limits: { windowBytes },
        webtransport: { host: "127.0.0.1", port: await udpPort(), rotationMs: 2000 },
        log: (entry) => logs.push(entry),
      },
    },
    {
      wallNow: () => wall,
      monotonicNow: () => performance.now(),
      scheduleCheck(callback) {
        scheduled = callback;
        return () => {
          scheduled = () => {};
        };
      },
      endpointStateChanged() {},
    },
  );
  relay = native.relay;
  await relay.tcp!.ready;
  const endpoint = `http://127.0.0.1:${await listen(relay.server)}/`;
  const token = await mintRelayToken(secret, {
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: "native-browser-fixture",
    dst: [target],
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => process.stderr.write(`${error.name}: ${error.message}\n`));
  await page.goto(origin);
  const results = await page.evaluate(
    async ({ endpoint, token, target }) => {
      const modulePath = "/client.js";
      const { createRelayConnect }: typeof import("../src/tcp-client.js") = await import(
        modulePath
      );
      const results: unknown[] = [];
      for (const carriers of [["webtransport"], ["websocket"]] satisfies (
        | "webtransport"
        | "websocket"
      )[][]) {
        const relay = createRelayConnect({
          endpoint,
          getToken: () => token,
          carriers,
          windowBytes: 16384,
        });
        try {
          const connections = await Promise.all(
            Array.from({ length: 3 }, () => relay.connect(target, new AbortController().signal)),
          );
          const echoes = await Promise.all(
            connections.map(async (stream, index) => {
              const writer = stream.writable.getWriter();
              const reader = stream.readable.getReader();
              const data = new TextEncoder().encode(`hello-${index}`);
              try {
                await writer.write(data);
              } catch (error) {
                throw new Error(`write-${index} ${String(error)}`);
              }
              try {
                await writer.close();
              } catch (error) {
                throw new Error(`fin-${index} ${String(error)}`);
              }
              const chunks: number[] = [];
              for (;;) {
                const next = await reader.read().catch((error) => {
                  throw new Error(`read-${index} ${String(error)}`);
                });
                if (next.done) break;
                chunks.push(...next.value);
              }
              return new TextDecoder().decode(new Uint8Array(chunks));
            }),
          );
          results.push({ carrier: relay.carrier, echoes });
        } finally {
          await relay.close();
        }
      }
      return results;
    },
    { endpoint, token, target },
  );
  assert.deepEqual(results, [
    { carrier: "webtransport", echoes: ["hello-0", "hello-1", "hello-2"] },
    { carrier: "websocket", echoes: ["hello-0", "hello-1", "hello-2"] },
  ]);
  const slowProof = await page.evaluate(
    async ({ endpoint, token, target }) => {
      const path = "/client.js";
      const module: typeof import("../src/tcp-client.js") = await import(path);
      const delay = (ms = 5500) => new Promise((resolve) => setTimeout(resolve, ms));
      const validReply = (bytes: Uint8Array) => bytes.every((byte) => byte === 7);
      const runs = (["webtransport", "websocket"] as const).flatMap((carrier) =>
        (["upload-first", "download-first"] as const).map(async (direction) => {
          const relay = module.createRelayConnect({
            endpoint,
            getToken: () => token,
            carriers: [carrier],
            windowBytes: 16384,
          });
          try {
            const stream = await relay.connect(target, new AbortController().signal);
            const writer = stream.writable.getWriter();
            const reader = stream.readable.getReader();
            const started = performance.now();
            await writer.write(
              new TextEncoder().encode(direction === "upload-first" ? "SLOWDOWN" : "SLOWUP"),
            );
            if (direction === "upload-first") await writer.close();
            let bytes = 0;
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              if (direction === "upload-first" && !validReply(next.value))
                throw new Error("slow reply corrupt");
              bytes += next.value.length;
            }
            if (direction === "download-first") {
              await delay();
              await writer.write(new Uint8Array(131072).fill(9));
              await writer.close();
            }
            const end = performance.now() + 4000;
            while (stream.counters.sendOutstandingBytes && performance.now() < end) await delay(1);
            if (stream.counters.sendOutstandingBytes)
              throw new Error("slow upload credit did not drain");
            return { carrier, direction, bytes, elapsedMs: performance.now() - started };
          } finally {
            await relay.close();
          }
        }),
      );
      return Promise.all(runs);
    },
    { endpoint, token, target },
  );
  for (const result of slowProof) {
    assert.ok(result.elapsedMs > 5000);
    assert.equal(result.bytes, result.direction === "upload-first" ? 131072 : 10);
  }
  assert.equal(slowReceipts.length, 2);
  for (const receipt of slowReceipts) assert.deepEqual(receipt, { bytes: 131072, valid: true });
  console.log(
    JSON.stringify({ slowHalfClose: slowProof, serverWindow: windowBytes, clientWindow: 16384 }),
  );
  const errorsRelay = createNativeRelay(
    {
      credential: "separate-errors-http-credential",
      allowedOrigins: [origin],
      tcp: {
        tokenSecret: secret,
        destinations: [{ ...target, connect: { host: "127.0.0.1", port: echoPort } }],
        limits: { maxConnections: 1, idleTimeoutMs: 300 },
        webtransport: { host: "127.0.0.1", port: await udpPort() },
        log: (event) => logs.push(event),
      },
    },
    {
      wallNow: Date.now,
      monotonicNow: () => performance.now(),
      scheduleCheck() {
        return () => {};
      },
      endpointStateChanged() {},
    },
  ).relay;
  try {
    await errorsRelay.tcp!.ready;
    const errorsEndpoint = `http://127.0.0.1:${await listen(errorsRelay.server)}/`;
    const raw = await page.evaluateHandle(
      async ({ endpoint, token, target }) => {
        const config = await fetch(`${endpoint}v1/tcp/session`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }).then((response) => response.json());
        const hashes = config.webtransport.certificateHashes.map(
          (hash: { algorithm: string; value: string }) => ({
            algorithm: hash.algorithm,
            value: Uint8Array.from(atob(hash.value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
              char.charCodeAt(0),
            ),
          }),
        );
        const session = new WebTransport(config.webtransport.url, {
          serverCertificateHashes: hashes,
        });
        void session.closed.catch(() => {});
        await session.ready;
        const code = (error: unknown) =>
          error && typeof error === "object" && "streamErrorCode" in error
            ? error.streamErrorCode
            : null;
        const open = async () => {
          const stream = await session.createBidirectionalStream();
          const writer = stream.writable.getWriter(),
            reader = stream.readable.getReader();
          void writer.closed.catch(() => {});
          void reader.closed.catch(() => {});
          const json = new TextEncoder().encode(
            JSON.stringify({ v: 1, token, ...target, window: 262144 }),
          );
          const header = new Uint8Array(json.length + 2);
          new DataView(header.buffer).setUint16(0, json.length);
          header.set(json, 2);
          for (const byte of header) await writer.write(Uint8Array.of(byte));
          let reply = new Uint8Array();
          while (reply.length < 2 || reply.length < new DataView(reply.buffer).getUint16(0) + 2) {
            const next = await reader.read();
            if (next.done) throw new Error("missing reply");
            const merged = new Uint8Array(reply.length + next.value.length);
            merged.set(reply);
            merged.set(next.value, reply.length);
            reply = merged;
          }
          const result = JSON.parse(new TextDecoder().decode(reply.subarray(2)));
          if (!result.ok) throw new Error("raw open denied");
          return { reader, writer };
        };
        const first = await open();
        const excess = await session.createBidirectionalStream();
        const reader = excess.readable.getReader();
        void reader.closed.catch(() => {});
        void excess.writable
          .getWriter()
          .write(Uint8Array.of(0))
          .catch(() => {});
        let limitCode;
        try {
          await reader.read();
        } catch (error) {
          limitCode = code(error);
        }
        let idleCode;
        try {
          await first.reader.read();
        } catch (error) {
          idleCode = code(error);
        }
        return { session, open, code, limitCode, idleCode };
      },
      { endpoint: errorsEndpoint, token, target },
    );
    const early = await raw.evaluate((state) => ({
      limitCode: state.limitCode,
      idleCode: state.idleCode,
    }));
    assert.deepEqual(early, { limitCode: 3, idleCode: 2 });
    const resetCode = await raw.evaluate(async (state) => {
      const stream = await state.open();
      const payload = new TextEncoder().encode("RESET");
      const frame = new Uint8Array(payload.length + 5);
      new DataView(frame.buffer).setUint32(1, payload.length);
      frame.set(payload, 5);
      await stream.writer.write(frame);
      try {
        await stream.reader.read();
        return null;
      } catch (error) {
        return state.code(error);
      }
    });
    assert.equal(resetCode, 1);
    const shutdown = await raw.evaluateHandle(async (state) => ({
      reader: (await state.open()).reader,
      code: state.code,
    }));
    errorsRelay.revoke();
    const shutdownCode = await shutdown.evaluate(async (state) => {
      try {
        await state.reader.read();
        return null;
      } catch (error) {
        return state.code(error);
      }
    });
    assert.equal(shutdownCode, 4);
    await shutdown.dispose();
    await raw.evaluate((state) => state.session.close());
    await raw.dispose();
    console.log(
      JSON.stringify({
        resetCodes: {
          target: resetCode,
          limit: early.limitCode,
          idle: early.idleCode,
          shutdown: shutdownCode,
        },
        fragmentedRequestHeader: "one byte per write",
      }),
    );
  } finally {
    await errorsRelay.close();
  }
  const accounting: unknown[] = [];
  for (const carrier of ["webtransport", "websocket"] as const) {
    const flow: JSHandle<{ relay: ClientRelay; reader: ReadableStreamDefaultReader<Uint8Array> }> =
      await page.evaluateHandle(
        async ({
          endpoint,
          token,
          target,
          carrier,
          windowBytes,
        }: {
          endpoint: string;
          token: string;
          target: { host: string; port: number };
          carrier: "webtransport" | "websocket";
          windowBytes: number;
        }) => {
          const path = "/client.js";
          const module: typeof import("../src/tcp-client.js") = await import(path);
          const relay = module.createRelayConnect({
            endpoint,
            getToken: () => token,
            carriers: [carrier],
            windowBytes,
          });
          const stream = await relay.connect(target, new AbortController().signal);
          const writer = stream.writable.getWriter();
          await writer.write(new TextEncoder().encode("BULK"));
          await writer.close();
          return { relay, reader: stream.readable.getReader() };
        },
        { endpoint, token, target, carrier, windowBytes },
      );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const paused: readonly TcpQueueCounters[] = relay.tcp!.counters;
    assert.ok(paused.length > 0);
    for (const counter of paused) {
      assert.ok(counter.toTargetBytes <= windowBytes);
      assert.ok(counter.toClientBytes <= windowBytes);
      assert.ok(counter.readAheadBytes <= 65536);
    }
    const received = await flow.evaluate(async (state) => {
      let count = 0;
      for (;;) {
        const next = await state.reader.read();
        if (next.done) break;
        if (next.value.some((byte) => byte !== 7)) throw new Error("corrupt bulk payload");
        count += next.value.length;
      }
      await state.relay.close();
      return count;
    });
    assert.equal(received, 64 * 1024 * 1024);
    await flow.dispose();
    accounting.push({ carrier, pausedReader: paused, bytes: received });
    pauseTargets = true;
    const upload: JSHandle<{
      relay: ClientRelay;
      stream: TcpStream;
      settled: boolean;
      write: Promise<void>;
      received: Promise<number>;
    }> = await page.evaluateHandle(
      async ({
        endpoint,
        token,
        target,
        carrier,
        windowBytes,
      }: {
        endpoint: string;
        token: string;
        target: { host: string; port: number };
        carrier: "webtransport" | "websocket";
        windowBytes: number;
      }) => {
        const path = "/client.js";
        const module: typeof import("../src/tcp-client.js") = await import(path);
        const relay = module.createRelayConnect({
          endpoint,
          getToken: () => token,
          carriers: [carrier],
          windowBytes,
        });
        const stream = await relay.connect(target, new AbortController().signal);
        const writer = stream.writable.getWriter(),
          reader = stream.readable.getReader();
        const result = {
          relay,
          stream,
          settled: false,
          write: Promise.resolve(),
          received: Promise.resolve(0),
        };
        result.received = (async () => {
          let count = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) return count;
            if (next.value.some((byte) => byte !== 0)) throw new Error("upload echo corrupt");
            count += next.value.length;
          }
        })();
        result.write = (async () => {
          const bytes = new Uint8Array(65536);
          for (let offset = 0; offset < 64 * 1024 * 1024; offset += bytes.length)
            await writer.write(bytes);
          await writer.close();
          result.settled = true;
        })();
        void result.write.catch(() => {});
        return result;
      },
      { endpoint, token, target, carrier, windowBytes },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    console.log(
      JSON.stringify({
        pausedUpload: {
          carrier,
          settled: await upload.evaluate((state) => state.settled),
          counters: relay.tcp!.counters,
        },
      }),
    );
    assert.equal(await upload.evaluate((state) => state.settled), false);
    const targetPaused: readonly TcpQueueCounters[] = relay.tcp!.counters;
    for (const counter of targetPaused) assert.ok(counter.toTargetBytes <= windowBytes);
    pauseTargets = false;
    for (const socket of sockets) socket.resume();
    const receivedUpload = await upload.evaluate(async (state) => {
      await state.write;
      const count = await state.received;
      await state.relay.close();
      return count;
    });
    assert.equal(receivedUpload, 64 * 1024 * 1024);
    await upload.dispose();
    accounting.push({ carrier, pausedTarget: targetPaused, bytes: receivedUpload });
  }
  console.log(JSON.stringify({ accounting }, null, 2));
  const held = await page.evaluateHandle(
    async ({ endpoint, token, target }) => {
      const path = "/client.js";
      const module: typeof import("../src/tcp-client.js") = await import(path);
      const wt = module.createRelayConnect({
        endpoint,
        getToken: () => token,
        carriers: ["webtransport"],
      });
      const ws = module.createRelayConnect({
        endpoint,
        getToken: () => token,
        carriers: ["websocket"],
      });
      const a = await wt.connect(target, new AbortController().signal);
      const b = await ws.connect(target, new AbortController().signal);
      const writer = b.writable.getWriter(),
        reader = b.readable.getReader();
      const before = await fetch(`${endpoint}v1/tcp/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).then((response) => response.json());
      return {
        wt,
        ws,
        original: a.readable.getReader(),
        writer,
        reader,
        before,
        endpoint,
        token,
        target,
      };
    },
    { endpoint, token, target },
  );
  const cycles: unknown[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const previous = native.lifecycle().status().generation;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    wall = Date.now();
    scheduled();
    assert.equal(native.lifecycle().discovery(), null);
    const healthGap = await fetch(`${endpoint}readyz`);
    assert.equal(healthGap.status, 503);
    const limit = Date.now() + 12000;
    while (native.lifecycle().status().generation === previous && Date.now() < limit)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(native.lifecycle().status().state, "serving");
    const proof = await held.evaluate(async (state, cycle) => {
      let reset = "";
      if (!cycle) {
        try {
          await state.original.read();
        } catch (error) {
          reset = error instanceof Error ? error.message : String(error);
        }
      }
      await state.writer.write(new TextEncoder().encode(`websocket-survived-${cycle}`));
      const echo = new TextDecoder().decode((await state.reader.read()).value);
      const current = await fetch(`${state.endpoint}v1/tcp/session`, {
        method: "POST",
        cache: "no-store",
        headers: { authorization: `Bearer ${state.token}` },
      }).then((response) => response.json());
      const fresh = await state.wt.connect(state.target, new AbortController().signal);
      const writer = fresh.writable.getWriter(),
        reader = fresh.readable.getReader();
      await writer.write(new TextEncoder().encode("new-certificate"));
      await writer.close();
      const bytes: number[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes.push(...next.value);
      }
      const oldHash = state.before.webtransport.certificateHashes[0].value;
      const newHash = current.webtransport.certificateHashes[0].value;
      const old = new WebTransport(current.webtransport.url, {
        serverCertificateHashes: [
          {
            algorithm: "sha-256",
            value: Uint8Array.from(atob(oldHash.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
              char.charCodeAt(0),
            ),
          },
        ],
      });
      void old.closed.catch(() => {});
      let oldAccepted = false;
      try {
        await old.ready;
        oldAccepted = true;
      } catch {
      } finally {
        old.close();
      }
      state.before = current;
      return {
        reset,
        echo,
        oldHash,
        newHash,
        oldAccepted,
        newEcho: new TextDecoder().decode(new Uint8Array(bytes)),
      };
    }, cycle);
    assert.notEqual(proof.oldHash, proof.newHash);
    assert.equal(proof.oldAccepted, false);
    assert.equal(proof.newEcho, "new-certificate");
    assert.equal(proof.echo, `websocket-survived-${cycle}`);
    if (!cycle) assert.equal(proof.reset, "ECONNRESET");
    cycles.push({
      cycle: cycle + 1,
      ...proof,
      fds: readdirSync("/proc/self/fd").length,
      resources: process.getActiveResourcesInfo(),
      ownedEndpoints: native.lifecycle().status().ownedEndpoints,
    });
  }
  await held.evaluate(async (state) => {
    await state.wt.close();
    await state.ws.close();
  });
  await held.dispose();
  console.log(JSON.stringify({ cycles }, null, 2));
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
        browser: browser.version(),
        results,
        logEvents: logs.map(({ event, carrier, reason }) => ({ event, carrier, reason })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  await cleanup();
  console.log(JSON.stringify({ failureLogs: logs }, null, 2));
  throw error;
} finally {
  clearTimeout(timeout);
  await cleanup();
  console.log(
    JSON.stringify({
      cleanup: "complete",
      targetSockets: sockets.size,
      active: relay?.tcp?.active ?? 0,
    }),
  );
}
