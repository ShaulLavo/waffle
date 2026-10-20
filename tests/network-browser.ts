import { createRuntime, type RuntimeNetwork } from "../index.js";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";
import { createRing } from "../browser/net/ring.js";
import { PreviewRouter } from "../browser/preview.js";
import { activated } from "../browser/service-worker.js";
import type { NetworkCommand, NetworkWorkerMessage } from "./network-browser-worker.js";
import type { PreviewMessage } from "../browser/preview-protocol.js";

const bytes = (value: string) => new TextEncoder().encode(value);
function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function number(value: unknown): number {
  check(typeof value === "number", "Expected numeric handle");
  return value;
}
function text(value: unknown): string {
  check(value instanceof Uint8Array, "Expected byte payload");
  return new TextDecoder().decode(value);
}
async function until(
  read: () => Promise<unknown>,
  ready: (value: unknown) => boolean,
): Promise<unknown> {
  for (let n = 0; n < 300; n++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Browser network progress timed out");
}

type Guest = ReturnType<typeof guest>;
function guest(network: RuntimeNetwork, router: PreviewRouter, startupFailurePort = 0) {
  const ring = createRing();
  const worker = new Worker(`/network-worker.js?failPort=${startupFailurePort}`, {
    type: "module",
  });
  const hooks = {
    listening: (port: number) => router.register(port, helper),
    stopped: (port: number) => router.unregister(port, helper),
  };
  const helper = network.createHelper({
    ring,
    fetch: async () => {
      throw Error("External fetch forbidden");
    },
    hooks,
  });
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let next = 0;
  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  let retired = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const startupTimer = setTimeout(() => retire(Error("Worker startup timed out")), 15000);
  const retire = (reason = Error("Worker terminated")) => {
    if (retired) return;
    retired = true;
    clearTimeout(startupTimer);
    readyReject(reason);
    helper.dispose();
    worker.terminate();
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(Error("Worker terminated"));
    }
    pending.clear();
  };
  worker.onerror = (event) => {
    event.preventDefault();
    retire(Error(event.message));
  };
  worker.onmessageerror = () => retire(Error("Worker message could not be read"));
  worker.onmessage = (event: MessageEvent<NetworkWorkerMessage>) => {
    if (retired) return;
    const msg = event.data;
    if (msg.kind === "net") {
      helper.handle(msg.request);
      return;
    }
    if (msg.kind === "ready") {
      clearTimeout(startupTimer);
      readyResolve();
      return;
    }
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.kind === "error") call.reject(Error(msg.message));
    else call.resolve(msg.value);
  };
  worker.postMessage({ kind: "init", ring });
  const expire = (id: number, op: string, reject: (error: Error) => void) => {
    pending.delete(id);
    reject(Error(`Worker command ${op} timed out`));
  };
  return {
    ready,
    retire,
    call(command: NetworkCommand): Promise<unknown> {
      if (retired) return Promise.reject(Error("Worker terminated"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => expire(id, command.op, reject), 15000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: "command", id, command });
      });
    },
  };
}
async function pair(server: Guest, client: Guest, port: number) {
  const listener = number(await server.call({ op: "listen", port }));
  check(listener > 0, "Listener failed");
  const conn = number(await client.call({ op: "connect", port }));
  check(conn > 0, "Cross-worker connect failed");
  const accepted = number(
    await until(
      () => server.call({ op: "accept", handle: listener }),
      (v) => typeof v === "number" && v > 0,
    ),
  );
  return { listener, conn, accepted };
}
async function read(guest: Guest, handle: number): Promise<unknown> {
  return until(
    () => guest.call({ op: "read", handle, cap: 65536 }),
    (v) => v !== -2,
  );
}

