import { expect, test } from "bun:test";
import { PreviewRouter, type PreviewServer } from "../browser/preview";
import type { ConnectionSink } from "../browser/net/helper";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const origin = "https://preview.example.test";

function fixture(reply?: string) {
  const origins = new Map([
    [3137, origin],
    [3138, "https://second.example.test"],
  ]);
  const router = new PreviewRouter({
    mode: "root",
    originForPort: (port) => origins.get(port) ?? "",
  });
  let received = "";
  let opened = 0;
  let stopped = 0;
  let peer: ConnectionSink | undefined;
  const server: PreviewServer = {
    request() {
      throw new Error("Root relay must preserve Host through the raw transport");
    },
    connect(port, sink) {
      expect(port).toBe(3137);
      opened++;
      peer = sink;
      return {
        write(bytes) {
          received += decoder.decode(bytes);
          if (reply !== undefined) void sink.data(encoder.encode(reply));
        },
        close() {
          stopped++;
          sink.end();
        },
      };
    },
  };
  router.register(3137, server);
  return {
    router,
    origins,
    server,
    get received() {
      return received;
    },
    get opened() {
      return opened;
    },
    get stopped() {
      return stopped;
    },
    get peer() {
      return peer;
    },
  };
}

test("root URL requires a live relay and rejects origin escapes without a prefix fallback", async () => {
  const f = fixture();
  expect(() => f.router.url(3137)).toThrow("No authenticated preview host");
  const host = await f.router.bindHost({ port: 3137 });
  try {
    expect(f.router.url(3137, "/nested?value=a%2Bb#section")).toBe(
      `${origin}/nested?value=a%2Bb#section`,
    );
    for (const path of ["//foreign.test/", "https://foreign.test/", "/\\foreign.test/", "relative"])
      expect(() => f.router.url(3137, path)).toThrow();
    expect(() => f.router.url(8123)).toThrow();
  } finally {
    host.close();
  }
  expect(() => f.router.url(3137)).toThrow();
});

