import { createRuntime, type RuntimeNetwork } from "../index.js";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";
import { networkFlowCases } from "./network-flow-cases.js";
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
function guest(
  network: RuntimeNetwork,
  router: PreviewRouter,
  startupFailurePort = 0,
  failPublication = false,
) {
  const ring = createRing();
  const worker = new Worker("/network-worker.js", {
    type: "module",
  });
  const hooks = {
    listening: (port: number) => {
      router.register(port, helper);
      if (failPublication) throw Error("Observer failed");
    },
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
  const deliver = (request: import("../browser/net/protocol.js").NetRequest) => {
    try {
      helper.handle(request);
    } catch (error) {
      if (!failPublication || !(error instanceof Error) || error.message !== "Observer failed")
        retire(Error(String(error)));
    }
  };
  worker.onmessage = (event: MessageEvent<NetworkWorkerMessage>) => {
    if (retired) return;
    const msg = event.data;
    if (msg.kind === "net") {
      deliver(msg.request);
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
  worker.postMessage({ kind: "init", ring, failPort: startupFailurePort });
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

async function addressCases(server: Guest, client: Guest): Promise<void> {
  const listener = number(await server.call({ op: "listen", host: "::", port: 32157 }));
  check(listener > 0, "IPv6 listener failed");
  const address = { address: "::", family: "IPv6", port: 32157 };
  check(
    (await server.call({ op: "addr", handle: listener })) === JSON.stringify(address),
    "IPv6 wildcard bind metadata lost",
  );
  for (const host of ["::1", "127.0.0.1"]) {
    const conn = number(await client.call({ op: "connect", host, port: 32157 }));
    check(conn > 0, "Dual-stack virtual connect failed");
    const accepted = number(
      await until(
        () => server.call({ op: "accept", handle: listener }),
        (value) => typeof value === "number" && value > 0,
      ),
    );
    const local = {
      address: host === "::1" ? "::1" : "::ffff:127.0.0.1",
      family: "IPv6",
      port: 32157,
    };
    check(
      (await server.call({ op: "addr", handle: accepted })) === JSON.stringify(local),
      "Accepted local address differs",
    );
    const clientLocal = JSON.parse(String(await client.call({ op: "addr", handle: conn })));
    const peer = { ...local, port: clientLocal.port };
    check(
      (await server.call({ op: "peer", handle: accepted })) === JSON.stringify(peer),
      "Accepted peer family or address differs",
    );
    await client.call({ op: "write", handle: conn, bytes: bytes("ipv6") });
    check(text(await read(server, accepted)) === "ipv6", "IPv6 metadata path lost data");
    await client.call({ op: "close", handle: conn });
    await server.call({ op: "close", handle: accepted });
  }
  await server.call({ op: "close", handle: listener });
  const loopback = number(await server.call({ op: "listen", host: "::1", port: 32157 }));
  check(loopback > 0, "IPv6 loopback listener failed");
  check(
    (await client.call({ op: "connect", host: "127.0.0.1", port: 32157 })) === -1,
    "IPv4 reached IPv6 loopback-only bind",
  );
  await server.call({ op: "close", handle: loopback });
  check(
    (await server.call({ op: "listen", host: "192.0.2.1", port: 32157 })) === -4,
    "Browser claimed an external bind",
  );
}

async function fetchAddressCases(server: Guest, client: Guest): Promise<void> {
  for (const [bind, target] of [
    ["::1", "127.0.0.1"],
    ["127.0.0.1", "[::1]"],
  ]) {
    const listener = number(await server.call({ op: "listen", host: bind, port: 32158 }));
    check(listener > 0, "HTTP family-refusal listener failed");
    const fetched = number(await client.call({ op: "fetch", url: `http://${target}:32158/` }));
    const head = await until(
      () => client.call({ op: "head", handle: fetched }),
      (value) => value !== -2,
    );
    check(head === -1, "Incompatible virtual HTTP did not fail");
    check(
      String(await client.call({ op: "error", handle: fetched })).includes("ECONNREFUSED"),
      "Virtual HTTP refused without its terminal connection error",
    );
    check(
      (await server.call({ op: "accept", handle: listener })) === -2,
      "Incompatible virtual HTTP allocated an accepted socket",
    );
    await client.call({ op: "close", handle: fetched });
    await server.call({ op: "close", handle: listener });
  }
  const listener = number(await server.call({ op: "listen", host: "::", port: 32158 }));
  check(listener > 0, "HTTP dual-stack listener failed");
  for (const target of ["127.0.0.1", "[::1]"]) {
    const fetched = number(
      await client.call({ op: "fetch", url: `http://${target}:32158/family` }),
    );
    const accepted = number(
      await until(
        () => server.call({ op: "accept", handle: listener }),
        (value) => typeof value === "number" && value > 0,
      ),
    );
    const local = {
      address: target === "127.0.0.1" ? "::ffff:127.0.0.1" : "::1",
      family: "IPv6",
      port: 32158,
    };
    check(
      (await server.call({ op: "addr", handle: accepted })) === JSON.stringify(local),
      "Virtual HTTP lost its accepted local destination family",
    );
    const peer = JSON.parse(String(await server.call({ op: "peer", handle: accepted })));
    check(
      peer.address === local.address && peer.family === local.family && peer.port > 0,
      "Virtual HTTP lost its accepted peer destination family",
    );
    check(
      text(await read(server, accepted)).startsWith("GET /family HTTP/1.1\r\n"),
      "Virtual HTTP request did not reach the accepted endpoint",
    );
    const response = bytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    check(
      (await server.call({ op: "write", handle: accepted, bytes: response })) === response.length,
      "Virtual HTTP response write failed",
    );
    await server.call({ op: "shutdown", handle: accepted });
    const head = await until(
      () => client.call({ op: "head", handle: fetched }),
      (value) => value !== -2,
    );
    check(JSON.parse(text(head)).status === 200, "Virtual HTTP response head failed");
    check(text(await read(client, fetched)) === "ok", "Virtual HTTP response body failed");
    check((await read(client, fetched)) === 0, "Virtual HTTP response did not terminate");
    await client.call({ op: "close", handle: fetched });
    await server.call({ op: "close", handle: accepted });
  }
  await server.call({ op: "close", handle: listener });
}

/** Executed in a real browser by network-browser-runner.ts. */
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
  const make = (space = network, startupFailurePort = 0, failPublication = false) => {
    const item = guest(space, router, startupFailurePort, failPublication);
    guests.push(item);
    return item;
  };
  const server = make(),
    client = make(),
    survivor = make(),
    isolated = make(isolatedNetwork);
  try {
    await Promise.all(guests.map((item) => item.ready));
    await addressCases(server, client);
    await fetchAddressCases(server, client);
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
    const flowServer = make(),
      flowClient = make(),
      badPublisher = make(network, 0, true);
    await Promise.all([flowServer.ready, flowClient.ready, badPublisher.ready]);
    check(
      (await badPublisher.call({ op: "listen", port: 32136 })) === -1,
      "Throwing hook reported successful bind",
    );
    check(
      number(await flowClient.call({ op: "listen", port: 32136 })) > 0,
      "Throwing hook leaked its reservation",
    );
    await networkFlowCases(flowServer, flowClient, 32137);
    await networkFlowCases(flowServer, flowServer, 32138);
    return [
      "IPv6 wildcard, loopback, mapped addresses and HTTP destination families across real workers",
      "paused HTTP bounded credit, read wakeups, streaming EOF and cancellation across workers and within one worker",
      "throwing listening hook rolls back publication before a healthy worker retry",
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
