import { expect, test } from "bun:test";
import { PreviewRouter, type PreviewServer } from "../browser/preview";
import {
  activated,
  createPreviewServiceWorker,
  type PreviewClient,
} from "../browser/service-worker";

const scope = "https://example.test/nested/custom.preview/";
const encoder = new TextEncoder();

function fixture(response = "hello") {
  let lastRequest: unknown;
  let lastPort = 0;
  const server: PreviewServer = {
    request(port, request, sink) {
      lastPort = port;
      lastRequest = request;
      queueMicrotask(() => {
        sink.head({
          status: 200,
          statusText: "OK",
          headers: [
            ["content-type", "text/plain"],
            ["transfer-encoding", "chunked"],
            ["content-length", "999"],
          ],
        });
        sink.data(encoder.encode(response));
        sink.end();
      });
      return true;
    },
    connect(_port, sink) {
      return {
        write(bytes) {
          sink.data(bytes.slice());
        },
        close() {
          sink.end();
        },
      };
    },
  };
  const router = new PreviewRouter({
    baseURL: "https://example.test/nested/index.html",
    prefix: "custom.preview",
  });
  router.register(8123, server);
  const page: PreviewClient = {
    url: "https://example.test/nested/index.html",
    postMessage(data, ports) {
      router.onMessage({ data, ports });
    },
  };
  const preview = { ...page, url: `${scope}8123/page` };
  const worker = createPreviewServiceWorker({
    scope,
    clients: {
      async get(id) {
        return id === "preview" ? preview : page;
      },
      async matchAll() {
        return [preview, page];
      },
    },
    fetch: async () => new Response("network"),
  });
  return {
    router,
    worker,
    page,
    server,
    get lastRequest() {
      return lastRequest;
    },
    get lastPort() {
      return lastPort;
    },
  };
}

test("preview routing uses injected nested mount, preserves queries, and streams HTTP", async () => {
  const f = fixture();
  expect(f.router.url(8123, "/hello?q=1")).toBe(`${scope}8123/hello?q=1`);
  const response = await f.worker.fetch(
    new Request(`${scope}8123/hello?q=1`, { method: "POST", body: "input" }),
    "",
  );
  expect(response?.status).toBe(200);
  expect(response?.headers.get("transfer-encoding")).toBeNull();
  expect(response?.headers.get("content-length")).toBeNull();
  expect(await response?.text()).toBe("hello");
  expect(f.lastPort).toBe(8123);
  expect(f.lastRequest).toMatchObject({
    method: "POST",
    target: "/hello?q=1",
    body: encoder.encode("input"),
  });
});

test("root-relative requests use their preview client's port, not application policy", async () => {
  const f = fixture();
  expect(
    await (
      await f.worker.fetch(new Request("https://example.test/style.css?v=2"), "preview")
    )?.text(),
  ).toBe("hello");
  expect(f.lastRequest).toMatchObject({ target: "/style.css?v=2" });
  expect(
    await (await f.worker.fetch(new Request("https://example.test/app.css"), "page"))?.text(),
  ).toBe("network");
  expect(f.worker.fetch(new Request("https://other.test/style.css"), "preview")).toBeUndefined();
  expect(f.worker.fetch(new Request("https://example.test/uncontrolled"), "")).toBeUndefined();
  expect(
    f.worker.fetch(new Request("https://example.test/nested/customXpreview/8123/"), ""),
  ).toBeUndefined();
});

test("non-preview fallback calls an injected fetch without an options receiver", async () => {
  let received: Request | undefined;
  const worker = createPreviewServiceWorker({
    scope,
    clients: {
      async get() {
        return { url: "https://example.test/app", postMessage() {} };
      },
      async matchAll() {
        return [];
      },
    },
    fetch: async function (this: undefined, request: Request) {
      if (this !== undefined)
        throw new TypeError("Illegal invocation: fetch received an options receiver");
      received = request;
      return new Response("native-style fetch");
    },
  });
  const request = new Request("https://example.test/app.css");
  const response = await worker.fetch(request, "application");
  expect(await response?.text()).toBe("native-style fetch");
  expect(received).toBe(request);
});

