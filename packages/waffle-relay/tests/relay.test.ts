import { expect, test } from "bun:test";
import { createRelayFetch } from "../src/client.ts";
import { createRelayHandler, type Egress } from "../src/server.ts";
import { createWorkerRelayHandler } from "../src/worker.ts";
import {
  encodeMeta,
  RELAY_META_HEADER,
  responseMeta,
  type RelayServerOptions,
} from "../src/protocol.ts";
import { readNetFetchResponseMetadata } from "waffle/browser/net/transport";
import { isPublicAddress } from "../src/address.ts";

const TOKEN = "owned-fixture-token-not-a-secret";
const TARGET = "https://target.example.test";
const PAGE = "https://page.example.test";
const encoder = new TextEncoder();
const options: RelayServerOptions = {
  credential: TOKEN,
  allowedOrigins: [PAGE],
  destinations: { mode: "fixed-origins", origins: [TARGET] },
};

function envelope(target: string, extra: RequestInit = {}, meta = {}) {
  const headers = new Headers({ authorization: `Bearer ${TOKEN}`, origin: PAGE });
  headers.set(
    RELAY_META_HEADER,
    encodeMeta({ version: 1, url: target, method: "GET", headers: [], ...meta }, 32768),
  );
  return new Request("https://relay.example.test/v1/fetch", { method: "POST", headers, ...extra });
}

