import { expect, test } from "bun:test";
import { NetHelper, NetNamespace, type NetFetch } from "../browser/net/helper.js";
import { createRing, RingReader } from "../browser/net/ring.js";
import { Kind, type FetchHead } from "../browser/net/protocol.js";
import {
  attachNetFetchResponseMetadata,
  readNetFetchResponseMetadata,
} from "../browser/net/transport.js";

async function head(fetch: NetFetch): Promise<FetchHead> {
  const namespace = await NetNamespace.create();
  const ring = createRing();
  const helper = new NetHelper(ring, fetch, {}, namespace);
  const reader = new RingReader(ring);
  try {
    helper.handle({
      type: "fetch",
      id: 1,
      url: "https://target.example.test/start",
      method: "GET",
      headers: [],
      body: null,
      redirect: "manual",
    });
    for (let turn = 0; turn < 100; turn++) {
      const record = reader.drain().find((entry) => entry.kind === Kind.Head);
      if (record?.kind === Kind.Head) return JSON.parse(new TextDecoder().decode(record.payload));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("No response head");
  } finally {
    helper.dispose();
    namespace.dispose();
  }
}

test("the helper carries only trusted, validated transport target metadata", async () => {
  const result = await head(async () => {
    const response = new Response(null, { status: 202 });
    Object.defineProperty(response, "url", { value: "https://relay.example.test/v1/fetch" });
    attachNetFetchResponseMetadata(response, {
      targetURL: "https://target.example.test/final",
      redirected: true,
    });
    return response;
  });
  expect(result.url).toBe("https://target.example.test/final");
  expect(result.redirected).toBe(true);
});

test("ordinary direct fetch URL and redirect semantics remain unchanged", async () => {
  const result = await head(async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "x-waffle-relay-target-url": "http://private/" },
    });
    Object.defineProperty(response, "url", { value: "https://direct.example.test/final" });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  expect(result.url).toBe("https://direct.example.test/final");
  expect(result.redirected).toBe(true);
  expect(await head(async () => new Response(null))).toMatchObject({
    url: "https://target.example.test/start",
    redirected: false,
  });
});

test("upstream headers and similarly named properties cannot supply metadata", () => {
  const response = new Response(null, { headers: { "x-waffle-relay-meta": "untrusted" } });
  Object.defineProperty(response, "targetURL", { value: "https://untrusted.example.test/" });
  expect(readNetFetchResponseMetadata(response)).toBeUndefined();
  for (const targetURL of [
    "file:///etc/passwd",
    "https://user:pass@target.example.test/",
    "https://target.example.test/#fragment",
  ])
    expect(() =>
      attachNetFetchResponseMetadata(response, { targetURL, redirected: false }),
    ).toThrow();
});
