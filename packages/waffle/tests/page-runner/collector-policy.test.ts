import { expect, test } from "bun:test";
import { Collector, type CollectorPolicy, type Group } from "./collector.js";
import { commandAdapter, commands } from "./command-suites.js";
import { storageAdapter } from "./storage-host.js";
import { storagePolicy } from "./storage-policy.js";
import { resultByteLimit, type Body } from "./protocol.js";

function fixture(policy = commandAdapter("guest-watch").policy, role: Group["role"] = "case") {
  let now = 0,
    seq = 0;
  const id = "command",
    other = "other";
  const collector = new Collector("run", [id, other], [id, other], policy, () => now);
  const state = collector.expect(
    { id: "original", role, caseIds: role === "case" ? [id] : [] },
    "token",
    "http://test/",
    "root",
  );
  const message = (body: Body) => ({ run: "run", doc: "doc", seq: seq++, ...body });
  const send = (body: Body) => collector.receive(message(body));
  send({ kind: "hello", token: "token", group: "original" });
  return {
    collector,
    state,
    id,
    other,
    send,
    message,
    clock: (value: number) => {
      now = value;
    },
  };
}
test("assertion failure stores its actual value and terminal retry never repeats policy", () => {
  let checks = 0;
  const f = fixture({
    ...commandAdapter("guest-watch").policy,
    check() {
      checks++;
      throw new Error("ACTUAL_ASSERTION");
    },
  });
  f.send({ kind: "case-start", caseId: f.id });
  const actual = { early: 0, late: 0 };
  const terminal = f.message({ kind: "case-end", caseId: f.id, status: "pass", result: actual });
  expect(f.collector.receive(terminal)).toEqual({ ackedThrough: 2 });
  expect(f.collector.receive(terminal)).toEqual({ ackedThrough: 2 });
  expect(checks).toBe(1);
  expect(f.collector.results[f.id]).toEqual(actual);
  expect(f.collector.outcomes[f.id]).toEqual({
    status: "fail",
    detail: "Host assertion: Error: ACTUAL_ASSERTION",
  });
  expect(f.collector.failures).toEqual([]);
  f.send({ kind: "doc-complete" });
});
for (const id of ["unknown", "other"]) {
  test(`illegal terminal routing rejects ${id} before assertion or result insertion`, () => {
    let checks = 0;
    const f = fixture({
      ...commandAdapter("guest-watch").policy,
      check() {
        checks++;
      },
    });
    f.send({ kind: "case-start", caseId: f.id });
    expect(() => f.send({ kind: "case-end", caseId: id, status: "pass", result: {} })).toThrow();
    expect(checks).toBe(0);
    expect(f.collector.results).toEqual({});
  });
}
test("list policies run only after role and sequence validation and retain document attribution", () => {
  let lists = 0;
  const policy: CollectorPolicy = {
    ...storagePolicy,
    listIds() {
      lists++;
      throw new Error("LIST_POLICY");
    },
  };
  const wrongRole = fixture(policy);
  expect(() => wrongRole.send({ kind: "list", cases: null })).toThrow("Unexpected list");
  expect(lists).toBe(0);
  const f = fixture(policy, "list");
  expect(() => f.send({ kind: "list", cases: null })).toThrow("LIST_POLICY");
  expect(lists).toBe(1);
  expect(f.collector.failures[0]?.group).toBe("original");
});
test("old-document result policy cannot reach the new group before or after cutoff", () => {
  let checks = 0;
  const f = fixture({
    ...commandAdapter("guest-watch").policy,
    check() {
      checks++;
      throw new Error("HOST_CHECK");
    },
  });
  f.send({ kind: "case-start", caseId: f.id });
  f.collector.expect(
    { id: "next", role: "case", caseIds: [f.other] },
    "next",
    "http://next/",
    "root",
  );
  const terminal = f.message({
    kind: "case-end",
    caseId: f.id,
    status: "pass",
    result: { actual: true },
  });
  expect(() => f.collector.receive(terminal)).toThrow("sequence conflict");
  expect(f.collector.failures[0]?.group).toBe("original");
  expect(checks).toBe(0);
  expect(f.collector.results).toEqual({});
  f.state.cutoff = 1;
  expect(() => f.collector.receive(terminal)).toThrow("cutoff");
  expect(f.collector.failures).toHaveLength(1);
  expect(f.collector.outcomes[f.other]).toEqual({ status: "pending" });
});
for (const role of ["list", "case", "finish"] as const) {
  test(`command allocation during ${role} is rejected before ledger mutation or ACK`, () => {
    const f = fixture(undefined, role);
    if (role === "case") f.send({ kind: "case-start", caseId: f.id });
    expect(() =>
      f.send({
        kind: "allocation",
        entry: { kind: "indexeddb", name: "bun-wasm-storage-test-run-x" },
      }),
    ).toThrow("no durable allocations");
    expect(f.collector.ledger).toEqual([]);
    expect(f.state.messages).toHaveLength(role === "case" ? 2 : 1);
  });
}
function opfs(logical: string) {
  return `bun-wasm-${btoa(JSON.stringify(logical)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}
test("concurrent running backends validate by backend and deduplicate exact allocations", () => {
  const ids = ["indexeddb: control", "opfs: control"];
  const collector = new Collector("run", ids, ids, storagePolicy);
  const state = collector.expect(
    { id: "both", role: "case", caseIds: ids },
    "token",
    "http://test/",
    "root",
  );
  let seq = 0;
  const send = (body: Body) => collector.receive({ run: "run", doc: "doc", seq: seq++, ...body });
  send({ kind: "hello", token: "token", group: "both" });
  for (const id of ids) send({ kind: "case-start", caseId: id });
  const database = { kind: "indexeddb", name: "bun-wasm-storage-test-run-x-128" } as const;
  const directory = { kind: "opfs-directory", name: opfs("bun-wasm-opfs-test-run-y") } as const;
  send({ kind: "allocation", entry: database });
  send({ kind: "allocation", entry: directory });
  send({ kind: "allocation", entry: database });
  expect(collector.ledger).toEqual([database, directory]);
  expect(state.messages).toHaveLength(6);
});
for (const entry of [
  { kind: "indexeddb", name: "bun-wasm-storage-test-other-x" },
  { kind: "indexeddb", name: "bun-wasm-opfs-test-run-x" },
  { kind: "opfs-directory", name: opfs("bun-wasm-opfs-test-other-x") },
  { kind: "opfs-directory", name: opfs("bun-wasm-storage-test-run-x") },
  { kind: "opfs-directory", name: `${opfs("bun-wasm-opfs-test-run-x")}=` },
] as const) {
  test(`wrong run/backend/canonical allocation leaves ledger empty ${JSON.stringify(entry)}`, () => {
    const f = fixture(storagePolicy);
    f.state.group.caseIds = ["indexeddb: control", "opfs: control"];
    f.collector.outcomes["indexeddb: control"] = { status: "running", startedAt: 0 };
    f.collector.outcomes["opfs: control"] = { status: "running", startedAt: 0 };
    expect(() => f.send({ kind: "allocation", entry })).toThrow();
    expect(f.collector.ledger).toEqual([]);
  });
}
for (const command of commands) {
  test(`${command.suite} keeps its case clock despite heartbeats and states its new total budget`, () => {
    const adapter = commandAdapter(command.suite),
      budgets = adapter.budgets(1);
    const expected = {
      "search-executor": { case: 600_000, run: 990_000 },
      "fs-socket-attachment": { case: 60_000, run: 450_000 },
      "guest-watch": { case: 120_000, run: 510_000 },
    }[command.suite];
    expect(budgets.case).toBe(expected.case);
    expect(budgets.run).toBe(expected.run);
    expect(budgets.group).toBe(budgets.case + 30_000);
    const f = fixture(adapter.policy);
    f.send({ kind: "case-start", caseId: f.id });
    for (const now of [budgets.case - 1, budgets.case]) {
      f.clock(now);
      f.collector.heartbeat({ run: "run", doc: "doc", kind: "heartbeat", failure: null });
      expect(f.collector.deadline(budgets, 0)).toBe(now === budgets.case ? "case-hang" : null);
    }
  });
}
test("storage keeps the case/group and selected-count absolute budgets", () => {
  expect(storageAdapter.budgets(61)).toEqual({
    hello: 20_000,
    heartbeat: 10_000,
    case: 60_000,
    group: 90_000,
    run: 63 * 90_000 + 120_000,
  });
  expect(storageAdapter.budgets(1).run).toBe(390_000);
});
test("collector result bound counts UTF-8 rather than character count", () => {
  const f = fixture();
  f.send({ kind: "case-start", caseId: f.id });
  const actual = { early: 100, late: 100, text: "界".repeat(17_000) };
  expect(JSON.stringify(actual).length).toBeLessThan(resultByteLimit);
  expect(() => f.send({ kind: "case-end", caseId: f.id, status: "pass", result: actual })).toThrow(
    "oversized",
  );
  expect(f.collector.results).toEqual({});
});
