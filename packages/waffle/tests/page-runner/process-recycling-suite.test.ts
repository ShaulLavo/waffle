import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processBrowserCases } from "../process-recycling-browser.js";
import { Collector } from "./collector.js";
import { FakeDriver, type FakeCommand, type FakeMode } from "./fake-driver.js";
import { runPageSuite } from "waffle/testing/page-runner";
import { processRecyclingAdapter } from "./process-recycling-suite.js";

const labels = processBrowserCases();
const first = labels[0]!;

test("process command uses the entire original ordered inventory and original absolute clock", () => {
  const adapter = processRecyclingAdapter;
  expect(adapter.inventory().map((item) => item.id)).toEqual(labels);
  expect(adapter.inventory().map((item) => item.label)).toEqual(labels);
  expect(adapter.inventory().map((item) => item.request("run"))).toEqual(
    labels.map((label) => ({ label })),
  );
  expect(adapter.budgets(1)).toEqual(adapter.budgets(labels.length));
  expect(adapter.budgets(labels.length)).toEqual({
    hello: 30_000,
    heartbeat: 10_000,
    case: 600_000,
    group: 600_000,
    run: 600_000,
  });
  expect(adapter.policy.listIds(labels)).toEqual(labels);
});

for (const inventory of [labels.toReversed(), labels.slice(1), labels.concat([first]), []])
  test(`rejects altered process discovery ${inventory.length}`, () => {
    expect(() => processRecyclingAdapter.policy.listIds(inventory)).toThrow();
  });

for (const returned of [undefined, "invented", { label: first }, [first]])
  test(`rejects invented process completion ${JSON.stringify(returned)}`, () => {
    expect(() => processRecyclingAdapter.policy.check?.(first, returned)).toThrow();
  });

test("process policy forbids durable allocations before ledger insertion or acknowledgement", () => {
  const collector = new Collector("run", labels, [first], processRecyclingAdapter.policy);
  const state = collector.expect(
    { id: first, role: "case", caseIds: [first] }, "token", "http://test/", "root",
  );
  collector.receive({ run: "run", doc: "doc", seq: 0, kind: "hello", token: "token", group: first });
  collector.receive({ run: "run", doc: "doc", seq: 1, kind: "case-start", caseId: first });
  expect(() => collector.receive({
    run: "run", doc: "doc", seq: 2, kind: "allocation",
    entry: { kind: "indexeddb", name: "unowned" },
  })).toThrow("no durable allocations");
  expect(collector.ledger).toEqual([]);
  expect(state.messages).toHaveLength(2);
});

async function fake(mode: FakeMode, command: FakeCommand, startedAt?: number) {
  const root = await mkdtemp(join(tmpdir(), "w-pr-control-"));
  const scratch = join(root, "scratch");
  const driver = new FakeDriver(mode, command);
  try {
    const resultPath = join(root, "result.json");
    const result = await runPageSuite(processRecyclingAdapter, () => driver, {
      resultPath, scratchRoot: scratch, filter: first, startedAt, assets: {},
    });
    expect(await Bun.file(resultPath).json()).toEqual(result);
    expect(result.required).toEqual(labels);
    expect(result.selected).toEqual([first]);
    expect(result.omitted).toEqual(labels.slice(1));
    expect(result.ledger).toEqual([]);
    expect(result.cleanup.storage.status).toBe("not-created");
    expect(result.cleanup.session.status).toBe("confirmed");
    expect(result.cleanup.scratch.status).toBe(startedAt === undefined ? "confirmed" : "not-created");
    if (startedAt === undefined) expect(await readdir(scratch)).toEqual([]);
    return { result, driver };
  } finally {
    await driver.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("filtered actual label stays a partial result rather than a full command pass", async () => {
  const { result } = await fake("pass", { list: labels, result: first });
  expect(result.exit).toBe(4);
  expect(result.outcomes[first]).toEqual({ status: "pass", provisional: false });
  expect(result.results[first]).toBe(first);
  expect(result.runComplete).toBe(true);
});

for (const mode of ["assertion", "finish-error", "close", "reload", "driver-lost"] as const)
  test(`process host retains ${mode} as failure and tears down`, async () => {
    const { result } = await fake(mode, { list: labels, result: first });
    expect(result.exit).not.toBe(0);
    expect(result.exit).not.toBe(4);
  });

test("process host retains the actual wrong label rather than substituting the request", async () => {
  const { result } = await fake("pass", { list: labels, result: "invented" });
  expect(result.exit).toBe(4);
  expect(result.results[first]).toBe("invented");
  expect(result.outcomes[first]?.status).toBe("fail");
});

test("absolute process deadline includes time spent before native imports and setup", async () => {
  const { result, driver } = await fake("pass", { list: labels, result: first }, performance.now() - 600_001);
  expect(result.exit).toBe(2);
  expect(result.failures.some((entry) => entry.category === "run-timeout")).toBe(true);
  expect(driver.navigations).toBe(0);
});