function fixture(egress: Egress, overrides: Partial<RelayServerOptions> = {}) {
  const handler = createRelayHandler({ ...options, ...overrides }, egress);
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: (url, init) => handler.fetch(new Request(url, init)),
  });
  return {
    handler,
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

const echo: Egress = {
  async fetch(url) {
    return new Response(url.pathname, { status: 201 });
  },
};
function errorCode(response: Response) {
  const meta = responseMeta(response.headers.get(RELAY_META_HEADER), 32768);
  return meta.kind === "error" ? meta.code : "target";
}

test("shared protocol returns the target status and validated target metadata", async () => {
  const f = fixture(echo);
  try {
    const response = await f.client.fetch(`${TARGET}/path?q=one`, { redirect: "manual" });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("/path");
    expect(readNetFetchResponseMetadata(response)).toEqual({
      targetURL: `${TARGET}/path?q=one`,
      redirected: false,
    });
  } finally {
    await f.close();
  }
});

test("relay failures cannot be confused with target authentication errors", async () => {
  const f = fixture({
    async fetch() {
      return new Response("target authentication", { status: 401 });
    },
  });
  try {
    const target = await f.client.fetch(TARGET);
    expect(target.status).toBe(401);
    expect(await target.text()).toBe("target authentication");
    const denied = await f.handler.fetch(
      envelope(TARGET, { headers: { authorization: "Bearer wrong" } }),
    );
    expect(denied.status).toBe(401);
    expect(errorCode(denied)).toBe("relay-auth");
  } finally {
    await f.close();
  }
});

test("authentication and exact CORS origins gate egress; preflight does not expose credentials", async () => {
  let calls = 0;
  const handler = createRelayHandler(options, {
    async fetch() {
      calls++;
      return new Response("ok");
    },
  });
  try {
    const valid = await handler.fetch(envelope(TARGET));
    expect(valid.headers.get("access-control-allow-origin")).toBe(PAGE);
    await valid.body?.cancel();
    const deniedOrigin = await handler.fetch(
      envelope(TARGET, {
        headers: { origin: `${PAGE}.attacker.test`, authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(errorCode(deniedOrigin)).toBe("relay-origin");
    expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await handler.fetch(
      new Request("https://relay.example.test/v1/fetch", {
        method: "OPTIONS",
        headers: { origin: PAGE },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(RELAY_META_HEADER);
    expect(calls).toBe(1);
  } finally {
    await handler.close();
  }
});

test("new handlers deny every destination by default and fixed lists match exact origins", async () => {
  let calls = 0;
  const egress: Egress = {
    async fetch() {
      calls++;
      return new Response("ok");
    },
  };
  const empty = createRelayHandler({ credential: TOKEN, allowedOrigins: [] }, egress);
  const fixed = createRelayHandler(options, egress);
  try {
    expect(errorCode(await empty.fetch(envelope(TARGET)))).toBe("relay-origin");
    for (const target of [
      "https://target.example.test.attacker.test/",
      "http://target.example.test/",
      "https://target.example.test:444/",
      "file:///etc/passwd",
      "https://user:password@target.example.test/",
      `${TARGET}/#fragment`,
    ])
      expect(errorCode(await fixed.fetch(envelope(target)))).toBe("destination-denied");
    expect(calls).toBe(0);
  } finally {
    await empty.close();
    await fixed.close();
  }
});

test("public mode rejects HTTP at shared policy boundary; Worker rejects configuration deterministically", async () => {
  expect(() =>
    createWorkerRelayHandler({ ...options, destinations: { mode: "public-https" } }),
  ).toThrow("no connection-validated egress connector");
  const handler = createRelayHandler({ ...options, destinations: { mode: "public-https" } }, echo);
  try {
    expect(errorCode(await handler.fetch(envelope("http://example.test/")))).toBe(
      "destination-denied",
    );
  } finally {
    await handler.close();
  }
});

for (const address of [
  "0.0.0.0",
  "10.1.2.3",
  "100.100.100.200",
  "127.0.0.1",
  "169.254.169.254",
  "172.31.1.2",
  "192.168.1.2",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.1.1.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:8.8.8.8",
  "64:ff9b::808:808",
  "fc00::1",
  "fe80::1",
  "ff02::1",
  "2001:db8::1",
  "2002:7f00:1::1",
  "3fff::1",
  "not-an-address",
]) {
  test(`public address classification denies ${address}`, () =>
    expect(isPublicAddress(address)).toBe(false));
}
for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])
  test(`public address classification accepts ${address} without connecting`, () =>
    expect(isPublicAddress(address)).toBe(true));

test("guest credentials, hop headers, and relay metadata never become target authority", async () => {
  let received = new Headers();
  const f = fixture(
    {
      async fetch(_url, init) {
        received = init.headers;
        return new Response("ok", {
          headers: { "set-cookie": "hidden", "x-waffle-relay-meta": "spoof", "x-safe": "yes" },
        });
      },
    },
    {
      credentials: [
        { origin: TARGET, headers: [["Authorization", "Bearer operator-fixture-profile"]] },
      ],
    },
  );
  try {
    const response = await f.client.fetch(TARGET, {
      headers: {
        authorization: "Bearer guest",
        cookie: "guest-cookie",
        "proxy-authorization": "guest-proxy",
        host: "private.test",
        connection: "x-hop",
        "x-hop": "hidden",
        "x-waffle-relay-meta": "spoof",
        "x-safe": "yes",
      },
    });
    expect(received.get("authorization")).toBe("Bearer operator-fixture-profile");
    for (const name of ["cookie", "proxy-authorization", "x-hop", "x-waffle-relay-meta"])
      expect(received.has(name)).toBe(false);
    expect(received.get("x-safe")).toBe("yes");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(RELAY_META_HEADER)).toBeNull();
    expect(response.headers.get("x-safe")).toBe("yes");
    await response.text();
  } finally {
    await f.close();
  }
});

test("redirects revalidate origins and select only destination-owned credential profiles", async () => {
  const other = "https://other.example.test";
  const seen: string[] = [];
  const f = fixture(
    {
      async fetch(url, init) {
        seen.push(`${url.origin}:${init.headers.get("authorization") ?? "none"}`);
        return url.origin === TARGET
          ? new Response("discard", { status: 302, headers: { location: `${other}/done` } })
          : new Response("done");
      },
    },
    {
      destinations: { mode: "fixed-origins", origins: [TARGET, other] },
      credentials: [{ origin: TARGET, headers: [["authorization", "operator-first"]] }],
    },
  );
  try {
    const response = await f.client.fetch(TARGET);
    expect(await response.text()).toBe("done");
    expect(seen).toEqual([`${TARGET}:operator-first`, `${other}:none`]);
  } finally {
    await f.close();
  }
  const denied = fixture({
    async fetch() {
      return new Response(null, { status: 307, headers: { location: other } });
    },
  });
  try {
    await expect(denied.client.fetch(TARGET)).rejects.toMatchObject({ code: "destination-denied" });
  } finally {
    await denied.close();
  }
});

test("redirect hop limit also applies when a helper drives manual hops through one signal", async () => {
  let calls = 0;
  const f = fixture({
    async fetch() {
      calls++;
      return new Response(null, { status: 302, headers: { location: `${TARGET}/next` } });
    },
  });
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    limits: { maxRedirects: 1 },
    transport: (url, init) => f.handler.fetch(new Request(url, init)),
  });
  const controller = new AbortController();
  try {
    await (
      await client.fetch(TARGET, { signal: controller.signal, redirect: "manual" })
    ).body?.cancel();
    await (
      await client.fetch(`${TARGET}/next`, { signal: controller.signal, redirect: "manual" })
    ).body?.cancel();
    await expect(
      client.fetch(`${TARGET}/next`, { signal: controller.signal, redirect: "manual" }),
    ).rejects.toMatchObject({ code: "redirect-denied" });
    expect(calls).toBe(2);
  } finally {
    await client.close();
    await f.close();
  }
});

test("request and response byte limits stop streams without aggregating bodies", async () => {
  const f = fixture(
    {
      async fetch(_url, init) {
        await new Response(init.body).arrayBuffer();
        return new Response("ok");
      },
    },
    { limits: { maxRequestBytes: 3 } },
  );
  try {
    await expect(f.client.fetch(TARGET, { method: "POST", body: "1234" })).rejects.toMatchObject({
      code: "request-limit",
    });
  } finally {
    await f.close();
  }
  const responseLimited = fixture(
    {
      async fetch() {
        return new Response("1234");
      },
    },
    { limits: { maxResponseBytes: 3 } },
  );
  try {
    await expect((await responseLimited.client.fetch(TARGET)).text()).rejects.toMatchObject({
      code: "response-limit",
    });
  } finally {
    await responseLimited.close();
  }
});

test("response and request header budgets deny oversized and malformed metadata", async () => {
  const f = fixture(
    {
      async fetch() {
        return new Response(null, { headers: { "x-large": "x".repeat(200) } });
      },
    },
    { limits: { maxHeaderBytes: 64 } },
  );
  try {
    await expect(f.client.fetch(TARGET)).rejects.toMatchObject({ code: "header-limit" });
    await expect(
      f.client.fetch(TARGET, { headers: { "x-large": "x".repeat(200) } }),
    ).rejects.toMatchObject({ code: "header-limit" });
    const malformed = await f.handler.fetch(
      envelope(TARGET, {}, { headers: [["x-safe", "bad\r\nvalue"]] }),
    );
    expect(errorCode(malformed)).toBe("relay-metadata");
  } finally {
    await f.close();
  }
});

test("pull pressure stops read-ahead and cancellation joins the upstream receipt", async () => {
  let pulls = 0;
  const cancelled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({
    async fetch() {
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(encoder.encode("chunk"));
            },
            async cancel() {
              cancelled.resolve();
              await release.promise;
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  try {
    const response = await f.client.fetch(TARGET);
    expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(encoder.encode("chunk"));
    expect(pulls).toBe(1);
    const cancellation = reader.cancel();
    await cancelled.promise;
    let closed = false;
    const closing = f.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await cancellation;
    await closing;
  } finally {
    release.resolve();
    await f.close();
  }
});

test("revocation fences synchronously, preserves abort reason, and waits for late transport work", async () => {
  const pending = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  let captured: AbortSignal | null | undefined;
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: (_url, init) => {
      calls++;
      captured = init.signal;
      entered.resolve();
      return pending.promise;
    },
  });
  const controller = new AbortController();
  const reason = { owned: "abort reason" };
  const result = client.fetch(TARGET, { signal: controller.signal }).catch((error) => error);
  await entered.promise;
  controller.abort(reason);
  expect(captured?.reason).toBe(reason);
  client.revoke(reason);
  expect(await client.fetch(TARGET).catch((error) => error)).toBe(reason);
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  pending.resolve(new Response(null));
  expect(await result).toBe(reason);
  await closing;
  expect(calls).toBe(1);
});

test("configuration and request accessors cannot revoke then admit new work", async () => {
  let calls = 0;
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: async () => {
      calls++;
      throw new Error("must not run");
    },
  });
  const reason = new Error("fenced");
  const request: RequestInit = {
    get headers() {
      client.revoke(reason);
      return {};
    },
  };
  expect(await client.fetch(TARGET, request).catch((error) => error)).toBe(reason);
  expect(calls).toBe(0);
  await client.close();
});

test("concurrency is held through response consumption and released only after cleanup", async () => {
  const f = fixture(
    {
      async fetch() {
        return new Response("held");
      },
    },
    { limits: { maxConcurrent: 1 } },
  );
  try {
    const first = await f.client.fetch(TARGET);
    await expect(f.client.fetch(TARGET)).rejects.toMatchObject({ code: "concurrent-limit" });
    await first.body?.cancel();
    const next = await f.client.fetch(TARGET);
    expect(await next.text()).toBe("held");
  } finally {
    await f.close();
  }
});

test("untrusted upstream headers and malformed final URL metadata cannot spoof the target URL", async () => {
  const f = fixture({
    async fetch() {
      const response = new Response("ok", {
        headers: { [RELAY_META_HEADER]: "spoof", "x-waffle-relay-target-url": "http://private/" },
      });
      Object.defineProperty(response, "url", { value: "http://private/" });
      return response;
    },
  });
  try {
    const response = await f.client.fetch(TARGET);
    expect(readNetFetchResponseMetadata(response)?.targetURL).toBe(`${TARGET}/`);
    expect(response.headers.has("x-waffle-relay-target-url")).toBe(false);
    await response.text();
  } finally {
    await f.close();
  }
  const spoof = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: async () =>
      new Response(null, {
        headers: {
          [RELAY_META_HEADER]: encodeMeta(
            {
              version: 1,
              kind: "target",
              status: 200,
              statusText: "OK",
              url: "http://private/",
              headers: [],
            },
            32768,
          ),
        },
      }),
  });
  try {
    await expect(spoof.fetch(TARGET)).rejects.toMatchObject({ code: "relay-metadata" });
  } finally {
    await spoof.close();
  }
});

