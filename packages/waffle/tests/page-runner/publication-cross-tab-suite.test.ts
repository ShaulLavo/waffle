import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCrossTabValue, decodeCrossTabValue } from "./cross-tab-value.js";
import { crossTabEvaluator } from "./cross-tab-evaluator.js";
import { crossTabAdapter } from "./publication-cross-tab-suite.js";
import {
  checkCrossTabLabels,
  crossTabLabels,
  crossTabId,
} from "../publication-cross-tab-inventory.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function oracleSignature(source: string): string {
  let body = source.slice(source.indexOf("function equal("));
  const end = body.indexOf("\ntry {\n  await lifecycle.init();");
  body =
    end < 0
      ? body.slice(0, body.lastIndexOf("  return { run, runWorkspaceCleanup };"))
      : body.slice(0, end);
  const observers = body.indexOf("async function observeDeaths(");
  if (observers >= 0)
    body =
      body.slice(0, observers) +
      body.slice(body.indexOf("async function observeWorkspaceChannels"));
  body = body
    .replaceAll("console.log(", "log(")
    .replaceAll("await observeDeaths(page);", "await page.observeDeaths();")
    .replaceAll("await navigateTestPage(page, origin);", "await page.navigate(origin);")
    .replaceAll("await navigateTestPage(recovery, origin);", "await recovery.navigate(origin);")
    .replace(/^\s*page\.on\("(?:pageerror|console)"[^\n]+\n/gm, "\n")
    .replace(
      /\s*if \(name !== "chromium" && name !== "firefox" && name !== "webkit"\)\s*throw new Error\(`unknown (?:browser|engine) \$\{name\}`\);/g,
      "",
    );
  return hash(new Bun.Transpiler({ loader: "ts", minifyWhitespace: true }).transformSync(body));
}

test("all original cross-tab host assertions and schedules are shared without body changes", async () => {
  const source = await readFile(
    join(import.meta.dir, "../publication-cross-tab-command.ts"),
    "utf8",
  );
  expect(oracleSignature(source)).toBe(
    "fcd3afaffdc904b1637955d5cde0997f8bda16d13548bc054702b4bc3460c73f",
  );
});

test("the complete cross-tab inventory and original command clock reject missing and changed results", () => {
  expect(crossTabLabels).toHaveLength(26);
  expect(crossTabAdapter.inventory().map((item) => item.id)).toEqual([crossTabId]);
  expect(crossTabAdapter.budgets(1)).toEqual({
    hello: 20000,
    heartbeat: 10000,
    case: 180000,
    group: 180000,
    run: 180000,
  });
  checkCrossTabLabels(crossTabLabels);
  for (const value of [
    null,
    crossTabLabels.slice(1),
    crossTabLabels.toReversed(),
    crossTabLabels.concat(["invented"]),
    crossTabLabels.map(() => crossTabLabels[0]),
  ])
    expect(() => checkCrossTabLabels(value)).toThrow("original cross-tab");
  const policy = crossTabAdapter.policy;
  expect(() => policy.listIds({ ids: [crossTabId, "invented"] })).toThrow();
  const result = {
    body: { status: "pass", result: { labels: crossTabLabels } },
    teardown: { status: "pass", result: { settled: true } },
  };
  policy.check(crossTabId, result);
  expect(() =>
    policy.check(crossTabId, {
      ...result,
      teardown: { status: "pass", result: { settled: false } },
    }),
  ).toThrow("settled teardown");
  expect(() =>
    policy.check(crossTabId, {
      ...result,
      body: { status: "pass", result: { labels: crossTabLabels.slice(1) } },
    }),
  ).toThrow("original cross-tab");
});

