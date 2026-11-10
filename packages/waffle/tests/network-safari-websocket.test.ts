import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPageSuite } from "waffle/testing/page-runner";
import { createRelayConnect } from "../../waffle-relay/src/tcp-client.js";
import { createNodeWebSocket } from "../../waffle-relay/src/node-websocket.js";
import * as fixtures from "./network-relay-fixture.js";
import { networkAdapter, relayAdapter } from "./network-page-suite.js";
import { networkInputs } from "./network-page-inputs.js";
import { networkBudgets, networkId, networkLabels, relayId } from "./network-page-contract.js";
import { NetworkDesktopDriver } from "./network-desktop-driver.js";
import type { RelayModeResult } from "./network-relay-contract.js";

function websocketResult(): RelayModeResult {
  return {
    mode: "websocket",
    carrier: "websocket",
    probe: { constructed: 0, ready: 0, streams: 0, fragments: 0, closed: 0, failures: [] },
    helperBytes: 98317,
    preview1: { echo: 0, denied: 2, reset: 15 },
    fallbackMs: 100,
  };
}
function nativeResults(): RelayModeResult[] {
  return [
    {
      ...websocketResult(),
      mode: "selected",
      carrier: "webtransport",
      probe: { constructed: 1, ready: 1, streams: 1, fragments: 3, closed: 1, failures: [] },
    },
    websocketResult(),
    {
      ...websocketResult(),
      mode: "bad-certificate",
      probe: {
        constructed: 1,
        ready: 0,
        streams: 0,
        fragments: 0,
        closed: 1,
        failures: ["native readiness rejected"],
      },
    },
  ];
}

for (const target of ["ios-safari", "webkit"] as const)
  test(`${target} starts the real WebSocket-only fixture and demands complete results`, async () => {
    const adapter = relayAdapter(networkInputs(), target);
    const fixture = adapter.fixture!.create();
    const origin = "http://127.0.0.1:12345";
    let client: ReturnType<typeof createRelayConnect> | undefined;
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      const routes = await fixture.start({
        origin,
        run: "cpu-profile",
        scratch: tmpdir(),
        signal: new AbortController().signal,
      });
      const config = await routes
        .find((route) => route.path === "/relay-config")!
        .get({ signal: new AbortController().signal });
      assert.ok(config && typeof config === "object");
      assert.ok("endpoint" in config && typeof config.endpoint === "string");
      assert.ok("token" in config && typeof config.token === "string");
      const token = config.token;
      expect(config).toHaveProperty("native", false);
      const session = await fetch(new URL("v1/tcp/session", config.endpoint), {
        method: "POST",
        headers: { origin, authorization: `Bearer ${config.token}` },
      });
      expect(await session.json()).toEqual({ v: 1, webtransport: null });
      expect(() => adapter.policy.check(relayId, [websocketResult()])).toThrow(
        "No actual websocket echo admission",
      );
      client = createRelayConnect({
        endpoint: config.endpoint,
        getToken: () => token,
        carriers: ["websocket"],
        webSocket: createNodeWebSocket(origin),
        webTransport() {
          throw new Error("WebSocket profile must never attempt WebTransport");
        },
      });
      await exchange(client, "echo.waffle.test", 9000, new TextEncoder().encode("profile echo\n"));
      await exchange(client, "ssl.waffle.test", 5432, Uint8Array.of(0, 0, 0, 8, 4, 210, 22, 47));
      await client.close();
      expect(client.carrier).toBe("websocket");
      expect(() => adapter.policy.check(relayId, [websocketResult()])).not.toThrow();
      const logged = output.mock.calls
        .map(([value]) => JSON.parse(String(value)))
        .find((value) => value.browser === target);
      expect(logged.profile).toBe("websocket-only");
      if (target === "ios-safari")
        expect(logged.deferred).toMatchObject({
          modes: ["selected", "bad-certificate"],
          status: "deferred",
        });
      else expect(logged.deferred).toBeUndefined();
      for (const value of invalidWebSocketResults())
        expect(() => adapter.policy.check(relayId, value), JSON.stringify(value)).toThrow();
      expect(adapter.budgets(1)).toEqual(networkBudgets());
      const idle = await routes
        .find((route) => route.path === "/relay-idle")!
        .get({ signal: new AbortController().signal });
      expect(idle).toEqual({ sockets: 0, active: 0 });
    } finally {
      await client?.close();
      await fixture.close();
      output.mockRestore();
    }
  });

async function exchange(
  client: ReturnType<typeof createRelayConnect>,
  host: string,
  port: number,
  bytes: Uint8Array,
): Promise<void> {
  const stream = await client.connect({ host, port }, new AbortController().signal);
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const reader = stream.readable.getReader();
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
  }
  expect(size).toBe(host === "echo.waffle.test" ? bytes.length : 1);
}

