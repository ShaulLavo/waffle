import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandAdapter, type CommandRequest } from "./command-suites.js";
import { checkedGuestWatchControl } from "./guest-watch-controls-runner.js";
import { FakeDriver, type FakeCommand, type FakeMode } from "./fake-driver.js";
import { runPageSuite, type RunOptions, type SuiteAdapter } from "./suite-host.js";

async function control(
  adapter: SuiteAdapter<CommandRequest>,
  command: Omit<FakeCommand, "list"> & { list?: unknown },
  mode: FakeMode = "pass",
  options: Partial<RunOptions> = {},
) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "cmd-host-"));
  const ids = adapter.inventory().map((item) => item.id);
  const driver = new FakeDriver(mode, { list: { ids }, ...command });
  try {
    const result = await runPageSuite(adapter, () => driver, {
      assets: {},
      resultPath: join(root, "result.json"),
      scratchRoot: root,
      budgets: { hello: 500, heartbeat: 500, case: 600, group: 800, run: 6000 },
      ...options,
    });
    expect(await Bun.file(join(root, "result.json")).json()).toEqual(result);
    expect(driver.stopCalls).toBe(options.signal?.aborted ? 0 : 1);
    expect(result.cleanup.storage).toEqual({
      status: "not-created",
      detail: "suite declares no durable allocations",
    });
    expect(result.ledger).toEqual([]);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const guest = commandAdapter("guest-watch");
test("one command retains the actual result and retires every document", async () => {
  const actual = { early: 101, late: 99, quietWakes: 4, relay: { iterations: 200_000 } };
  const result = await control(guest, { result: actual });
  expect(result.suite).toBe("guest-watch");
  expect(result.required).toHaveLength(1);
  expect(result.selected).toEqual(result.required);
  expect(result.omitted).toEqual([]);
  expect(result.results).toEqual({ ["guest-watch: guestWatchCase"]: actual });
  expect(result.documents.map((doc) => doc.group)).toEqual([
    "list",
    "guest-watch: guestWatchCase",
    "finish",
  ]);
  expect(result.documents.every((doc) => doc.doc !== null && doc.cutoff !== null)).toBe(true);
  expect(Object.values(result.outcomes)).toEqual([{ status: "pass", provisional: false }]);
  expect(result.failures).toEqual([]);
  expect(result.exit).toBe(0);
});
for (const actual of [
  null,
  [],
  "200",
  { early: null, late: 200 },
  { early: true, late: 199 },
  { early: -1, late: 201 },
  { early: 0.5, late: 199.5 },
  { early: 1 },
  { early: 1, late: 198 },
]) {
  test(`guest result check fails without a protocol error for ${JSON.stringify(actual)}`, async () => {
    const result = await control(guest, { result: actual });
    expect(result.exit).toBe(1);
    expect(result.runComplete).toBe(true);
    expect(result.results).toEqual({ ["guest-watch: guestWatchCase"]: actual });
    expect(result.failures).toEqual([]);
    expect(Object.values(result.outcomes)[0]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("Host assertion"),
    });
  });
}
test("wrong socket labels retain the returned array and exit 1", async () => {
  const actual = ["wrong", "labels"];
  const result = await control(commandAdapter("fs-socket-attachment"), { result: actual });
  expect(result.exit).toBe(1);
  expect(Object.values(result.results)).toEqual([actual]);
  expect(result.failures).toEqual([]);
});
for (const list of [
  null,
  {},
  { ids: [2] },
  { ids: [] },
  { ids: ["foreign"] },
  { ids: ["x", "x"] },
]) {
  test(`malformed or incomplete command inventory fails ${JSON.stringify(list)}`, async () => {
    const result = await control(guest, {
      list,
      result: { early: 100, late: 100, relay: { iterations: 200_000 } },
    });
    expect(result.exit).toBe(2);
    expect(result.results).toEqual({});
    expect(result.failures.some((item) => item.category === "protocol")).toBe(true);
  });
}
test("missing result is a protocol failure rather than a host assertion", async () => {
  const result = await control(guest, {});
  expect(result.exit).toBe(2);
  expect(result.results).toEqual({});
  expect(
    result.failures.some((item) => item.detail.includes("Missing required command result")),
  ).toBe(true);
});
test("direct multibyte overflow cannot bypass the collector result bound", async () => {
  const result = await control(guest, { result: { text: "界".repeat(17_000) } });
  expect(result.exit).toBe(2);
  expect(result.results).toEqual({});
  expect(result.failures.some((item) => item.detail.includes("oversized"))).toBe(true);
});
test("a pass without retirement is not final success", async () => {
  const result = await control(
    guest,
    { result: { early: 100, late: 100, relay: { iterations: 200_000 } } },
    "unretired",
  );
  expect(result.exit).toBe(2);
  expect(Object.values(result.outcomes)).toEqual([{ status: "pass", provisional: true }]);
});
test("command allocations are rejected and interrupted finish grants no cleanup authority", async () => {
  const result = await control(guest, {
    result: { early: 100, late: 100, relay: { iterations: 200_000 } },
    allocation: { kind: "indexeddb", name: "foreign" },
  });
  expect(result.exit).toBe(2);
  expect(result.runComplete).toBe(true);
  expect(result.documents.at(-1)?.group).toBe("cleanup-finish");
  expect(result.failures.some((item) => item.category === "protocol")).toBe(true);
});
test("pre-entry interruption creates no command storage or driver", async () => {
  const result = await control(guest, {}, "pass", { signal: AbortSignal.abort("cancelled") });
  expect(result.exit).toBe(2);
  expect(result.documents).toEqual([]);
  expect(result.cleanup.session.status).toBe("not-created");
});

for (const relay of [
  undefined,
  null,
  {},
  { iterations: 0 },
  { iterations: 199_999 },
  { iterations: "200000" },
]) {
  test(`guest watch cannot pass without complete relay result ${JSON.stringify(relay)}`, async () => {
    const actual = { early: 100, late: 100, relay };
    const result = await control(guest, { result: actual });
    expect(result.exit).toBe(1);
    expect(() => checkedGuestWatchControl(result, "missing-relay")).not.toThrow();
    expect(result.runComplete).toBe(true);
    expect(Object.values(result.results)).toEqual([actual]);
    expect(result.failures).toEqual([]);
    expect(Object.values(result.outcomes)[0]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("relay proof did not finish"),
    });
  });
}