test("upstream errors and outer transport errors redact every arbitrary message", async () => {
  const f = fixture({
    async fetch() {
      throw new Error(`danger ${TOKEN} cookie body https://user:pass@private/`);
    },
  });
  try {
    expect(String(await f.client.fetch(TARGET).catch((error) => error))).toBe(
      "RelayError: upstream-network",
    );
  } finally {
    await f.close();
  }
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: async () => {
      throw new Error(`leak ${TOKEN}`);
    },
  });
  try {
    expect(String(await client.fetch(TARGET).catch((error) => error))).toBe(
      "RelayError: relay-unavailable",
    );
  } finally {
    await client.close();
  }
});

test("failed cancellation is retained as redacted cleanup debt instead of claiming settlement", async () => {
  const f = fixture({
    async fetch() {
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              controller.enqueue(encoder.encode("held"));
            },
            cancel() {
              return Promise.reject(new Error(`private cleanup detail ${TOKEN}`));
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  const response = await f.client.fetch(TARGET);
  expect(String(await response.body?.cancel().catch((error) => error))).toBe(
    "RelayError: relay-unavailable",
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.handler.close().catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(String(result)).toBe("AggregateError: Relay cleanup is unsettled");
    expect(JSON.stringify(result, Object.getOwnPropertyNames(result))).not.toContain(TOKEN);
  }
  await f.client.close().catch(() => {});
});

test("idle timeout cancels a stalled body and releases the server slot", async () => {
  const cancelled = Promise.withResolvers<void>();
  const f = fixture(
    {
      async fetch() {
        return new Response(
          new ReadableStream(
            {
              cancel() {
                cancelled.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    },
    { limits: { idleTimeoutMs: 15 } },
  );
  const response = await f.client.fetch(TARGET);
  const failure = response.text().catch((error) => error);
  await cancelled.promise;
  expect(await failure).toMatchObject({ code: "upstream-aborted" });
  await f.close();
});

test("Worker-compatible adapter shares auth, policy, redirects, streaming and header rules", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; redirect: RequestRedirect | undefined }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return new Response("worker fixture", {
        status: 202,
        headers: { "set-cookie": "private", "x-safe": "worker" },
      });
    },
    { preconnect: original.preconnect },
  );
  const worker = createWorkerRelayHandler(options);
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: (url, init) => worker.fetch(new Request(url, init)),
  });
  try {
    const response = await client.fetch(TARGET);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("worker fixture");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(calls).toEqual([{ url: `${TARGET}/`, redirect: "manual" }]);
    expect(errorCode(await worker.fetch(envelope("https://private.example.test/")))).toBe(
      "destination-denied",
    );
    expect(
      errorCode(
        await worker.fetch(envelope(TARGET, { headers: { authorization: "Bearer guest" } })),
      ),
    ).toBe("relay-auth");
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = original;
    await client.close();
    await worker.close();
  }
});

test("outer response body errors are redacted but caller abort keeps its original reason", async () => {
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error(`leak ${TOKEN}`));
          },
        }),
        {
          headers: {
            [RELAY_META_HEADER]: encodeMeta(
              {
                version: 1,
                kind: "target",
                status: 200,
                statusText: "OK",
                url: `${TARGET}/`,
                headers: [],
              },
              32768,
            ),
          },
        },
      ),
  });
  try {
    expect(String(await (await client.fetch(TARGET)).text().catch((error) => error))).toBe(
      "RelayError: relay-unavailable",
    );
  } finally {
    await client.close();
  }
});