function invalidWebSocketResults(): unknown[] {
  const result = websocketResult();
  return [
    undefined,
    null,
    {},
    [],
    [result, result],
    nativeResults(),
    [{ ...result, mode: "selected" }],
    [{ ...result, mode: "bad-certificate" }],
    [{ ...result, carrier: "webtransport" }],
    [{ ...result, helperBytes: 0 }],
    [{ ...result, helperBytes: 98316 }],
    [{ ...result, fallbackMs: 15000 }],
    [{ ...result, fallbackMs: -1 }],
    [{ ...result, helperBytes: NaN }],
    [{ ...result, preview1: { echo: 0, denied: 0, reset: 15 } }],
    [{ ...result, preview1: { echo: 1, denied: 2, reset: 15 } }],
    [{ ...result, preview1: { echo: 0, denied: 2, reset: 0 } }],
    [{ ...result, preview1: { echo: 0, reset: 15 } }],
    [{ ...result, probe: { ...result.probe, failures: ["attempted native fallback"] } }],
    [{ ...result, probe: { ...result.probe, constructed: 1, closed: 1 } }],
    [{ ...result, extra: true }],
    [{ ...result, probe: {} }],
  ].concat(
    ["constructed", "ready", "streams", "fragments", "closed"].map((field) => [
      { ...result, probe: { ...result.probe, [field]: 1 } },
    ]),
  );
}

for (const target of ["chromium", "firefox"] as const) {
  test(`${target} still requests a native fixture before any browser workload`, async () => {
    const original = fixtures.createRelayBrowserFixture;
    const requested: boolean[] = [];
    const create = spyOn(fixtures, "createRelayBrowserFixture").mockImplementation(() => {
      const fixture = original();
      fixture.start = async (_origin, native) => {
        requested.push(native);
        throw new Error("Native startup observed, not executed in CPU control");
      };
      return fixture;
    });
    const fixture = relayAdapter(networkInputs(), target).fixture!.create();
    try {
      await expect(
        fixture.start({
          origin: "http://127.0.0.1:12345",
          run: "cpu-native",
          scratch: tmpdir(),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Native startup observed");
      expect(requested).toEqual([true]);
    } finally {
      create.mockRestore();
      await fixture.close();
    }
  });
  test(`${target} retains genuine WebTransport, certificate and complete-mode requirements`, () => {
    const adapter = relayAdapter(networkInputs(), target);
    expect(() => adapter.policy.check(relayId, [websocketResult()])).toThrow();
    for (const omitted of [0, 1, 2])
      expect(() =>
        adapter.policy.check(
          relayId,
          nativeResults().filter((_item, index) => index !== omitted),
        ),
      ).toThrow();
    const wrongCarrier = nativeResults();
    wrongCarrier[0] = { ...websocketResult(), mode: "selected" };
    expect(() => adapter.policy.check(relayId, wrongCarrier)).toThrow(
      "Real complete WebTransport probe failed",
    );
    for (const field of ["ready", "streams", "fragments"] as const) {
      const partial = nativeResults();
      partial[0] = { ...partial[0]!, probe: { ...partial[0]!.probe, [field]: 0 } };
      expect(() => adapter.policy.check(relayId, partial)).toThrow();
    }
    const certificate = nativeResults();
    certificate[2] = { ...websocketResult(), mode: "bad-certificate" };
    expect(() => adapter.policy.check(relayId, certificate)).toThrow(
      "Bad certificate did not reject",
    );
    expect(() => adapter.policy.check(relayId, nativeResults())).toThrow();
  });
}

test("Safari retains the complete first network phase and original budgets", () => {
  const adapter = networkAdapter(networkInputs());
  expect(networkLabels).toHaveLength(11);
  expect(() => adapter.policy.check(networkId, networkLabels)).not.toThrow();
  for (let omitted = 0; omitted < networkLabels.length; omitted++)
    expect(() =>
      adapter.policy.check(
        networkId,
        networkLabels.filter((_label, index) => index !== omitted),
      ),
    ).toThrow();
  expect(adapter.budgets(1)).toEqual(networkBudgets());
});

function expectCleanupConfirmed(
  cleanup: Awaited<ReturnType<typeof runPageSuite>>["cleanup"],
): void {
  for (const entry of Object.values(cleanup)) {
    if (typeof entry === "object") expect(entry.status).not.toBe("unconfirmed");
  }
}

test.skipIf(process.env.NETWORK_SAFARI_WEBSOCKET_CONTROLS !== "1")(
  "desktop Chromium profile parity executes the unchanged Safari WebSocket relay adapter, not native evidence",
  async () => {
    const scratch = await mkdtemp(join(process.env.NETWORK_SCRATCH_ROOT ?? tmpdir(), "sw-"));
    try {
      const result = await runPageSuite(
        relayAdapter(networkInputs(), "ios-safari"),
        (owned) => new NetworkDesktopDriver("chromium", owned),
        {
          scratchRoot: scratch,
          resultPath: process.env.NETWORK_SAFARI_PROFILE_RESULT ?? join(scratch, "result.json"),
          port: "ephemeral",
        },
      );
      expect(result.exit).toBe(0);
      expect(result.runComplete).toBe(true);
      expect(result.omitted).toEqual([]);
      expectCleanupConfirmed(result.cleanup);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  600_000,
);
