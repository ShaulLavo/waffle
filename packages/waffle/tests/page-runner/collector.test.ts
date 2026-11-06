import { storagePolicy, listIds } from "./storage-policy.js";
import { expect, test } from "bun:test";
import { Collector } from "./collector.js";
import {
  exactInventory,
  parseMessage,
  storageBudgets,
  validateWorkerLabel,
  type Body,
} from "./protocol.js";
import { storageInventory } from "./storage-host.js";
const first = "indexeddb: first",
  second = "opfs: second";
function fixture() {
  let now = 0;
  const collector = new Collector(
    "run",
    [first, second],
    [first, second],
    storagePolicy,
    () => now,
  );
  const state = collector.expect(
    { id: "case", role: "case", caseIds: [first] },
    "token",
    "http://runner/",
    "root",
  );
  let seq = 0;
  const send = (body: Body) =>
    collector.receive({ run: "run", doc: "document", seq: seq++, ...body });
  send({ kind: "hello", token: "token", group: "case" });
  return {
    collector,
    state,
    send,
    clock: (value: number) => {
      now = value;
    },
  };
}
function passed() {
  const f = fixture();
  f.send({ kind: "case-start", caseId: first });
  f.send({ kind: "case-end", caseId: first, status: "pass" });
  return f;
}
test("inventory comes from both factories and preserves all required cases under filtering", () => {
  const inventory = storageInventory();
  expect(inventory.filter((item) => item.backend === "indexeddb")).toHaveLength(34);
  expect(inventory.filter((item) => item.backend === "opfs")).toHaveLength(27);
  expect(() =>
    exactInventory(
      inventory.map((item) => item.id),
      inventory.slice(1).map((item) => item.id),
    ),
  ).toThrow();
  expect(() => exactInventory([first, second], [first, first])).toThrow();
});
test("list arrays and fulfilled Worker answer are checked rather than relabelled", () => {
  for (const value of [null, {}, { indexeddb: [], opfs: [3] }, { indexeddb: ["x", "x"], opfs: [] }])
    expect(() => listIds(value)).toThrow();
  expect(() => validateWorkerLabel("wrong", "expected")).toThrow("Wrong Worker label");
  expect(() => validateWorkerLabel(undefined, "expected")).toThrow();
});
for (const seq of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`reject invalid sequence ${seq}`, () =>
    expect(() => parseMessage({ run: "r", doc: "d", kind: "doc-complete", seq })).toThrow());
}
for (const kind of ["control", "expect", "transition", "new-window", "actions"]) {
  test(`storage v1 rejects unused ${kind}`, () => {
    const f = fixture();
    expect(() => f.collector.receive({ run: "run", doc: "document", seq: 1, kind })).toThrow();
    expect(f.collector.failures.length).toBeGreaterThan(0);
  });
}
for (const body of [
  { kind: "case-start", caseId: "unknown" },
  { kind: "case-start", caseId: second },
  { kind: "case-end", caseId: first, status: "pass" },
  { kind: "doc-complete" },
  { kind: "run-complete", remaining: [] },
] satisfies Body[]) {
  test(`illegal case transition ${JSON.stringify(body)} stays failed`, () => {
    const f = fixture();
    expect(() => f.send(body)).toThrow();
    expect(f.collector.failures.length).toBeGreaterThan(0);
  });
}
test("identical transport retry is acknowledged, new-sequence terminal is not a retry", () => {
  const f = passed();
  expect(
    f.collector.receive({
      run: "run",
      doc: "document",
      seq: 2,
      kind: "case-end",
      caseId: first,
      status: "pass",
    }),
  ).toEqual({ ackedThrough: 2 });
  expect(() => f.send({ kind: "case-end", caseId: first, status: "pass" })).toThrow();
  expect(f.collector.outcomes[first]).toEqual({ status: "pass", provisional: true });
  expect(f.collector.failures.length).toBeGreaterThan(0);
});
test("conflicting retry, duplicate hello, duplicate start and sequence gap fail", () => {
  const conflict = fixture();
  expect(() =>
    conflict.collector.receive({
      run: "run",
      doc: "document",
      seq: 0,
      kind: "hello",
      token: "wrong",
      group: "case",
    }),
  ).toThrow();
  const duplicate = fixture();
  duplicate.send({ kind: "case-start", caseId: first });
  expect(() => duplicate.send({ kind: "case-start", caseId: first })).toThrow();
  const gap = fixture();
  expect(() =>
    gap.collector.receive({ run: "run", doc: "document", seq: 10, kind: "doc-complete" }),
  ).toThrow();
  const hello = fixture();
  expect(() => hello.send({ kind: "hello", token: "token", group: "case" })).toThrow();
});
test("pass then window error cannot become a clean pass", () => {
  const f = passed();
  f.send({ kind: "error", message: "late rejection" });
  f.send({ kind: "doc-complete" });
  expect(f.collector.failures).toContainEqual({
    group: "case",
    category: "page-error",
    detail: "late rejection",
  });
});
test("list and finish page errors have run/group failures without a running case", () => {
  const collector = new Collector("run", [], [], storagePolicy);
  for (const role of ["list", "finish"] as const) {
    collector.expect({ id: role, role, caseIds: [] }, role, "http://runner/", "root");
    collector.receive({ run: "run", doc: role, seq: 0, kind: "hello", token: role, group: role });
    collector.receive({ run: "run", doc: role, seq: 1, kind: "error", message: `${role} failed` });
  }
  expect(collector.failures.map((failure) => failure.group)).toEqual(["list", "finish"]);
});
test("case pass remains provisional through doc-complete until acknowledged retirement", () => {
  const f = passed();
  f.send({ kind: "doc-complete" });
  expect(() => f.collector.retire(f.state, 3)).toThrow();
  f.state.retiring = true;
  f.send({ kind: "retire-ready" });
  f.collector.retire(f.state, 4);
  expect(f.collector.outcomes[first]).toEqual({ status: "pass", provisional: false });
});
test("an old report cannot enter the next group and old heartbeats cannot extend it", () => {
  const f = passed();
  f.send({ kind: "doc-complete" });
  f.state.retiring = true;
  f.send({ kind: "retire-ready" });
  f.collector.retire(f.state, 4);
  const next = f.collector.expect(
    { id: "next", role: "case", caseIds: [second] },
    "next",
    "http://next/",
    "root",
  );
  f.clock(5000);
  f.collector.heartbeat({ run: "run", doc: "document", kind: "heartbeat" });
  expect(next.heartbeatAt).toBe(0);
  expect(() => f.send({ kind: "error", message: "after cutoff" })).toThrow("cutoff");
  expect(f.collector.failures).toHaveLength(0);
  expect(f.collector.outcomes[second]).toEqual({ status: "pending" });
});
test("unexpected old document report before cutoff is sticky and attributed to old group", () => {
  const f = passed();
  f.collector.expect(
    { id: "next", role: "case", caseIds: [second] },
    "next",
    "http://next/",
    "root",
  );
  expect(() => f.send({ kind: "error", message: "not retired" })).toThrow();
  expect(f.collector.failures[0]?.group).toBe("case");
});
test("fake monotonic clock separates live-heartbeat case deadline and reporting loss", () => {
  const f = fixture(),
    budgets = { ...storageBudgets, run: 300_000 };
  f.send({ kind: "case-start", caseId: first });
  f.clock(59_000);
  f.collector.heartbeat({ run: "run", doc: "document", kind: "heartbeat" });
  expect(f.collector.deadline(budgets, 0)).toBeNull();
  f.clock(60_000);
  expect(f.collector.deadline(budgets, 0)).toBe("case-hang");
  const terminal = passed();
  terminal.clock(10_000);
  expect(terminal.collector.deadline(budgets, 0)).toBe("heartbeat-lost");
  terminal.clock(90_000);
  terminal.collector.heartbeat({ run: "run", doc: "document", kind: "heartbeat" });
  expect(terminal.collector.deadline(budgets, 0)).toBe("group-timeout");
  terminal.clock(300_000);
  expect(terminal.collector.deadline(budgets, 0)).toBe("run-timeout");
});
test("exact run allocation ledger includes derived names and rejects foreign allocations", () => {
  const f = fixture();
  f.send({ kind: "case-start", caseId: first });
  for (const suffix of ["x", "x-1", "x-128"])
    f.send({
      kind: "allocation",
      entry: { kind: "indexeddb", name: `bun-wasm-storage-test-run-${suffix}` },
    });
  expect(f.collector.ledger).toHaveLength(3);
  expect(() =>
    f.send({
      kind: "allocation",
      entry: { kind: "indexeddb", name: "bun-wasm-storage-test-foreign" },
    }),
  ).toThrow();
});