test("late headers after abort retain failed upstream cancellation debt", async () => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Response>();
  const handler = createRelayHandler(options, {
    fetch: async () => {
      entered.resolve();
      return late.promise;
    },
  });
  const controller = new AbortController();
  const pending = handler.fetch(envelope(TARGET, { signal: controller.signal }));
  await entered.promise;
  controller.abort(new Error("owned cancellation"));
  late.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          return Promise.reject(new Error("private underlying detail"));
        },
      }),
    ),
  );
  expect(errorCode(await pending)).toBe("upstream-network");
  expect(await handler.close().catch((error) => error)).toBeInstanceOf(AggregateError);
});

test("trusted outer transport keeps the plain-function callback receiver", async () => {
  let called = false;
  const f = fixture(echo);
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential: TOKEN,
    transport: async function (this: unknown, url, init) {
      expect(this).toBeUndefined();
      called = true;
      return f.handler.fetch(new Request(url, init));
    },
  });
  try {
    await (await client.fetch(TARGET)).text();
    expect(called).toBe(true);
  } finally {
    await client.close();
    await f.close();
  }
});

for (const status of [307, 308]) {
  test(`manual streamed ${status} returns the redirect without replay`, async () => {
    let calls = 0;
    const f = fixture({
      async fetch(_url, init) {
        calls++;
        expect(await new Response(init.body).text()).toBe("upload");
        return new Response("manual response", { status, headers: { location: "/next" } });
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("upload"));
        controller.close();
      },
    });
    try {
      const response = await f.client.fetch(TARGET, {
        method: "POST",
        body,
        redirect: "manual",
        signal: new AbortController().signal,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBe("/next");
      expect(await response.text()).toBe("manual response");
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test("manual redirects return even when Location cannot be followed", async () => {
  const f = fixture({
    async fetch() {
      return new Response("unfollowed", { status: 302, headers: { location: "http://[" } });
    },
  });
  try {
    const response = await f.client.fetch(TARGET, {
      redirect: "manual",
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(302);
    expect(await response.text()).toBe("unfollowed");
  } finally {
    await f.close();
  }
});

test("inferred body content types reach the target without replacing explicit headers", async () => {
  const observed: (string | null)[] = [];
  const f = fixture({
    async fetch(_url, init) {
      observed.push(init.headers.get("content-type"));
      await new Response(init.body).arrayBuffer();
      return new Response("ok");
    },
  });
  const bodies = [
    new URLSearchParams({ field: "value" }),
    new Blob(["{}"], { type: "application/json" }),
    "plain text",
    new Uint8Array([1, 2]),
  ];
  try {
    for (const body of bodies)
      await (await f.client.fetch(TARGET, { method: "POST", body })).text();
    const expected = bodies.map((body) =>
      new Request(TARGET, { method: "POST", body }).headers.get("content-type"),
    );
    expect(observed).toEqual(expected);
    await (
      await f.client.fetch(TARGET, {
        method: "POST",
        body: new URLSearchParams({ explicit: "value" }),
        headers: { "content-type": "application/owned-fixture" },
      })
    ).text();
    expect(observed.at(-1)).toBe("application/owned-fixture");
  } finally {
    await f.close();
  }
});