test("replacing a registered server preserves it when an older owner unregisters", () => {
  const f = fixture();
  const replacement = { ...f.server };
  f.router.register(8123, replacement);
  f.router.unregister(8123, f.server);
  expect(f.router.serves(8123)).toBe(true);
  f.router.unregister(8123, replacement);
  expect(f.router.serves(8123)).toBe(false);
});

test("generic worker exposes response policy injection without Bun socket script policy", async () => {
  const f = fixture();
  const worker = createPreviewServiceWorker({
    scope,
    clients: {
      async get() {
        return undefined;
      },
      async matchAll() {
        return [f.page];
      },
    },
    fetch,
    transformResponse(response, port) {
      response.headers.set("x-preview-port", String(port));
      return response;
    },
    unavailableResponse: (port) => new Response(`missing ${port}`, { status: 503 }),
  });
  const ok = await worker.fetch(new Request(`${scope}8123/`), "");
  expect(ok?.headers.get("x-preview-port")).toBe("8123");
  expect(await ok?.text()).toBe("hello");
  const missing = await worker.fetch(new Request(`${scope}8124/`), "");
  expect(missing?.status).toBe(503);
  expect(await missing?.text()).toBe("missing 8124");
});

function nextMessage(port: MessagePort): Promise<any> {
  return new Promise((resolve) => {
    port.onmessage = (event) => resolve(event.data);
  });
}

test("socket transport delivers acceptance before synchronous connection finish", async () => {
  const f = fixture();
  let closes = 0;
  f.router.register(8123, {
    request: f.server.request,
    connect(_port, sink) {
      sink.end();
      return {
        write() {},
        close() {
          closes++;
        },
      };
    },
  });
  const socket = new MessageChannel();
  const messagesPromise = new Promise<unknown[]>((resolve) => {
    const messages: unknown[] = [];
    socket.port1.onmessage = (event) => {
      messages.push(event.data);
      if (messages.length === 2) resolve(messages);
    };
  });
  try {
    await f.worker.socket(8123, `${scope}8123/page`, socket.port2);
    expect(await messagesPromise).toEqual([{ type: "accepted" }, { type: "end" }]);
    expect(closes).toBe(1);
    f.router.close();
    expect(closes).toBe(1);
  } finally {
    socket.port1.close();
    socket.port2.close();
  }
});

test("socket transport probes a server then forwards duplex bytes and closes", async () => {
  const f = fixture();
  const socket = new MessageChannel();
  try {
    const accepted = nextMessage(socket.port1);
    await f.worker.socket(8123, `${scope}8123/page`, socket.port2);
    expect(await accepted).toEqual({ type: "accepted" });
    const data = nextMessage(socket.port1);
    socket.port1.postMessage({ type: "data", chunk: encoder.encode("ping") });
    expect(await data).toEqual({ type: "data", chunk: encoder.encode("ping") });
    const end = nextMessage(socket.port1);
    socket.port1.postMessage({ type: "end" });
    expect(await end).toEqual({ type: "end" });
  } finally {
    socket.port1.close();
    socket.port2.close();
  }
});

test("socket transport rejects a preview trying another port", async () => {
  const f = fixture();
  const socket = new MessageChannel();
  try {
    expect(f.worker.socket(8123, `${scope}9000/page`, socket.port2)).toBeUndefined();
  } finally {
    socket.port1.close();
    socket.port2.close();
  }
});

test("silent request owners time out and cannot answer after the next owner won", async () => {
  const f = fixture();
  let stale: MessagePort | undefined;
  const worker = createPreviewServiceWorker({
    scope,
    claimTimeoutMs: 1,
    clients: {
      async get() {
        return undefined;
      },
      async matchAll() {
        return [
          {
            url: "https://example.test/silent",
            postMessage(_ask, ports) {
              stale = ports[0];
            },
          },
          f.page,
        ];
      },
    },
    fetch,
  });
  try {
    const response = await worker.fetch(new Request(`${scope}8123/`), "");
    expect(await response?.text()).toBe("hello");
    stale?.postMessage({ type: "head", status: 500, statusText: "late", headers: [] });
  } finally {
    stale?.close();
  }
});