function opfsAllocation(name: string) {
  const collector = new Collector("run", [second], [second], storagePolicy);
  collector.expect(
    { id: "opfs", role: "case", caseIds: [second] },
    "token",
    "http://runner/",
    "root",
  );
  collector.receive({
    run: "run",
    doc: "opfs-doc",
    seq: 0,
    kind: "hello",
    token: "token",
    group: "opfs",
  });
  collector.receive({ run: "run", doc: "opfs-doc", seq: 1, kind: "case-start", caseId: second });
  return {
    collector,
    report: {
      run: "run",
      doc: "opfs-doc",
      seq: 2,
      kind: "allocation",
      entry: { kind: "opfs-directory", name },
    },
  };
}
for (const variant of ["foreign-prefix", "padding", "noncanonical-json"]) {
  test(`OPFS ledger rejects ${variant} before accepting cleanup authority`, () => {
    const logical = "bun-wasm-opfs-test-run-own";
    const canonical = btoa(JSON.stringify(logical))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const name =
      variant === "foreign-prefix"
        ? `foreign!!${canonical}`
        : variant === "padding"
          ? `bun-wasm-${canonical}=`
          : `bun-wasm-${btoa(` ${JSON.stringify(logical)}`).replaceAll("=", "")}`;
    const { collector, report } = opfsAllocation(name);
    expect(() => collector.receive(report)).toThrow();
    expect(collector.ledger).toHaveLength(0);
  });
}
test("malformed retired-document reports respect cutoff rather than failing the next group", () => {
  const f = passed();
  f.send({ kind: "doc-complete" });
  f.state.retiring = true;
  f.send({ kind: "retire-ready" });
  f.collector.retire(f.state, 4);
  f.collector.expect(
    { id: "next", role: "case", caseIds: [second] },
    "next",
    "http://next/",
    "root",
  );
  expect(() =>
    f.collector.receive({ run: "run", doc: "document", seq: 5, kind: "unknown" }),
  ).toThrow("cutoff");
  expect(f.collector.failures).toHaveLength(0);
});
test("malformed reports from an observed older document keep their original group", () => {
  const f = passed();
  f.collector.expect(
    { id: "next", role: "case", caseIds: [second] },
    "next",
    "http://next/",
    "root",
  );
  expect(() =>
    f.collector.receive({ run: "run", doc: "document", seq: 5, kind: "unknown" }),
  ).toThrow();
  expect(f.collector.failures.map((failure) => failure.group)).toEqual(["case"]);
});
