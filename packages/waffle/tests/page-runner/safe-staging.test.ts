import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeStagingLabels } from "../safe-staging-browser.js";
import { stagingDatabaseName } from "./safe-staging-allocation.js";
import { safeStagingAdapter, safeStagingId } from "./safe-staging-suite.js";
import { FakeDriver } from "./fake-driver.js";
import { runPageSuite } from "./suite-host.js";
import { nativeMain } from "./native.js";

const run = "b3912068-3872-4a01-a79b-ed67c9fcd7c5";
const labels = safeStagingLabels();
const adapter = safeStagingAdapter();

test("the complete inventory follows the original case table and its order", async () => {
  const source = await Bun.file(new URL("../safe-staging-browser.ts", import.meta.url)).text();
  const table = /const cases = \{\n([\s\S]*?)\n\};/.exec(source)?.[1];
  expect(table).toBeDefined();
  expect(
    table
      ?.trim()
      .split(",")
      .filter(Boolean)
      .map((label) => label.trim()),
  ).toEqual(labels);
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels.filter((label) => label === "checkpointDecodeBounds")).toHaveLength(1);
  expect(adapter.policy.listIds({ labels })).toEqual([safeStagingId]);
  expect(adapter.inventory().map((entry) => entry.id)).toEqual([safeStagingId]);
});
test("staging keeps the original whole-command deadline, not one clock per label", () => {
  expect(adapter.budgets(labels.length)).toEqual({
    hello: 20_000,
    heartbeat: 10_000,
    case: 180_000,
    group: 180_000,
    run: 180_000,
  });
});
for (const wrong of [labels.slice(1), labels.toReversed(), labels.concat(labels[0]!), [], null]) {
  test(`incomplete or reordered labels cannot pass ${JSON.stringify(wrong)}`, () => {
    expect(() => adapter.policy.listIds({ labels: wrong })).toThrow();
    expect(() => adapter.policy.check(safeStagingId, wrong)).toThrow();
  });
}
test("exact allocation policy rejects foreign runs, kinds, suffixes and inactive commands", () => {
  const name = `waffle-staged-test-${run}-${crypto.randomUUID()}`;
  expect(() =>
    adapter.policy.allocation?.({ kind: "indexeddb", name }, [safeStagingId], run),
  ).not.toThrow();
  for (const entry of [
    { kind: "indexeddb", name: `checkpoint-decoder-r30-${run}-${crypto.randomUUID()}` },
  ] as const)
    expect(() => adapter.policy.allocation?.(entry, [safeStagingId], run)).not.toThrow();
  for (const entry of [
    { kind: "opfs-directory", name },
    { kind: "indexeddb", name: `waffle-staged-test-other-${crypto.randomUUID()}` },
    { kind: "indexeddb", name: `${name}-extra` },
    { kind: "indexeddb", name: `foreign-${run}-${crypto.randomUUID()}` },
  ] as const)
    expect(() => adapter.policy.allocation?.(entry, [safeStagingId], run)).toThrow();
  expect(() => adapter.policy.allocation?.({ kind: "indexeddb", name }, [], run)).toThrow();
  expect(() =>
    adapter.policy.allocation?.({ kind: "indexeddb", name }, ["foreign"], run),
  ).toThrow();
});
test("inactive and unknown allocations never reach the reporter", async () => {
  let calls = 0;
  const allocate = async () => {
    calls++;
  };
  await expect(
    stagingDatabaseName(run, allocate, () => false)("waffle-staged-test"),
  ).rejects.toThrow("no longer current");
  await expect(stagingDatabaseName(run, allocate, () => true)("foreign")).rejects.toThrow(
    "Unknown staging",
  );
  expect(calls).toBe(0);
});
for (const actual of [labels, labels.slice(1)]) {
  test(`whole-command host retains actual labels and exits ${actual.length === labels.length ? 0 : 1}`, async () => {
    const root = await mkdtemp("/work/tmp/wss-unit-");
    const driver = new FakeDriver("pass", { list: { labels }, result: actual });
    try {
      const result = await runPageSuite(adapter, () => driver, {
        resultPath: join(root, "result.json"),
        scratchRoot: root,
        assets: {},
        budgets: { hello: 500, heartbeat: 500, case: 1000, group: 1500, run: 8000 },
      });
      expect(result.exit).toBe(actual.length === labels.length ? 0 : 1);
      expect(result.results[safeStagingId]).toEqual(actual);
      expect(result.required).toEqual([safeStagingId]);
      expect(result.omitted).toEqual([]);
      expect(result.runComplete).toBe(true);
      expect(result.documents.every((doc) => doc.cutoff !== null)).toBe(true);
      expect(result.cleanup.storage.status).toBe("confirmed");
      expect(driver.stopCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("native staging preconditions write their own result without allocating a browser", async () => {
  const root = await mkdtemp("/work/tmp/wss-cli-");
  const original = process.env.IOS_UDID;
  try {
    process.env.IOS_UDID = "invalid-control-udid";
    const path = join(root, "native.json");
    expect(await nativeMain(adapter, ["--result", path])).toBe(3);
    expect(await Bun.file(path).json()).toEqual({
      suite: "safe-staging",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
  } finally {
    if (original === undefined) delete process.env.IOS_UDID;
    else process.env.IOS_UDID = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("a requested single staging control stays an explicitly partial run", async () => {
  const root = await mkdtemp("/work/tmp/wss-filter-");
  const selected = labels[0];
  expect(selected).toBeDefined();
  const partial = safeStagingAdapter(selected);
  const driver = new FakeDriver("pass", { list: { labels }, result: [selected] });
  try {
    const result = await runPageSuite(partial, () => driver, {
      resultPath: join(root, "result.json"),
      scratchRoot: root,
      assets: {},
      filter: "safeStagingNative",
      budgets: { hello: 500, heartbeat: 500, case: 1000, group: 1500, run: 8000 },
    });
    expect(result.exit).toBe(4);
    expect(result.results[safeStagingId]).toEqual([selected]);
    expect(result.runComplete).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