test("the evaluator preserves concurrent asynchronous operations and joins them before close", async () => {
  const evaluator = crossTabEvaluator();
  const released = Promise.withResolvers<void>();
  Reflect.set(globalThis, "__crossTabTestRelease", released.resolve);
  Reflect.set(globalThis, "__crossTabTestPending", released.promise);
  evaluator.submit({
    id: "held",
    source: "return globalThis.__crossTabTestPending.then(() => 7);",
    value: encodeCrossTabValue(undefined),
  });
  const running = evaluator.run();
  try {
    evaluator.submit({ id: "probe", source: "return 9;", value: encodeCrossTabValue(undefined) });
    await Bun.sleep(0);
    expect(evaluator.take("held")).toBeNull();
    expect(evaluator.take("probe")).toEqual({ status: "pass", value: encodeCrossTabValue(9) });
    evaluator.stop();
    expect(evaluator.state().pending).toBe(1);
    expect(() =>
      evaluator.submit({ id: "late", source: "return 0;", value: encodeCrossTabValue(undefined) }),
    ).toThrow("stopped");
    released.resolve();
    await running;
    expect(evaluator.take("held")).toEqual({ status: "pass", value: encodeCrossTabValue(7) });
    expect(evaluator.state()).toEqual({ accepting: false, queued: 0, pending: 0, unread: 0 });
  } finally {
    released.resolve();
    evaluator.stop();
    await running;
    Reflect.deleteProperty(globalThis, "__crossTabTestRelease");
    Reflect.deleteProperty(globalThis, "__crossTabTestPending");
  }
});

test("evaluation failures remain failures and each outcome is consumed once", async () => {
  const evaluator = crossTabEvaluator();
  evaluator.submit({
    id: "failed",
    source: "throw new Error('ORIGINAL_ASSERTION');",
    value: encodeCrossTabValue(undefined),
  });
  evaluator.stop();
  await evaluator.run();
  expect(evaluator.take("failed")).toEqual({ status: "fail", error: "Error: ORIGINAL_ASSERTION" });
  expect(evaluator.take("failed")).toBeNull();
  await expect(evaluator.run()).rejects.toThrow("already running");
});

test("plain-data evaluation preserves bigint, undefined, nested arrays and tag-looking objects", () => {
  const data = {
    inode: 9007199254740993n,
    bytes: new Uint8Array([0, 127, 255]),
    absent: undefined,
    nested: [null, NaN, Infinity, -0, { kind: "bigint", value: "literal" }],
  };
  expect(decodeCrossTabValue(JSON.parse(JSON.stringify(encodeCrossTabValue(data))))).toEqual(data);
  expect(() => encodeCrossTabValue(new SharedArrayBuffer(8))).toThrow("Unsupported");
  expect(() => decodeCrossTabValue({ kind: "invented", value: 0 })).toThrow("Invalid");
});

const originalFixtures = {
  "publication-cross-tab-browser.ts":
    "31df8f8bc13a4c53cf098b9a8467f007ac615db21813a225ffdb9c6ff97e063c",
  "fixtures/publication-resident-authority.ts":
    "4d318d95fdff3c70f8058b49689e89d2821ca89a8a076a31877e4679a7671ce7",
  "fixtures/publication-resident-guest.ts":
    "9b9652caae3250579d44fe87c2d635722d4c1ea71309f0ee5758ce8663e3ae3c",
  "fixtures/publication-channel-observer.ts":
    "d30e355a0c6b733dda387a24bd42e522a09d0802df1615dcffea78726246e911",
  "fixtures/publication-wasm.ts":
    "cb34c61cbd68ba7df510e4d8ddbae1b9e60cd68e49503dd792125a841c224a76",
  "persistent-native-inspection.ts":
    "e9871b752cf88c647765f925ce926b57f61208db63aaa052b434a6d9ee73516d",
};
test("original cross-tab fixtures and compiled CLAIMED observer are frozen", async () => {
  for (const [name, expected] of Object.entries(originalFixtures))
    expect(hash(await readFile(join(import.meta.dir, "..", name), "utf8"))).toBe(expected);
  const assets = await readFile(
    join(import.meta.dir, "../publication-cross-tab-assets.ts"),
    "utf8",
  );
  const guest = assets
    .slice(
      assets.indexOf("async function crossTabGuestBundle"),
      assets.indexOf("export async function crossTabAssets"),
    )
    .replace("crossTabGuestBundle", "guestBundle");
  const normalized = new Bun.Transpiler({ loader: "ts", minifyWhitespace: true }).transformSync(
    guest,
  );
  expect(hash(normalized)).toBe("863e3a5b0219f52a5074e10f3ddd2a08fb195e0f521a305139c9e78c3a016233");
});