function scriptedWorker(send: (ask: any, port: MessagePort) => void) {
  return createPreviewServiceWorker({
    scope,
    clients: {
      async get() {
        return undefined;
      },
      async matchAll() {
        return [
          {
            url: "https://example.test/app",
            postMessage(ask, ports) {
              send(ask, ports[0]!);
            },
          },
        ];
      },
    },
    fetch,
  });
}

test("HEAD and bodyless HTTP statuses return no response body", async () => {
  for (const [method, status] of [
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 205],
    ["GET", 304],
  ] as const) {
    const worker = scriptedWorker((_ask, reply) => {
      reply.postMessage({ type: "head", status, statusText: "", headers: [] });
      reply.postMessage({ type: "end" });
      reply.close();
    });
    const response = await worker.fetch(new Request(`${scope}8123/`, { method }), "");
    expect(response?.status).toBe(status);
    expect(response?.body).toBeNull();
  }
});

test("server errors before and after response headers settle the response or stream", async () => {
  const before = scriptedWorker((_ask, reply) => {
    reply.postMessage({ type: "error", message: "stopped" });
    reply.close();
  });
  const failure = await before.fetch(new Request(`${scope}8123/`), "");
  expect(failure?.status).toBe(502);
  expect(await failure?.text()).toContain("stopped");
  const after = scriptedWorker((_ask, reply) => {
    reply.postMessage({ type: "head", status: 200, statusText: "OK", headers: [] });
    reply.postMessage({ type: "error", message: "interrupted" });
    reply.close();
  });
  const streamed = await after.fetch(new Request(`${scope}8123/`), "");
  await expect(streamed!.text()).rejects.toThrow("interrupted");
});

test("unusable status and mixed-case framing headers do not escape the response bridge", async () => {
  const invalid = scriptedWorker((_ask, reply) => {
    reply.postMessage({ type: "head", status: 999, statusText: "Invalid", headers: [] });
    reply.postMessage({ type: "end" });
    reply.close();
  });
  const response = await invalid.fetch(new Request(`${scope}8123/`), "");
  expect(response?.status).toBe(502);
  expect(await response?.text()).toContain("status 999");
  const framed = scriptedWorker((_ask, reply) => {
    reply.postMessage({
      type: "head",
      status: 200,
      statusText: "OK",
      headers: [
        ["Content-Length", "123"],
        ["Transfer-Encoding", "chunked"],
        ["Connection", "close"],
      ],
    });
    reply.postMessage({ type: "end" });
    reply.close();
  });
  const decoded = await framed.fetch(new Request(`${scope}8123/`), "");
  expect(Array.from(decoded!.headers)).toEqual([]);
  expect(await decoded?.text()).toBe("");
});

test("synchronous transports finish without dropping their response", async () => {
  const f = fixture();
  f.router.register(8123, {
    request(_port, _request, sink) {
      sink.head({ status: 200, statusText: "OK", headers: [] });
      sink.data(encoder.encode("sync"));
      sink.end();
      return true;
    },
    connect: f.server.connect,
  });
  expect(await (await f.worker.fetch(new Request(`${scope}8123/`), ""))?.text()).toBe("sync");
});

test("socket transport reports missing servers and rejects cross-origin source URLs", async () => {
  const f = fixture();
  const socket = new MessageChannel();
  try {
    expect(
      f.worker.socket(8123, "https://other.test/nested/custom.preview/8123/", socket.port2),
    ).toBeUndefined();
    const reply = nextMessage(socket.port1);
    await f.worker.socket(9999, `${scope}9999/`, socket.port2);
    expect(await reply).toEqual({ type: "error" });
  } finally {
    socket.port1.close();
    socket.port2.close();
  }
});

