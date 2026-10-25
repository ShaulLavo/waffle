import { expect, test } from "bun:test";
import { body, decode, encode, handle, head, pair, response } from "./loopback-fetch-fixture.js";

test("shared Worker follows a relative loopback redirect before publishing the head", async () => {
  const { server, client, listener, url } = await pair();
  const first = server.call({
    op: "respond",
    listener,
    bytes: response(302, "Location: ./final?ok=1\r\n"),
  });
  const id = await handle(client, { op: "fetch", url: `${url}/dir/start` });
  await first;
  const final = server.call({ op: "respond", listener, bytes: response(200, "", "done") });
  expect(await head(client, id)).toMatchObject({
    status: 200,
    url: `${url}/dir/final?ok=1`,
    redirected: true,
  });
  expect(decode(await body(client, id))).toBe("done");
  expect(await final).toMatchObject({
    request: expect.stringContaining("GET /dir/final?ok=1 HTTP/1.1"),
  });
});

test.each(["manual", "error"] satisfies RequestRedirect[])(
  "shared Worker redirect=%s",
  async (redirect) => {
    const { server, client, listener, url } = await pair();
    const served = server.call({
      op: "respond",
      listener,
      bytes: response(302, "Location: /final\r\n", "redirect body"),
    });
    const id = await handle(client, { op: "fetch", url, redirect });
    await served;
    if (redirect === "error") {
      expect(await head(client, id)).toBe(-1);
      expect(await client.call({ op: "error", handle: id })).toContain("redirect mode is error");
      return;
    }
    expect(await head(client, id)).toMatchObject({
      status: 302,
      url: `${url}/`,
      redirected: false,
    });
    expect(decode(await body(client, id))).toBe("redirect body");
  },
);

test.each([
  [301, "POST", "GET", ""],
  [302, "POST", "GET", ""],
  [303, "PUT", "GET", ""],
  [303, "HEAD", "HEAD", ""],
  [301, "PUT", "PUT", "payload"],
  [307, "POST", "POST", "payload"],
  [308, "POST", "POST", "payload"],
])(
  "shared Worker status %s changes %s to %s",
  async (status, method, expectedMethod, expectedBody) => {
    const { server, client, listener, url } = await pair();
    const first = server.call({
      op: "respond",
      listener,
      bytes: response(Number(status), "Location: /final\r\n"),
    });
    const id = await handle(client, {
      op: "fetch",
      url,
      method: String(method),
      body: encode("payload"),
      headers: [["content-type", "text/plain"]],
    });
    await first;
    const final = server.call({ op: "respond", listener, bytes: response(200, "") });
    expect(await head(client, id)).toMatchObject({ status: 200, redirected: true });
    await body(client, id);
    const result = await final;
    if (typeof result !== "object" || result === null || !("request" in result))
      throw Error("Missing request");
    expect(result.request).toEqual(expect.stringContaining(`${expectedMethod} /final HTTP/1.1`));
    expect(result.request).toEqual(
      expect.stringMatching(new RegExp(`\\r\\n\\r\\n${expectedBody}$`)),
    );
    if (expectedMethod === "GET") expect(result.request).not.toContain("content-type:");
  },
);

test("redirect without Location retains the response body", async () => {
  const { server, client, listener, url } = await pair();
  const served = server.call({
    op: "respond",
    listener,
    bytes: response(302, "", "not redirected"),
  });
  const id = await handle(client, { op: "fetch", url });
  expect(await head(client, id)).toMatchObject({ status: 302, redirected: false });
  expect(decode(await body(client, id))).toBe("not redirected");
  await served;
});

test("shared Worker crosses external policy in both directions and strips credentials", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const { server, client, listener, url } = await pair(async (target, options) => {
    calls.push({ url: target, options });
    return new Response(null, { status: 307, headers: { location: `${url}/final` } });
  });
  const first = server.call({
    op: "respond",
    listener,
    bytes: response(302, "Location: https://fixture.invalid/next\r\n"),
  });
  const id = await handle(client, {
    op: "fetch",
    url,
    headers: [
      ["authorization", "secret"],
      ["cookie", "secret"],
      ["x-keep", "yes"],
    ],
  });
  await first;
  const final = server.call({ op: "respond", listener, bytes: response(200, "", "done") });
  expect(await head(client, id)).toMatchObject({
    status: 200,
    url: `${url}/final`,
    redirected: true,
  });
  expect(decode(await body(client, id))).toBe("done");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "https://fixture.invalid/next",
    options: { redirect: "manual", headers: [["x-keep", "yes"]] },
  });
  expect(await final).toMatchObject({ request: expect.not.stringContaining("secret") });
});

test("destination policy failure rejects a loopback redirect", async () => {
  const { server, client, listener, url } = await pair();
  const served = server.call({
    op: "respond",
    listener,
    bytes: response(302, "Location: https://fixture.invalid/denied\r\n"),
  });
  const id = await handle(client, { op: "fetch", url });
  await served;
  expect(await head(client, id)).toBe(-1);
  expect(await client.call({ op: "error", handle: id })).toContain("Outbound denied");
});

test.each(["file:///denied", "http://user:pass@fixture.invalid/", "http://["])(
  "rejects invalid destination %s",
  async (location) => {
    const { server, client, listener, url } = await pair();
    const served = server.call({
      op: "respond",
      listener,
      bytes: response(302, `Location: ${location}\r\n`),
    });
    const id = await handle(client, { op: "fetch", url });
    await served;
    expect(await head(client, id)).toBe(-1);
  },
);

test("shared Worker follows at most twenty redirects", async () => {
  const { server, client, listener, url } = await pair();
  const serving = (async () => {
    for (let index = 0; index <= 20; index++)
      await server.call({ op: "respond", listener, bytes: response(302, "Location: /again\r\n") });
  })();
  const id = await handle(client, { op: "fetch", url });
  expect(await head(client, id)).toBe(-1);
  expect(await client.call({ op: "error", handle: id })).toContain("redirect limit");
  await serving;
});

test("closing a redirected fetch aborts the pending destination", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const { server, client, listener, url } = await pair(async (_target, options) => {
    entered.resolve();
    return new Promise((_resolve, reject) =>
      options.signal?.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          reject(options.signal?.reason);
        },
        { once: true },
      ),
    );
  });
  const served = server.call({
    op: "respond",
    listener,
    bytes: response(302, "Location: https://fixture.invalid/pending\r\n"),
  });
  const id = await handle(client, { op: "fetch", url });
  await served;
  await entered.promise;
  await client.call({ op: "close", handle: id });
  await aborted.promise;
  expect(await client.call({ op: "head", handle: id })).toBe(-3);
});
