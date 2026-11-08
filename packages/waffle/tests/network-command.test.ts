import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "waffle/testing/page-runner";
import { FakeDriver } from "./page-runner/fake-driver.js";
import {
  completeNetworkCommand,
  nativeNetworkCommand,
  networkPort,
  networkTargets,
} from "./network-command.js";
import { runNetworkRelayBrowser } from "./network-relay-browser-runner.js";
import { networkBudgets } from "./network-page-contract.js";

for (const failed of [null, 0, 3])
  test(`command preserves phase order, shared deadlines and failure ${failed}`, async () => {
    const root = await mkdtemp(join(process.env.NETWORK_SCRATCH_ROOT ?? tmpdir(), "u-"));
    const path = join(root, "command.json");
    const original = host.runPageSuite;
    const calls: { suite: string; options: host.RunOptions }[] = [];
    const clock = spyOn(globalThis, "setTimeout");
    const run = spyOn(host, "runPageSuite").mockImplementation(
      async (adapter, _create, options) => {
        const index = calls.length;
        calls.push({ suite: adapter.suite, options });
        const id = adapter.inventory()[0]!.id;
        return original(
          {
            suite: adapter.suite,
            inventory: () => [{ id, label: "clock control", request: () => ({}) }],
            budgets: adapter.budgets,
            assets: async () => ({}),
            policy: {
              requireResult: true,
              listIds: () => [id],
              check() {
                if (index === failed) throw new Error("Controlled phase failure");
              },
            },
          },
          () => new FakeDriver("pass", { list: { ids: [id] }, result: true }),
          options,
        );
      },
    );
    const previous = process.env.NETWORK_SCRATCH_ROOT;
    process.env.NETWORK_SCRATCH_ROOT = root;
    const previousPort = process.env.NETWORK_TEST_PORT;
    process.env.NETWORK_TEST_PORT = "0";
    try {
      const exit = await completeNetworkCommand(["chromium", "firefox", "webkit"], {
        resultPath: path,
      });
      expect(exit === 0).toBe(failed === null);
      expect(calls.map((call) => call.suite)).toEqual(
        failed === 0
          ? ["network-browser"]
          : [
              "network-browser",
              "network-browser",
              "network-browser",
              "network-relay-browser",
              "network-relay-browser",
              "network-relay-browser",
            ],
      );
      expect(new Set(calls.map((call) => call.options.signal)).size).toBe(1);
      expect(
        clock.mock.calls.filter((call) => typeof call[1] === "number" && call[1] > 590_000),
      ).toHaveLength(1);
      expect(calls.every((call) => call.options.port === "ephemeral")).toBe(true);
      if (failed !== 0)
        expect(
          calls.slice(0, 3).every((call) => call.options.startedAt === calls[0]?.options.startedAt),
        ).toBe(true);
      const result = JSON.parse(await readFile(path, "utf8"));
      expect(result.complete).toBe(failed === null);
      expect(result.phases).toHaveLength(calls.length);
      expect(calls.every((call) => call.options.startedAt! <= performance.now())).toBe(true);
    } finally {
      run.mockRestore();
      clock.mockRestore();
      if (previous === undefined) delete process.env.NETWORK_SCRATCH_ROOT;
      else process.env.NETWORK_SCRATCH_ROOT = previous;
      if (previousPort === undefined) delete process.env.NETWORK_TEST_PORT;
      else process.env.NETWORK_TEST_PORT = previousPort;
      await rm(root, { recursive: true, force: true });
    }
  });

test("network target, port and budget policy cannot widen or silently downgrade", () => {
  expect(networkTargets(["chromium", "firefox", "webkit", "ios-safari"])).toEqual([
    "chromium",
    "firefox",
    "webkit",
    "ios-safari",
  ]);
  expect(() => networkTargets(["safari"])).toThrow();
  expect(() => networkTargets([])).toThrow();
  expect(networkBudgets()).toEqual({
    hello: 20_000,
    heartbeat: 10_000,
    operation: 20_000,
    case: 600_000,
    group: 600_000,
    run: 600_000,
  });
  const previous = process.env.NETWORK_TEST_PORT;
  try {
    delete process.env.NETWORK_TEST_PORT;
    expect(networkPort()).toBe(43827);
    process.env.NETWORK_TEST_PORT = "0";
    expect(networkPort()).toBe("ephemeral");
    process.env.NETWORK_TEST_PORT = "invalid";
    expect(() => networkPort()).toThrow();
  } finally {
    if (previous === undefined) delete process.env.NETWORK_TEST_PORT;
    else process.env.NETWORK_TEST_PORT = previous;
  }
});

test.skipIf(process.platform === "darwin")(
  "native preconditions fail before any producer and never claim a phase",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "network-precondition-"));
    const path = join(root, "result.json");
    const build = spyOn(Bun, "build").mockImplementation(() => {
      throw new Error("Producer must not run");
    });
    try {
      expect(await nativeNetworkCommand(["--result", path], performance.now())).toBe(3);
      const result = JSON.parse(await readFile(path, "utf8"));
      expect(result.complete).toBe(false);
      expect(result.phases).toEqual([]);
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("standalone relay export rejects an empty target list before preparation", async () => {
  await expect(runNetworkRelayBrowser([])).rejects.toThrow("No network targets selected");
});

test("normal producers build one shared graph with every original worker and WAT variant", async () => {
  const { networkInputs } = await import("./network-page-inputs.js");
  const inputs = networkInputs();
  const context = { signal: new AbortController().signal, scratch: tmpdir() };
  const first = inputs.network(context);
  expect(inputs.network(context)).toBe(first);
  const network = await first;
  expect(
    Object.keys(network)
      .filter((path) => !path.includes("foreign") && !path.includes("sentinel"))
      .sort(),
  ).toEqual([
    "/listener-preview1-worker.js",
    "/network-fs.js",
    "/network-sw.js",
    "/network-worker.js",
    "/network.wasm",
    "/page.js",
    "/preview1-listener.wasm",
  ]);
  const second = inputs.relay(context);
  expect(inputs.relay(context)).toBe(second);
  const relay = await second;
  expect(
    Object.keys(relay)
      .filter((path) => !path.includes("foreign") && !path.includes("sentinel"))
      .sort(),
  ).toEqual([
    "/network.wasm",
    "/page.js",
    "/relay-echo.wasm",
    "/relay-fs.js",
    "/relay-helper-worker.js",
    "/relay-preview1-worker.js",
    "/relay-reset.wasm",
  ]);
  expect(relay["/network.wasm"]).toBe(network["/network.wasm"]);
  for (const value of [
    network["/preview1-listener.wasm"],
    relay["/relay-echo.wasm"],
    relay["/relay-reset.wasm"],
  ]) {
    expect(value).toBeInstanceOf(Blob);
    if (!(value instanceof Blob)) throw new Error("Missing normal WASM module");
    expect(WebAssembly.validate(await value.arrayBuffer())).toBe(true);
  }
  const echo = relay["/relay-echo.wasm"],
    reset = relay["/relay-reset.wasm"];
  if (!(echo instanceof Blob) || !(reset instanceof Blob))
    throw new Error("Missing original relay variants");
  expect(await echo.arrayBuffer()).not.toEqual(await reset.arrayBuffer());
});
