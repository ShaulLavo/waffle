import type { NetworkCommand } from "./network-browser-worker.js";

export interface NetworkPeer {
  call(command: NetworkCommand): Promise<unknown>;
}
const bytes = new Uint8Array(65536).fill(65);
function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function number(value: unknown): number {
  check(typeof value === "number", "Expected numeric result");
  return value;
}
async function accepted(server: NetworkPeer, listener: number): Promise<number> {
  for (let n = 0; n < 300; n++) {
    const handle = number(await server.call({ op: "accept", handle: listener }));
    if (handle > 0) return handle;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw Error("No HTTP accept");
}
async function start(
  server: NetworkPeer,
  client: NetworkPeer,
  listener: number,
  port: number,
  head: string,
) {
  const fetch = number(await client.call({ op: "fetch", url: `http://localhost:${port}/stream` }));
  check(fetch > 0, "Fetch allocation failed");
  const socket = await accepted(server, listener);
  const encoded = new TextEncoder().encode(head);
  check(
    (await server.call({ op: "write", handle: socket, bytes: encoded })) === encoded.length,
    "HTTP head write failed",
  );
  return { fetch, socket };
}
async function fill(server: NetworkPeer, socket: number) {
  let total = 0;
  for (let n = 0; n < 256; n++) {
    const count = number(await server.call({ op: "write", handle: socket, bytes }));
    if (count === -2) return total;
    check(count > 0, "Response write failed before backpressure");
    total += count;
  }
  throw Error(`No backpressure after ${total} bytes without a client read`);
}
async function drainEvents(server: NetworkPeer) {
  for (let n = 0; n < 300; n++) {
    if ((await server.call({ op: "poll", handle: 0 })) === 0) return;
  }
  throw Error("Worker ring did not settle");
}
async function firstRead(client: NetworkPeer, fetch: number): Promise<number> {
  for (let n = 0; n < 300; n++) {
    const chunk = await client.call({ op: "read", handle: fetch, cap: 65536 });
    if (chunk === -2) continue;
    check(chunk instanceof Uint8Array && chunk.length > 0, "No streamed response before EOF");
    check(
      chunk.every((value) => value === 65),
      "Response bytes changed",
    );
    return chunk.length;
  }
  throw Error("No response progress");
}
async function writable(server: NetworkPeer) {
  for (let n = 0; n < 300; n++) {
    if ((await server.call({ op: "poll", handle: 0 })) === 1) return;
  }
  throw Error("Read did not wake the writer ring");
}
async function complete(
  server: NetworkPeer,
  client: NetworkPeer,
  socket: number,
  fetch: number,
  sent: number,
  received: number,
  length: number,
) {
  for (let n = 0; n < 1000; n++) {
    if (sent < length) {
      const count = number(
        await server.call({
          op: "write",
          handle: socket,
          bytes: bytes.subarray(0, Math.min(bytes.length, length - sent)),
        }),
      );
      check(count === -2 || count > 0, "Streaming write failed");
      if (count > 0) sent += count;
    }
    const chunk = await client.call({ op: "read", handle: fetch, cap: 65536 });
    if (chunk === -2) continue;
    if (chunk === 0) {
      check(sent === length && received === length, "Early HTTP EOF");
      return;
    }
    check(
      chunk instanceof Uint8Array && chunk.every((value) => value === 65),
      "Streaming bytes changed",
    );
    received += chunk.length;
  }
  throw Error("Streaming response did not complete");
}

/** Runs unchanged against actual Bun Workers and browser Workers, never a Node-hosted engine. */
export async function networkFlowCases(
  server: NetworkPeer,
  client: NetworkPeer,
  port: number,
): Promise<number> {
  const listener = number(await server.call({ op: "listen", port }));
  check(listener > 0, "HTTP listener failed");
  const length = (2 << 20) + 12345;
  const stream = await start(
    server,
    client,
    listener,
    port,
    `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\n\r\n`,
  );
  const sent = await fill(server, stream.socket);
  check(sent <= (1 << 20) + (512 << 10), `Read-free buffering exceeded existing windows: ${sent}`);
  await drainEvents(server);
  const received = await firstRead(client, stream.fetch);
  await writable(server);
  await complete(server, client, stream.socket, stream.fetch, sent, received, length);
  await server.call({ op: "close", handle: stream.socket });

  const cancelled = await start(server, client, listener, port, "HTTP/1.1 200 OK\r\n\r\n");
  await fill(server, cancelled.socket);
  await drainEvents(server);
  await client.call({ op: "close", handle: cancelled.fetch });
  await writable(server);
  check(
    (await server.call({ op: "write", handle: cancelled.socket, bytes })) === -1,
    "Cancelled fetch left its socket writable",
  );
  await server.call({ op: "close", handle: cancelled.socket });
  await server.call({ op: "close", handle: listener });
  return sent;
}
