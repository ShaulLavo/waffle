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
