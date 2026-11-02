import { expect, test } from "bun:test";
import { PreviewRouter, type PreviewServer } from "../browser/preview";
import type { PreviewSocketRequest } from "../browser/preview-host";
import type { ConnectionSink } from "../browser/net/helper";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const origin = "https://preview.example.test";

function socketRequest(url = origin, headers: [string, string][] = []): PreviewSocketRequest {
  return { url, method: "GET", headers };
}

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
      expect(() => host.connect(grant, socketRequest(), sink)).toThrow("Unauthorized");
    }
    for (const url of [
      "https://foreign.test/",
      "https://preview.example.test:9443/",
      "http://preview.example.test/",
      "https://user@preview.example.test/",
      "ws://preview.example.test/",
    ]) {
      expect(() => host.connect(host.authorization, socketRequest(url), sink)).toThrow(
        "bound origin",
      );
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
  const connection = host.connect(
    host.authorization,
    socketRequest("wss://preview.example.test/hmr?token=abc", [
      ["Host", "preview.example.test"],
      ["Origin", origin],
      ["Connection", "Upgrade"],
      ["Upgrade", "websocket"],
    ]),
    {
      data: (bytes) => {
        chunks.push(decoder.decode(bytes));
      },
      end() {},
      error: (message) => {
        failures.push(message);
      },
    },
  );
  const upgrade =
    "GET /hmr?token=abc HTTP/1.1\r\nHost: localhost:3137\r\nOrigin: http://localhost:3137\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
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
    host.connect(host.authorization, socketRequest(), { data() {}, end() {}, error() {} }),
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
    expect(() =>
      two.connect(one.authorization, socketRequest("https://second.example.test/"), sink),
    ).toThrow("Unauthorized");
    two.connect(two.authorization, socketRequest("https://second.example.test/"), sink);
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
      { type: "socket", authorization: host.authorization, ...socketRequest(origin + "/hmr") },
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
        host.connect(host.authorization, socketRequest(`blob:${boundOrigin}/another`), {
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
      const connection = host.connect(host.authorization, socketRequest(socketURL), {
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

async function wireHTTP(
  host: Awaited<ReturnType<PreviewRouter["bindHost"]>>,
  headers: [string, string][],
) {
  const messages: import("../browser/preview-host").PreviewHostOutput[] = [];
  const exchange: import("../browser/preview-host").PreviewHostExchange = {
    onmessage: null,
    close() {},
    postMessage(message) {
      messages.push(message);
      if (message.type === "data") exchange.onmessage?.({ type: "pull" });
    },
  };
  await host.dispatch(
    {
      type: "http",
      authorization: host.authorization,
      url: origin + "/headers",
      method: "POST",
      headers,
      body: new ArrayBuffer(0),
    },
    exchange,
  );
  return messages;
}

test("W10 authenticated wire headers preserve Origin, Cookie, duplicates and repeated native Set-Cookie", async () => {
  const f = fixture(
    "HTTP/1.1 201 Created\r\nSet-Cookie: first=1; Path=/\r\nSet-Cookie: second=2; Path=/\r\nX-Repeat: a\r\nX-Repeat: b\r\nContent-Length: 2\r\n\r\nok",
  );
  const host = await f.router.bindHost({ port: 3137 });
  try {
    const messages = await wireHTTP(host, [
      ["Origin", origin],
      ["Cookie", "fixture=1"],
      ["X-Repeat", "a"],
      ["X-Repeat", "b"],
      ["Host", "foreign.test"],
      ["Content-Length", "999"],
    ]);
    expect(f.received.includes(`Origin: ${origin}\r\n`)).toBe(true);
    expect(f.received.includes("Cookie: fixture=1\r\n")).toBe(true);
    expect(f.received.includes("X-Repeat: a\r\nX-Repeat: b\r\n")).toBe(true);
    expect(f.received.includes("host: preview.example.test\r\n")).toBe(true);
    expect(f.received.includes("content-length: 0\r\n")).toBe(true);
    const head = messages.find((message) => message.type === "head");
    expect(head?.status).toBe(201);
    const cookies = head?.headers.filter(([name]) => name.toLowerCase() === "set-cookie") ?? [];
    expect(cookies.length).toBe(2);
    expect(head?.headers.filter(([name]) => name === "x-repeat").length).toBe(2);
    const nativeResponse = new Response(null, { headers: head?.headers });
    expect(nativeResponse.headers.getSetCookie().length).toBe(2);
    expect(messages.at(-1)?.type).toBe("end");
  } finally {
    host.close();
  }
});

test("wire header syntax validation rejects injection and non-HTTP bytes before connecting", async () => {
  const f = fixture();
  const host = await f.router.bindHost({ port: 3137 });
  try {
    for (const headers of [
      [["bad name", "value"]],
      [["x-test", "line\r\ninjected: yes"]],
      [["cookie", "bad\u0000value"]],
      [["x-test", "wide\u0100"]],
    ] satisfies [string, string][][]) {
      const messages = await wireHTTP(host, headers);
      expect(messages.map((message) => message.type)).toEqual(["error"]);
    }
    expect(f.opened).toBe(0);
    expect(f.received).toBe("");
  } finally {
    host.close();
  }
});

test("invalid raw response headers fail without exposing a wire head", async () => {
  const f = fixture("HTTP/1.1 200 OK\r\nInvalid Name: value\r\nContent-Length: 0\r\n\r\n");
  const host = await f.router.bindHost({ port: 3137 });
  try {
    const messages = await wireHTTP(host, []);
    expect(messages.map((message) => message.type)).toEqual(["error"]);
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
});

for (const malformed of ["Broken", "X-Test : value"]) {
  test(`raw response rejects ${malformed.includes(":") ? "whitespace before colon" : "missing colon"} before exposing a head`, async () => {
    const f = fixture(`HTTP/1.1 200 OK\r\n${malformed}\r\nContent-Length: 0\r\n\r\n`);
    const host = await f.router.bindHost({ port: 3137 });
    try {
      const messages = await wireHTTP(host, []);
      expect(messages.map((message) => message.type)).toEqual(["error"]);
      expect(f.stopped).toBe(1);
    } finally {
      host.close();
    }
  });
}

test("valid response OWS and duplicate fields survive raw header validation", async () => {
  const f = fixture(
    "HTTP/1.1 200 OK\r\nX-Test:\t value \t\r\nSet-Cookie: first=1; Path=/\r\nSet-Cookie:\tsecond=2; Path=/ \t\r\nContent-Length: 0\r\n\r\n",
  );
  const host = await f.router.bindHost({ port: 3137 });
  try {
    const messages = await wireHTTP(host, []);
    const head = messages.find((message) => message.type === "head");
    expect(head?.headers.find(([name]) => name === "x-test")?.[1] === "value").toBe(true);
    expect(head?.headers.filter(([name]) => name === "set-cookie").length).toBe(2);
    expect(messages.at(-1)?.type).toBe("end");
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
});

test("raw response controls cannot disappear through value trimming", async () => {
  const f = fixture("HTTP/1.1 200 OK\r\nX-Test: \vvalue\v\r\nContent-Length: 0\r\n\r\n");
  const host = await f.router.bindHost({ port: 3137 });
  try {
    const messages = await wireHTTP(host, []);
    expect(messages.map((message) => message.type)).toEqual(["error"]);
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
});

test("malformed interim response fields fail before a final response head", async () => {
  const f = fixture(
    "HTTP/1.1 100 Continue\r\nBroken\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
  );
  const host = await f.router.bindHost({ port: 3137 });
  try {
    const messages = await wireHTTP(host, []);
    expect(messages.map((message) => message.type)).toEqual(["error"]);
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
});

test("WAF-003 oversized response head rejects preview fetch and closes its connection", async () => {
  const f = fixture("HTTP/1.1 200 OK\r\nX: " + "a".repeat(64 * 1024) + "\r\n\r\n");
  const host = await f.router.bindHost({ port: 3137 });
  try {
    await expect(host.fetch(host.authorization, new Request(origin))).rejects.toThrow(
      "head metadata limit",
    );
    expect(f.stopped).toBe(1);
  } finally {
    host.close();
  }
  expect(f.stopped).toBe(1);
});

for (const malformed of ["1g\r\n", "1\r\naXX", "0\r\n" + "X: abc\r\n".repeat(8192) + "\r\n"]) {
  test(`WAF-003 ${malformed.startsWith("0") ? "trailer overflow" : "bad chunk framing"} errors an already resolved preview body and closes the connection`, async () => {
    const f = fixture();
    const host = await f.router.bindHost({ port: 3137 });
    try {
      const pending = host.fetch(host.authorization, new Request(origin));
      await f.peer?.data(encoder.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"));
      const response = await pending;
      expect(response.status).toBe(200);
      const body = response.text();
      void f.peer?.data(encoder.encode(malformed));
      await expect(body).rejects.toThrow();
      expect(f.stopped).toBe(1);
    } finally {
      host.close();
    }
    expect(f.stopped).toBe(1);
  });
}
