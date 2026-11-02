import { expect, test } from "bun:test";
import { createRelayHandler } from "../src/server.ts";
import { createNodeEgress } from "../src/node-egress.ts";
import { normalizeOptions } from "../src/policy.ts";
import { createRelayFetch } from "../src/client.ts";
import type { RelayServerOptions } from "../src/protocol.ts";

const credential = "owned-fixture-token-only";

test("Node connects to the selected address, resolves once per hop, and keeps original Host", async () => {
  let hits = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits++;
      return new Response(request.headers.get("host"));
    },
  });
  const origin = `http://owned-fixture.invalid:${target.port}`;
  const options: RelayServerOptions = {
    credential,
    allowedOrigins: [],
    destinations: { mode: "fixed-origins", origins: [origin] },
  };
  let lookups = 0;
  const handler = createRelayHandler(
    options,
    createNodeEgress(normalizeOptions(options), undefined, async (hostname) => {
      expect(hostname).toBe("owned-fixture.invalid");
      lookups++;
      return [{ address: "127.0.0.1", family: 4 }];
    }),
  );
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential,
    transport: (url, init) => handler.fetch(new Request(url, init)),
  });
  try {
    for (let hop = 0; hop < 2; hop++)
      expect(await (await client.fetch(origin)).text()).toBe(
        `owned-fixture.invalid:${target.port}`,
      );
    expect(lookups).toBe(2);
    expect(hits).toBe(2);
  } finally {
    await client.close();
    await handler.close();
    await target.stop(true);
  }
});

test("mixed, empty and rebound private DNS answers are denied before connecting", async () => {
  const options: RelayServerOptions = {
    credential,
    allowedOrigins: [],
    destinations: { mode: "public-https" },
  };
  const answers = [
    [],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    [{ address: "169.254.169.254", family: 4 }],
  ];
  let lookups = 0;
  const handler = createRelayHandler(
    options,
    createNodeEgress(normalizeOptions(options), undefined, async () => {
      lookups++;
      return answers.shift() ?? [];
    }),
  );
  const client = createRelayFetch({
    endpoint: "https://relay.example.test",
    credential,
    transport: (url, init) => handler.fetch(new Request(url, init)),
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(client.fetch("https://owned-fixture.invalid/")).rejects.toMatchObject({
        code: "destination-denied",
      });
    expect(lookups).toBe(3);
  } finally {
    await client.close();
    await handler.close();
  }
});
