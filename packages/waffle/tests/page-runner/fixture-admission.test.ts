import { expect, test } from "bun:test";
import { Collector, ObservationClosed, type CollectorPolicy } from "./collector.js";
import { BrowserObservation } from "./browser-observation.js";
import { HostConsumers } from "./owned-consumers.js";
import type { Body, Budgets } from "./protocol.js";

const budgets: Budgets = { hello: 1000, heartbeat: 1000, case: 100, group: 200, run: 300 };
function control(options: { budgets?: Budgets; host?: boolean; policy?: CollectorPolicy } = {}) {
  let now = 10;
  const c = new Collector(
    "r",
    ["c"],
    ["c"],
    options.policy ?? { listIds: () => ["c"], check() {} },
    () => now,
  );
  const state = c.expect(
    {
      id: "c",
      role: "case",
      caseIds: ["c"],
      ...(options.host ? { execution: "host" as const } : {}),
    },
    "t",
    "http://localhost/?token=t",
    "h",
  );
  const send = (body: Body) =>
    c.receive({ run: "r", doc: "d", seq: state.messages.length, ...body });
  send({ kind: "hello", token: "t", group: "c" });
  now = 20;
  if (options.host) {
    send({ kind: "case-ready", caseId: "c" });
    c.beginHost(state, "c");
  } else send({ kind: "case-start", caseId: "c" });
  const limits = { budgets: options.budgets ?? budgets, runStartedAt: 0 };
  const admit = () => c.admitFixture("t", "d", "c", limits);
  return {
    c,
    state,
    send,
    admit,
    limits,
    time: (value: number) => {
      now = value;
    },
  };
}
function pass(f: ReturnType<typeof control>) {
  f.send({ kind: "case-end", caseId: "c", status: "pass", result: true });
}
for (const phase of ["running", "pass", "complete", "retiring", "ready"] as const) {
  test(`admitted completion survives ${phase}, new requests do not survive pass`, () => {
    const f = control();
    const admission = f.admit();
    expect(Object.isFrozen(admission)).toBe(true);
    expect(admission.deadline).toBe(120);
    if (phase !== "running") pass(f);
    if (phase === "complete" || phase === "retiring" || phase === "ready")
      f.send({ kind: "doc-complete" });
    if (phase === "retiring" || phase === "ready") f.state.retiring = true;
    if (phase === "ready") f.send({ kind: "retire-ready" });
    if (phase !== "running") expect(f.admit).toThrow(ObservationClosed);
    f.c.completeFixture(admission);
    expect(() => f.c.completeFixture(admission)).toThrow(ObservationClosed);
  });
}
test("fixture authority is collector-local identity, independently single-use", () => {
  const f = control(),
    other = control();
  const a = f.admit(),
    b = f.admit();
  expect(() => other.c.completeFixture(a)).toThrow(ObservationClosed);
  expect(() => f.c.completeFixture({ ...a })).toThrow(ObservationClosed);
  f.c.completeFixture(a);
  f.c.completeFixture(b);
});
for (const edge of [
  "retire",
  "abandon",
  "fail",
  "cancel",
  "page-fail",
  "assertion",
  "console",
  "replace",
  "physical",
  "doc",
] as const) {
  test(`fixture completion refuses ${edge} and consumes even rejected authority`, () => {
    const f = control({
      policy: {
        listIds: () => ["c"],
        check() {
          if (edge === "assertion") throw new Error("host assertion");
        },
      },
    });
    const a = f.admit();
    if (edge === "retire") {
      pass(f);
      f.send({ kind: "doc-complete" });
      f.state.retiring = true;
      f.send({ kind: "retire-ready" });
      f.c.retire(f.state, f.state.messages.length - 1);
    }
    if (edge === "abandon") f.c.abandon("lost");
    if (edge === "fail") f.c.fail("test", "failure");
    if (edge === "cancel") f.c.cancel();
    if (edge === "page-fail")
      f.send({ kind: "case-end", caseId: "c", status: "fail", error: "page" });
    if (edge === "assertion") pass(f);
    if (edge === "console") {
      const observation = new BrowserObservation("exact", new HostConsumers(), async () => {});
      f.c.bindObservation(f.state, observation, new HostConsumers(), () => 1000, true);
      observation.consoleMessage("page", { source: "cpu", text: "error" });
      pass(f);
    }
    if (edge === "replace")
      f.c.expect(
        { id: "next", role: "finish", caseIds: [] },
        "next",
        "http://localhost/?token=next",
        "h",
      );
    if (edge === "physical") f.state.physical = "closed";
    if (edge === "doc") f.state.doc = "replacement";
    expect(() => f.c.completeFixture(a)).toThrow(ObservationClosed);
    expect(() => f.c.completeFixture(a)).toThrow("already consumed");
    if (edge === "retire" || edge === "abandon") expect(f.admit).toThrow(ObservationClosed);
  });
}
for (const [key, value, deadline, reason] of [
  ["case", 50, 70, "case-hang"],
  ["group", 40, 50, "group-timeout"],
  ["run", 30, 30, "run-timeout"],
] as const) {
  test(`${key} completion deadline uses the original clock and exact boundary`, () => {
    const f = control({ budgets: { ...budgets, [key]: value } });
    const a = f.admit(),
      b = f.admit();
    expect(a.deadline).toBe(deadline);
    f.time(deadline - 1);
    expect(f.c.deadline(f.limits.budgets, 0)).toBeNull();
    f.c.completeFixture(a);
    f.time(deadline);
    expect(f.c.deadline(f.limits.budgets, 0)).toBe(reason);
    expect(f.admit).toThrow(ObservationClosed);
    expect(() => f.c.completeFixture(b)).toThrow(ObservationClosed);
  });
  test(`${key} captured deadline still applies after provisional pass`, () => {
    const f = control({ budgets: { ...budgets, [key]: value } });
    const a = f.admit();
    pass(f);
    f.time(deadline);
    expect(() => f.c.completeFixture(a)).toThrow(ObservationClosed);
  });
}
test("host fixture deadline uses caseDocument and ignores ordinary case limit", () => {
  const f = control({ host: true, budgets: { ...budgets, case: 1, caseDocument: 70 } });
  const a = f.admit();
  expect(a.deadline).toBe(80);
  f.time(79);
  f.c.completeFixture(a);
  f.time(80);
  expect(f.admit).toThrow(ObservationClosed);
});