test("host relay preserves HTTP method, public authority, headers, body, query, and redirect", async () => {
  const f = fixture(
    "HTTP/1.1 307 Temporary Redirect\r\nLocation: /nested?q=2#section\r\nContent-Length: 2\r\nX-App: yes\r\n\r\nok",
  );
  const options = { port: 3137 };
  const host = await f.router.bindHost(options);
  options.port = 9999;
  try {
    const response = await host.fetch(
      JSON.parse(JSON.stringify(host.authorization)),
      new Request(`${origin}/submit?q=a%2Bb`, {
        method: "POST",
        headers: { "x-input": "yes", origin },
        body: "hello",
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/nested?q=2#section");
    expect(response.headers.get("x-app")).toBe("yes");
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("ok");
    expect(f.received).toStartWith(
      "POST /submit?q=a%2Bb HTTP/1.1\r\nhost: preview.example.test\r\n",
    );
    expect(f.received).toContain("origin: https://preview.example.test\r\n");
    expect(f.received).toContain("x-input: yes\r\n");
    expect(f.received).toEndWith("\r\n\r\nhello");
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
});

test("owner, virtual port, capability, and exact HTTP/socket origin are checked before opening", async () => {
  const f = fixture();
  const foreign = fixture();
  const host = await f.router.bindHost({ port: 3137 });
  const other = await foreign.router.bindHost({ port: 3137 });
  const sink: ConnectionSink = { data() {}, end() {}, error() {} };
  try {
    for (const grant of [
      null,
      {},
      other.authorization,
      { ...host.authorization, owner: "wrong" },
      { ...host.authorization, port: 9999 },
      { ...host.authorization, origin: "https://foreign.test" },
      { ...host.authorization, capability: "wrong" },
    ]) {
      await expect(host.fetch(grant, new Request(origin))).rejects.toThrow("Unauthorized");
      expect(() => host.connect(grant, origin, sink)).toThrow("Unauthorized");
    }
    for (const url of [
      "https://foreign.test/",
      "https://preview.example.test:9443/",
      "http://preview.example.test/",
      "https://user@preview.example.test/",
      "ws://preview.example.test/",
    ]) {
      expect(() => host.connect(host.authorization, url, sink)).toThrow("bound origin");
    }
    expect(f.opened).toBe(0);
  } finally {
    host.close();
    other.close();
  }
});

test("duplex connections retain upgrade bytes and are revoked with their binding", async () => {
  const f = fixture();
  const lifetime = new AbortController();
  const host = await f.router.bindHost({ port: 3137, signal: lifetime.signal });
  const chunks: string[] = [];
  const failures: string[] = [];
  const connection = host.connect(host.authorization, "wss://preview.example.test/hmr?token=abc", {
    data: (bytes) => {
      chunks.push(decoder.decode(bytes));
    },
    end() {},
    error: (message) => {
      failures.push(message);
    },
  });
  const upgrade =
    "GET /hmr?token=abc HTTP/1.1\r\nHost: preview.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  connection?.write(encoder.encode(upgrade));
  await f.peer?.data(encoder.encode("HTTP/1.1 101 Switching Protocols\r\n\r\nframe"));
  expect(f.received).toBe(upgrade);
  expect(chunks).toEqual(["HTTP/1.1 101 Switching Protocols\r\n\r\nframe"]);
  lifetime.abort();
  expect(host.closed).toBe(true);
  expect(f.stopped).toBe(1);
  expect(failures).toEqual(["Preview host relay closed"]);
  connection?.write(encoder.encode("late"));
  expect(f.received).toBe(upgrade);
  expect(() =>
    host.connect(host.authorization, origin, { data() {}, end() {}, error() {} }),
  ).toThrow("closed");
});

test("response streams deliver early chunks and cancellation closes the real connection", async () => {
  const f = fixture();
  const host = await f.router.bindHost({ port: 3137 });
  try {
    const pending = host.fetch(host.authorization, new Request(origin));
    void f.peer?.data(
      encoder.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n"),
    );
    const response = await pending;
    const reader = response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe("one");
    await reader.cancel();
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
});

test("abort, rebind, and unregister revoke outstanding HTTP and old grants", async () => {
  const f = fixture();
  const host = await f.router.bindHost({ port: 3137 });
  const requestLifetime = new AbortController();
  const pending = host.fetch(
    host.authorization,
    new Request(origin, { signal: requestLifetime.signal }),
  );
  requestLifetime.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(f.stopped).toBe(1);
  const replacement = await f.router.bindHost({ port: 3137 });
  expect(host.closed).toBe(true);
  await expect(host.fetch(host.authorization, new Request(origin))).rejects.toThrow("closed");
  f.router.unregister(3137, f.server);
  expect(replacement.closed).toBe(true);
  expect(() => f.router.url(3137)).toThrow();
});

test("root host setup rejects non-root origins, invalid ports, missing servers and dead lifetimes", async () => {
  const f = fixture();
  for (const bad of [
    "https://preview.example.test/path",
    `${origin}/?port=3137`,
    `${origin}/#owner`,
    "file:///",
    "https://user:secret@preview.example.test",
  ]) {
    f.origins.set(3137, bad);
    await expect(f.router.bindHost({ port: 3137 })).rejects.toThrow("root origin");
  }
  f.origins.set(3137, origin);
  await expect(f.router.bindHost({ port: 65536 })).rejects.toThrow();
  const lifetime = new AbortController();
  lifetime.abort();
  await expect(f.router.bindHost({ port: 3137, signal: lifetime.signal })).rejects.toThrow();
  const mount = new PreviewRouter({ baseURL: origin, prefix: "/preview" });
  await expect(mount.bindHost({ port: 3137 })).rejects.toThrow("root preview mode");
});

test("two virtual ports have distinct root origins and cannot reuse each other's grants", async () => {
  const f = fixture();
  let secondPort = 0;
  f.router.register(3138, {
    request: f.server.request,
    connect(port, sink) {
      secondPort = port;
      sink.end();
      return { write() {}, close() {} };
    },
  });
  const one = await f.router.bindHost({ port: 3137 });
  const two = await f.router.bindHost({ port: 3138 });
  try {
    expect(f.router.url(3137)).toBe(`${origin}/`);
    expect(f.router.url(3138)).toBe("https://second.example.test/");
    const sink: ConnectionSink = { data() {}, end() {}, error() {} };
    expect(() => two.connect(one.authorization, "https://second.example.test/", sink)).toThrow(
      "Unauthorized",
    );
    two.connect(two.authorization, "https://second.example.test/", sink);
    expect(secondPort).toBe(3138);
    f.origins.set(3138, origin);
    await expect(f.router.bindHost({ port: 3138 })).rejects.toThrow("already bound");
    expect(two.closed).toBe(false);
  } finally {
    one.close();
    two.close();
  }
});

test("wire HTTP exchanges transfer bytes, wait for pulls, and reject foreign grants", async () => {
  const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nyes");
  const host = await f.router.bindHost({ port: 3137 });
  const messages: import("../browser/preview-host").PreviewHostOutput[] = [];
  let notify = () => {};
  const data = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const exchange: import("../browser/preview-host").PreviewHostExchange = {
    onmessage: null,
    postMessage(message, transfer) {
      messages.push(structuredClone(message, { transfer }));
      if (message.type === "data") notify();
    },
    close() {},
  };
  try {
    const open = {
      type: "http",
      authorization: host.authorization,
      url: origin + "/?value=wire",
      method: "GET",
      headers: [],
      body: null,
    } satisfies import("../browser/preview-host").PreviewHostOpen;
    let done = false;
    const completed = host.dispatch(open, exchange).then(() => {
      done = true;
    });
    await data;
    expect(done).toBe(false);
    expect(messages.map((message) => message.type)).toEqual(["accepted", "head", "data"]);
    exchange.onmessage?.({ type: "pull" });
    await completed;
    expect(messages.at(-1)?.type).toBe("end");
    const body = messages.find((message) => message.type === "data");
    expect(body?.type === "data" && decoder.decode(body.chunk)).toBe("yes");
    messages.length = 0;
    await host.dispatch(
      { ...open, authorization: { ...host.authorization, owner: "foreign" } },
      exchange,
    );
    expect(messages[0]?.type).toBe("error");
    expect(f.opened).toBe(1);
  } finally {
    host.close();
  }
});

test("revocation interrupts a wire response waiting for an HTTP body pull", async () => {
  const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nyes");
  const host = await f.router.bindHost({ port: 3137 });
  let notify = () => {};
  const data = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const messages: string[] = [];
  const exchange: import("../browser/preview-host").PreviewHostExchange = {
    onmessage: null,
    close() {},
    postMessage(message) {
      messages.push(message.type);
      if (message.type === "data") notify();
    },
  };
  const completed = host.dispatch(
    {
      type: "http",
      authorization: host.authorization,
      url: origin,
      method: "GET",
      headers: [],
      body: null,
    },
    exchange,
  );
  await data;
  host.close();
  await completed;
  expect(messages.at(-1)).toBe("error");
  expect(exchange.onmessage).toBeNull();
});

test("wire socket acceptance precedes synchronous bytes and end", async () => {
  const f = fixture();
  f.router.register(3137, {
    request: f.server.request,
    connect(_port, sink) {
      void sink.data(encoder.encode("upgrade"));
      sink.end();
      return { write() {}, close() {} };
    },
  });
  const host = await f.router.bindHost({ port: 3137 });
  const messages: string[] = [];
  try {
    await host.dispatch(
      { type: "socket", authorization: host.authorization, url: origin + "/hmr" },
      {
        onmessage: null,
        close() {},
        postMessage(message) {
          messages.push(message.type);
        },
      },
    );
    expect(messages).toEqual(["accepted", "data", "end"]);
  } finally {
    host.close();
  }
});

test("revocation after a pending body read resolves cannot strand an exchange awaiting credit", async () => {
  const f = fixture();
  const host = await f.router.bindHost({ port: 3137 });
  let notify = () => {};
  const head = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const messages: string[] = [];
  const completed = host.dispatch(
    {
      type: "http",
      authorization: host.authorization,
      url: origin,
      method: "GET",
      headers: [],
      body: null,
    },
    {
      onmessage: null,
      close() {},
      postMessage(message) {
        messages.push(message.type);
        if (message.type === "head") notify();
      },
    },
  );
  void f.peer?.data(encoder.encode("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n"));
  await head;
  void f.peer?.data(encoder.encode("yes"));
  host.close();
  await completed;
  expect(messages).toEqual(["accepted", "head", "error"]);
});

for (const protocol of ["http:", "https:"]) {
  test(`${protocol} relay fetch rejects a matching-origin blob before connecting`, async () => {
    const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const boundOrigin = `${protocol}//preview.example.test`;
    f.origins.set(3137, boundOrigin);
    const host = await f.router.bindHost({ port: 3137 });
    try {
      await expect(
        host.fetch(host.authorization, new Request(`blob:${boundOrigin}/another`)),
      ).rejects.toThrow("protocol");
      expect(f.opened).toBe(0);
      expect(f.received).toBe("");
    } finally {
      host.close();
    }
  });

  test(`${protocol} relay socket rejects a matching-origin blob before connecting`, async () => {
    const f = fixture();
    const boundOrigin = `${protocol}//preview.example.test`;
    f.origins.set(3137, boundOrigin);
    const host = await f.router.bindHost({ port: 3137 });
    try {
      expect(() =>
        host.connect(host.authorization, `blob:${boundOrigin}/another`, {
          data() {},
          end() {},
          error() {},
        }),
      ).toThrow("protocol");
      expect(f.opened).toBe(0);
      expect(f.received).toBe("");
    } finally {
      host.close();
    }
  });

  test(`${protocol} relay preserves HTTP and corresponding WebSocket URLs`, async () => {
    const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const boundOrigin = `${protocol}//preview.example.test`;
    f.origins.set(3137, boundOrigin);
    const host = await f.router.bindHost({ port: 3137 });
    try {
      const response = await host.fetch(
        host.authorization,
        new Request(`${boundOrigin}/route?q=1`),
      );
      expect(response.status).toBe(200);
      expect(f.received).toStartWith("GET /route?q=1 HTTP/1.1\r\nhost: preview.example.test\r\n");
      const socketURL = boundOrigin.replace(/^http/, "ws") + "/hmr?q=2";
      const connection = host.connect(host.authorization, socketURL, {
        data() {},
        end() {},
        error() {},
      });
      expect(connection).not.toBeNull();
      connection?.close();
      expect(f.opened).toBe(2);
    } finally {
      host.close();
    }
  });
}