/** @browserEntry Executed in a real browser by network-browser-runner.ts. */
export async function networkBrowserCases(): Promise<string[]> {
  const runtime = createRuntime({
    filesystem: { workerURL: "/network-fs.js", mode: "memory" },
    processHost() {
      throw Error("Networking activated processes");
    },
  });
  const network = await runtime.network();
  const isolatedNamespace = new NetNamespace();
  const isolatedNetwork: RuntimeNetwork = {
    createHelper: ({ ring, fetch, hooks }) => new NetHelper(ring, fetch, hooks, isolatedNamespace),
  };
  const router = new PreviewRouter({ baseURL: location.origin, prefix: "/_net" });
  const guests: Guest[] = [];
  let registration: ServiceWorkerRegistration | undefined;
  const route = (event: MessageEvent<PreviewMessage>) => router.onMessage(event);
  navigator.serviceWorker.addEventListener("message", route);
  const make = (space = network, startupFailurePort = 0) => {
    const item = guest(space, router, startupFailurePort);
    guests.push(item);
    return item;
  };
  const server = make(),
    client = make(),
    survivor = make(),
    isolated = make(isolatedNetwork);
  try {
    await Promise.all(guests.map((item) => item.ready));
    const p = await pair(server, client, 32130);
    check(
      (await client.call({ op: "addr", handle: p.conn })) ===
        (await server.call({ op: "peer", handle: p.accepted })),
      "Accept peer identity differs",
    );
    check((await client.call({ op: "listen", port: 32130 })) === -1, "Duplicate bind succeeded");
    check((await isolated.call({ op: "connect", port: 32130 })) === -1, "Runtime namespace leaked");
    check(
      (await client.call({ op: "write", handle: p.conn, bytes: bytes("worker request") })) === 14,
      "Client write failed",
    );
    await client.call({ op: "shutdown", handle: p.conn });
    check(
      text(await read(server, p.accepted)) === "worker request",
      "Cross-worker request corrupted",
    );
    check((await read(server, p.accepted)) === 0, "Half-close EOF missing");
    await server.call({ op: "write", handle: p.accepted, bytes: bytes("worker reply") });
    check(text(await read(client, p.conn)) === "worker reply", "Cross-worker response corrupted");
    await server.call({ op: "close", handle: p.listener });
    check((await client.call({ op: "connect", port: 32130 })) === -1, "Closed listener survived");
    const independent = await pair(survivor, client, 32131);
    const dyingListener = number(await server.call({ op: "listen", port: 32133 }));
    check(dyingListener > 0, "Abrupt-exit listener failed");
    server.retire();
    check(
      (await client.call({ op: "connect", port: 32133 })) === -1,
      "Owner-exit listener survived",
    );
    check((await read(client, p.conn)) === 0, "Abrupt owner exit did not signal EOF");
    check(
      (await client.call({ op: "write", handle: independent.conn, bytes: bytes("unrelated") })) ===
        9,
      "Unrelated owner socket died",
    );
    check(
      text(await read(survivor, independent.accepted)) === "unrelated",
      "Unrelated owner lost bytes",
    );
    const http = make();
    await http.ready;
    const listener = number(await http.call({ op: "listen", port: 32132 }));
    registration = await navigator.serviceWorker.register("/network-sw.js", {
      scope: "/",
      type: "module",
    });
    await activated(registration);
    await until(
      () => Promise.resolve(navigator.serviceWorker.controller),
      (value) => value !== null,
    );
    const serving = http.call({ op: "serve", listener });
    void serving.catch(() => {});
    const payload = `request-${crypto.randomUUID()}`;
    const response = await fetch("/_net/32132/render?version=1", { method: "POST", body: payload });
    check(response.status === 200, `Preview returned ${response.status}`);
    const result = await response.json();
    check(
      result.first === "POST /render?version=1 HTTP/1.1" && result.body === payload,
      "Service-worker HTTP did not reach the guest",
    );
    const received = await serving;
    check(
      typeof received === "string" && received.endsWith(payload),
      "Worker did not receive HTTP payload",
    );
    const httpClient = make();
    await httpClient.ready;
    const servingTcp = http.call({ op: "serve", listener });
    void servingTcp.catch(() => {});
    const conn = number(await httpClient.call({ op: "connect", port: 32132 }));
    await httpClient.call({
      op: "write",
      handle: conn,
      bytes: bytes("GET /worker-http HTTP/1.1\r\nHost: localhost\r\n\r\n"),
    });
    const raw = text(await read(httpClient, conn));
    check(
      raw.includes('"first":"GET /worker-http HTTP/1.1"'),
      "TCP HTTP response did not cross rings",
    );
    await servingTcp;
    const failed = make(network, 32134);
    let startupFailed = false;
    try {
      await failed.ready;
    } catch {
      startupFailed = true;
    }
    check(startupFailed, "Injected worker startup unexpectedly succeeded");
    check(
      (await client.call({ op: "connect", port: 32134 })) === -1,
      "Failed startup left a listener",
    );
    check(
      number(await client.call({ op: "listen", port: 32134 })) > 0,
      "Failed startup leaked its port",
    );
    return [
      "real worker duplex, peer identity and half-close",
      "bind conflict and namespace isolation",
      "failed startup, abrupt owner exit and unrelated socket survival",
      "HTTP over service-worker preview and cross-worker TCP",
    ];
  } finally {
    for (const item of guests) item.retire();
    await registration?.unregister();
    navigator.serviceWorker.removeEventListener("message", route);
    await runtime.dispose();
  }
}
