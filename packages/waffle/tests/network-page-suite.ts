import assert from "node:assert/strict";
import type { SuiteAdapter } from "waffle/testing/page-runner";
import { createRelayBrowserFixture } from "./network-relay-fixture.js";
import {
  networkBudgets,
  networkId,
  networkLabels,
  relayId,
  type NetworkTarget,
} from "./network-page-contract.js";
import type { NetworkInputs } from "./network-page-inputs.js";
import type { RelayModeResult } from "./network-relay-contract.js";

function inventory(id: string) {
  return [{ id, label: "complete", request: () => null }];
}
function listIds(id: string, value: unknown): string[] {
  assert.deepEqual(value, { ids: [id] }, "Wrong complete network inventory");
  return [id];
}
export function networkAdapter(inputs: NetworkInputs): SuiteAdapter<null> {
  return {
    suite: "network-browser",
    inventory: () => inventory(networkId),
    serviceWorker: { caseId: networkId, script: "/network-sw.js" },
    assets: inputs.network,
    budgets: networkBudgets,
    policy: {
      requireResult: true,
      listIds: (value) => listIds(networkId, value),
      check: (_id, value) => assert.deepEqual(value, networkLabels, "Incomplete network result"),
    },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected relay object");
  return value;
}
function count(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "Invalid relay count",
  );
  return value;
}
function relayResult(value: unknown): RelayModeResult {
  const result = object(value),
    probe = object(result.probe),
    preview1 = object(result.preview1);
  assert.deepEqual(Object.keys(result).sort(), [
    "carrier",
    "fallbackMs",
    "helperBytes",
    "mode",
    "preview1",
    "probe",
  ]);
  assert.deepEqual(Object.keys(probe).sort(), [
    "closed",
    "constructed",
    "failures",
    "fragments",
    "ready",
    "streams",
  ]);
  assert.deepEqual(Object.keys(preview1).sort(), ["denied", "echo", "reset"]);
  const { mode, carrier } = result;
  assert.ok(mode === "selected" || mode === "websocket" || mode === "bad-certificate");
  assert.ok(carrier === "webtransport" || carrier === "websocket");
  assert.ok(
    Array.isArray(probe.failures) &&
      probe.failures.every((item: unknown) => typeof item === "string"),
  );
  return {
    mode,
    carrier,
    probe: {
      constructed: count(probe.constructed),
      ready: count(probe.ready),
      streams: count(probe.streams),
      fragments: count(probe.fragments),
      closed: count(probe.closed),
      failures: probe.failures,
    },
    helperBytes: count(result.helperBytes),
    fallbackMs: count(result.fallbackMs),
    preview1: {
      echo: count(preview1.echo),
      denied: count(preview1.denied),
      reset: count(preview1.reset),
    },
  };
}
export function relayAdapter(inputs: NetworkInputs, target: NetworkTarget): SuiteAdapter<null> {
  const fixture = createRelayBrowserFixture();
  let created = false;
  return {
    suite: "network-relay-browser",
    inventory: () => inventory(relayId),
    assets: inputs.relay,
    budgets: networkBudgets,
    fixture: {
      caseId: relayId,
      create() {
        assert.ok(!created, "Relay adapter is single-run");
        created = true;
        return {
          async start({ origin, signal }) {
            const config = await fixture.start(origin, target !== "webkit", signal);
            return [
              { path: "/relay-config", get: async () => config },
              {
                path: "/relay-idle",
                get: async ({ signal }) => (await fixture.idle(signal)).json(),
              },
            ];
          },
          close: fixture.close,
        };
      },
    },
    policy: {
      requireResult: true,
      listIds: (value) => listIds(relayId, value),
      check(_id, value) {
        assert.ok(Array.isArray(value), "Missing complete relay results");
        const results = value.map(relayResult);
        assert.deepEqual(
          results.map((result) => result.mode),
          target === "webkit" ? ["websocket"] : ["selected", "websocket", "bad-certificate"],
        );
        fixture.verify(results.map((result) => result.carrier));
        if (target !== "webkit")
          assert.equal(
            results[0]?.carrier,
            "webtransport",
            `${target}'s real complete WebTransport probe failed`,
          );
        console.log(JSON.stringify({ browser: target, results: value }));
      },
    },
  };
}
