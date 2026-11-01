import assert from "node:assert/strict";
import { mock } from "bun:test";
import type { NodeWebTransportRelayOptions } from "../src/node-webtransport.js";
import { snapshotWebTransportAddress } from "../src/webtransport-address.js";

const mode = process.argv[2];
if (mode === "browser") await verifyBrowserFixture();
else await verifyConstructionBoundary(mode);

async function verifyBrowserFixture(): Promise<void> {
  const { createNodeRelayServer } = await import("../src/node.js");
  const entry = new URL("../src/node-webtransport.ts", import.meta.url).pathname;
  mock.module(entry, () => ({
    createNodeWebTransportRelayServer(options: NodeWebTransportRelayOptions) {
      snapshotWebTransportAddress(options.tcp.webtransport);
      return createNodeRelayServer(options);
    },
  }));
  const { createRelayBrowserFixture } = await import("../../waffle/tests/network-relay-fixture.js");
  const fixture = createRelayBrowserFixture();
  try {
    const config = await fixture.start("https://fixture.example", true);
    assert.equal(config.native, true);
    assert.equal((await fetch(new URL("/healthz", config.endpoint))).status, 200);
  } finally {
    await fixture.close();
  }
}

async function verifyConstructionBoundary(mode: string | undefined): Promise<void> {
  let constructions = 0;
  const reached = new Error("HTTP construction reached");
  mock.module("@fails-components/webtransport", () => ({ Http3Server: class {} }));
  const entry = new URL("../src/node-server.ts", import.meta.url).pathname;
  mock.module(entry, () => ({
    createNodeServer() {
      constructions++;
      throw reached;
    },
  }));
  const { createNativeRelay } = await import("../src/node-webtransport-internal.js");
  const create = (webtransport: object) =>
    createNativeRelay(
      {
        credential: "boundary-fixture-http",
        allowedOrigins: ["https://fixture.example"],
        tcp: { tokenSecret: new Uint8Array(32), destinations: [], webtransport },
      } as NodeWebTransportRelayOptions,
      {} as never,
    );
  const bind = { host: "127.0.0.1", port: 4433 };
  if (mode === "callback") {
    let reads = 0;
    const selected = {
      bind,
      get onEndpointFailure() {
        reads++;
        return () => {};
      },
    };
    assert.throws(
      () => create(selected),
      (error: unknown) => error === reached,
    );
    assert.equal(reads, 1);
    return;
  }
  assert.equal(mode, "keys");
  const unknownCertificate = {
    get cert() {
      throw new Error("Unknown certificate fields must fail before reading material");
    },
    key: "invalid",
    extra: true,
  };
  const invalid = [
    { bind, host: "127.0.0.1", port: 4433 },
    { bind, advertisedURL: "https://relay.example/v1/tcp/wt" },
    { bind: { ...bind, family: 4 } },
    { bind, certificate: unknownCertificate },
    { bind, certificate: false },
    { bind, certificate: null },
    { bind, certificate: 0 },
    { bind, certificate: "" },
    { bind, certificate: [] },
    { bind, onEndpointFailure: false },
    { bind, rotationMs: null },
  ];
  for (const options of invalid) assert.throws(() => create(options), TypeError);
  assert.equal(constructions, 0);
  assert.throws(
    () => create({ bind }),
    (error: unknown) => error === reached,
  );
  assert.throws(
    () => create({ bind, certificate: "rotating-hash" }),
    (error: unknown) => error === reached,
  );
  assert.equal(constructions, 2);
}