test("activation helper observes activation and redundant failures outside worker scope", async () => {
  class Worker extends EventTarget {
    state: ServiceWorkerState = "installing";
  }
  const worker = new Worker();
  const registration = { installing: worker } as unknown as ServiceWorkerRegistration;
  const ready = activated(registration);
  worker.state = "activated";
  worker.dispatchEvent(new Event("statechange"));
  await ready;
  await activated(registration);
  worker.state = "redundant";
  await expect(activated(registration)).rejects.toThrow("redundant");
  await expect(activated({} as ServiceWorkerRegistration)).rejects.toThrow("no worker");
});

test("activation helper accepts an active worker whose state object never updates", async () => {
  // WebKit: a second page registering at the same moment gets the active worker with its state
  // still "installing" and no later statechange. The active slot alone means it is activating or
  // activated, so the helper must not wait on that object.
  class Worker extends EventTarget {
    state: ServiceWorkerState = "installing";
  }
  const stale = {
    installing: null,
    waiting: null,
    active: new Worker(),
  } as unknown as ServiceWorkerRegistration;
  await activated(stale);
  for (const state of ["installed", "activating", "activated"] as const) {
    const active = new Worker();
    active.state = state;
    await activated({
      installing: null,
      waiting: null,
      active,
    } as unknown as ServiceWorkerRegistration);
  }

  // An active worker already marked redundant is a failure, not a ready worker: the spec updates
  // its state before it clears the active slot.
  const gone = new Worker();
  gone.state = "redundant";
  await expect(
    activated({
      installing: null,
      waiting: null,
      active: gone,
    } as unknown as ServiceWorkerRegistration),
  ).rejects.toThrow("redundant");

  // A newer installing worker is still awaited, even while an older one is active.
  const next = new Worker();
  const updating = {
    installing: next,
    waiting: null,
    active: new Worker(),
  } as unknown as ServiceWorkerRegistration;
  let settled = false;
  const ready = activated(updating).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  next.state = "activated";
  next.dispatchEvent(new Event("statechange"));
  await ready;
  expect(settled).toBe(true);
});

test("socket tunnel closes backend connection on MessagePort close event (peer crash)", async () => {
  let closes = 0;
  let sinkRef: { data(chunk: Uint8Array): void; end(): void } | undefined;
  const router = new PreviewRouter({
    baseURL: "https://example.test/nested/index.html",
    prefix: "custom.preview",
    socketPingIntervalMs: 0,
  });
  router.register(8123, {
    request: () => false,
    connect(_port, sink) {
      sinkRef = sink;
      return {
        write() {},
        close() {
          closes++;
        },
      };
    },
  });
  const closeListeners = new Set<() => void>();
  let portClosed = false;
  const posted: unknown[] = [];
  const fakePort = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage(msg: unknown) {
      if (portClosed) throw new Error("posted to closed port");
      posted.push(msg);
    },
    close() {
      portClosed = true;
    },
    addEventListener(type: string, fn: () => void) {
      if (type === "close") closeListeners.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === "close") closeListeners.delete(fn);
    },
  } as unknown as MessagePort;
  router.onMessage({ data: { type: "preview-socket", port: 8123 }, ports: [fakePort] });
  expect(posted).toEqual([{ type: "accepted" }]);
  expect(closes).toBe(0);
  // Simulate browser reporting that the peer page crashed / closed its MessagePort.
  for (const fn of Array.from(closeListeners)) fn();
  expect(closes).toBe(1);
  expect(portClosed).toBe(true);
  // Subsequent backend writes after teardown must be ignored without posting to the closed port.
  sinkRef!.data(encoder.encode("late"));
  sinkRef!.end();
  expect(closes).toBe(1);
});

