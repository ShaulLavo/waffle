import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeDriver } from "./fake-driver.js";
import { runPageSuite, type SuiteAdapter, type SuiteCase } from "./suite-host.js";

async function queryFixture(query: unknown, inspect?: (url: URL) => Promise<void>) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wq-"));
  const urls: URL[] = [];
  const item: SuiteCase<null> = { id: "query", label: "query", request: () => null };
  if (query !== undefined) Reflect.set(item, "query", query);
  const adapter: SuiteAdapter<null> = {
    suite: "query-control",
    inventory: () => [item],
    policy: { listIds: () => ["query"], check() {} },
    assets: async () => ({}),
    budgets: () => ({ hello: 1000, heartbeat: 1000, case: 1000, group: 2000, run: 5000 }),
  };
  const driver = new FakeDriver("pass", { list: { ids: ["query"] } });
  const navigate = driver.navigate.bind(driver);
  driver.navigate = async (value) => {
    const url = new URL(value);
    urls.push(url);
    if (urls.length === 2) await inspect?.(url);
    await navigate(value);
  };
  try {
    const result = await runPageSuite(adapter, () => driver, {
      scratchRoot: root,
      resultPath: join(root, "result.json"),
      port: "ephemeral",
      cleanupTimeoutMs: 1000,
    });
    return { result, urls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("default case URLs and list/finish stay token-only", async () => {
  const { result, urls } = await queryFixture(undefined);
  expect(result.exit).toBe(0);
  expect(urls).toHaveLength(3);
  for (const url of urls) expect(Array.from(url.searchParams.keys())).toEqual(["token"]);
});

test("case query runs once, copies getters once, encodes values and binds the exact URL", async () => {
  let calls = 0, reads = 0, run = "";
  const values = {
    test: "1", renderer: "canvas", workspace: "",
    get encoded() { reads++; return "space + & ? # / = 雪"; },
  };
  const { result, urls } = await queryFixture(
    (identity: string) => {
      calls++;
      run = identity;
      values.workspace = `startup-S03-${identity}`;
      return values;
    },
    async (url) => {
      values.test = "changed";
      values.workspace = "wrong";
      expect((await fetch(url)).status).toBe(200);
      const changed = new URL(url);
      changed.searchParams.set("renderer", "other");
      expect((await fetch(changed)).status).toBe(404);
      expect(url.searchParams.get("test")).toBe("1");
      expect(url.searchParams.get("renderer")).toBe("canvas");
      expect(url.searchParams.get("workspace")).toBe(`startup-S03-${run}`);
      expect(url.searchParams.get("encoded")).toBe("space + & ? # / = 雪");
      expect(url.hash).toBe("");
      expect(url.pathname).toBe("/");
    },
  );
  expect(result.exit).toBe(0);
  expect(calls).toBe(1);
  expect(reads).toBe(1);
  expect(urls[0]?.searchParams.size).toBe(1);
  expect(urls[2]?.searchParams.size).toBe(1);
});

const malformed = [null, [], "test=1", new URLSearchParams("test=1"), { test: 1 }, { test: undefined }, { token: "wrong" }, { path: "/other" }, { url: "https://elsewhere/" }, { "bad&token": "value" }, { [Symbol("query")]: "value" }];
for (const value of malformed) {
  test(`malformed or reserved query fails before case binding: ${String(value)}`, async () => {
    const { result, urls } = await queryFixture(() => value);
    expect(result.exit).toBe(2);
    expect(result.documents.some((document) => document.group === "query")).toBe(false);
    expect(urls).toHaveLength(1);
    expect(JSON.stringify(result.failures)).toContain("query");
    expect(result.cleanup.scratch.status).toBe("confirmed");
  });
}
const failedQueries = [
  () => { throw new Error("QUERY_CALLBACK_FAILURE"); },
  () => ({ get test() { throw new Error("QUERY_GETTER_FAILURE"); } }),
];
for (const query of failedQueries) {
  test("query callback/getter errors remain failures without a case document", async () => {
    const { result, urls } = await queryFixture(query);
    expect(result.exit).toBe(2);
    expect(result.documents).toHaveLength(1);
    expect(urls).toHaveLength(1);
    expect(JSON.stringify(result.failures)).toContain("QUERY_");
    expect(result.cleanup.session.status).toBe("confirmed");
  });
}