test("socket tunnel closes silent crashed peer after missed pings while keeping live peers open", async () => {
  let closes = 0;
  const router = new PreviewRouter({
    baseURL: "https://example.test/nested/index.html",
    prefix: "custom.preview",
    socketPingIntervalMs: 15,
    socketMissedPings: 2,
  });
  router.register(8123, {
    request: () => false,
    connect() {
      return {
        write() {},
        close() {
          closes++;
        },
      };
    },
  });
  // Live peer replies to pings with pong and stays open across >4 intervals.
  const live = new MessageChannel();
  let livePings = 0;
  live.port1.onmessage = (event) => {
    if (event.data?.type === "ping") {
      livePings++;
      live.port1.postMessage({ type: "pong" });
    }
  };
  // Silent peer ignores all pings (simulating Firefox/WebKit tab crash with no port close event).
  const silent = new MessageChannel();
  silent.port1.onmessage = () => {};
  try {
    router.onMessage({ data: { type: "preview-socket", port: 8123 }, ports: [live.port2] });
    router.onMessage({ data: { type: "preview-socket", port: 8123 }, ports: [silent.port2] });
    const deadline = Date.now() + 2000;
    while (closes < 1 && Date.now() < deadline) await Bun.sleep(10);
    expect(closes).toBe(1);
    while (livePings < 3 && Date.now() < deadline) await Bun.sleep(10);
    expect(livePings).toBeGreaterThanOrEqual(3);
    expect(closes).toBe(1);
    // Unregistering the server closes remaining live tunnels cleanly.
    router.close();
    expect(closes).toBe(2);
  } finally {
    router.close();
    live.port1.close();
    live.port2.close();
    silent.port1.close();
    silent.port2.close();
  }
});

test("unregister and server replacement close open preview socket tunnels", () => {
  let closes = 0;
  const server: PreviewServer = {
    request: () => false,
    connect() {
      return {
        write() {},
        close() {
          closes++;
        },
      };
    },
  };
  const router = new PreviewRouter({
    baseURL: "https://example.test/nested/index.html",
    prefix: "custom.preview",
    socketPingIntervalMs: 0,
  });
  router.register(8123, server);
  const first = new MessageChannel();
  const second = new MessageChannel();
  try {
    router.onMessage({ data: { type: "preview-socket", port: 8123 }, ports: [first.port2] });
    const replacement: PreviewServer = { ...server };
    router.register(8123, replacement);
    expect(closes).toBe(1);
    router.onMessage({ data: { type: "preview-socket", port: 8123 }, ports: [second.port2] });
    router.unregister(8123, replacement);
    expect(closes).toBe(2);
  } finally {
    first.port1.close();
    first.port2.close();
    second.port1.close();
    second.port2.close();
  }
});

test("PreviewRouter.close attempts every bound relay even when an earlier relay close throws", async () => {
  const router = new PreviewRouter({
    mode: "root",
    originForPort: (port) => `https://p${port}.preview.test`,
  });
  const closed: number[] = [];
  const server = (port: number): PreviewServer => ({
    request: () => false,
    connect() {
      return {
        write() {},
        close() {
          closed.push(port);
          if (port === 8123) throw new Error("first relay close boom");
        },
      };
    },
  });
  router.register(8123, server(8123));
  router.register(8124, server(8124));
  const relay1 = await router.bindHost({ port: 8123 });
  const relay2 = await router.bindHost({ port: 8124 });
  const sink = { data() {}, end() {}, error() {} };
  const req = (port: number) => ({
    url: `https://p${port}.preview.test/`,
    method: "GET",
    headers: [
      ["upgrade", "websocket"],
      ["connection", "Upgrade"],
    ] as [string, string][],
  });
  expect(relay1.connect(relay1.authorization, req(8123), sink)).not.toBeNull();
  expect(relay2.connect(relay2.authorization, req(8124), sink)).not.toBeNull();
  let caught: unknown;
  try {
    router.close();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  const inner = (caught as AggregateError).errors[0];
  expect(inner).toBeInstanceOf(AggregateError);
  expect((inner as AggregateError).errors[0]).toMatchObject({ message: "first relay close boom" });
  expect(closed).toEqual([8123, 8124]);
  expect(() => router.url(8123)).toThrow();
  expect(() => router.url(8124)).toThrow();
});
