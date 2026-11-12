import { expect, test } from "bun:test";
import { Collector, ObservationClosed } from "./collector.js";
import { serveCollector } from "./suite-host.js";
import { parseMessage, sameStorageEntry, type Body } from "./protocol.js";
import type { ServiceWorkerEntry } from "../storage-allocation.js";
const entry: ServiceWorkerEntry = {
  kind: "service-worker",
  name: "http://localhost/_waffle_owned/r/",
  clientURL: "http://localhost/_waffle_owned/r/client.html?token=t",
  scriptURL: "http://localhost/sw.js?waffle-run=r",
};
function control(declared = true) {
  const c = new Collector("r", ["c"], ["c"], { listIds: () => ["c"], check() {} });
  if (declared) c.declareWorker("c", entry);
  const state = c.expect({ id: "c", role: "case", caseIds: ["c"] }, "t", entry.clientURL, "h");
  const send = (body: Body) =>
    c.receive({ run: "r", doc: "d", seq: state.messages.length, ...body });
  send({ kind: "hello", token: "t", group: "c" });
  send({ kind: "case-start", caseId: "c" });
  return { c, state, send };
}
test("declared worker admits without a database policy; exact duplicate delivery is ACK-only", () => {
  const { c, state, send } = control();
  const message = { run: "r", doc: "d", seq: state.messages.length, kind: "allocation", entry };
  c.receive(message);
  c.receive(message);
  expect(c.ledger).toEqual([entry]);
  send({ kind: "worker-settled", entry, outcome: "registered" });
  expect(c.registrationAttempts).toEqual([{ entry, state: "settled", outcome: "registered" }]);
  expect(() => send({ kind: "allocation", entry })).toThrow("already admitted");
});
for (const changed of [
  { ...entry, name: "http://localhost/foreign/" },
  { ...entry, scriptURL: "http://localhost/foreign.js" },
  { ...entry, clientURL: "http://localhost/foreign" },
]) {
  test(`changed worker identity is rejected before ACK: ${JSON.stringify(changed)}`, () => {
    const { c, state, send } = control();
    expect(() => send({ kind: "allocation", entry: changed })).toThrow();
    expect(c.ledger).toEqual([]);
    expect(state.messages.length).toBe(2);
    expect(sameStorageEntry(entry, changed)).toBe(false);
  });
}
test("undeclared worker cannot fall through to policy authorization", () => {
  const { c, send } = control(false);
  expect(() => send({ kind: "allocation", entry })).toThrow();
  expect(c.ledger).toEqual([]);
});
for (const settled of [true, false]) {
  test(`document loss preserves actual attempt disposition, settled=${settled}`, () => {
    const { c, state, send } = control();
    send({ kind: "allocation", entry });
    if (settled) send({ kind: "worker-settled", entry, outcome: "rejected" });
    c.abandon("lost");
    expect(c.registrationAttempts[0]?.state).toBe(settled ? "settled" : "unconfirmed");
    expect(() => send({ kind: "worker-settled", entry, outcome: "registered" })).toThrow(
      ObservationClosed,
    );
    expect(state.cutoff).not.toBeNull();
  });
}
test("finish cannot omit unresolved operation even when browser enumeration is empty", () => {
  const { c, send } = control();
  send({ kind: "allocation", entry });
  c.abandon("lost");
  c.expect({ id: "finish", role: "finish", caseIds: [] }, "f", "http://localhost/?token=f", "h");
  c.receive({ run: "r", doc: "f", seq: 0, kind: "hello", token: "f", group: "finish" });
  expect(() =>
    c.receive({ run: "r", doc: "f", seq: 1, kind: "run-complete", remaining: [] }),
  ).toThrow("unjoined");
  expect(c.runComplete).toBe(false);
});
for (const value of [
  null,
  { ...entry, scriptURL: "file:///sw" },
  { ...entry, name: `${entry.name}#x` },
  { ...entry, clientURL: "/relative" },
]) {
  test(`malformed worker entry has no protocol authority: ${JSON.stringify(value)}`, () => {
    expect(() =>
      parseMessage({ run: "r", doc: "d", seq: 0, kind: "allocation", entry: value }),
    ).toThrow();
  });
}

test("fixture admission follows the live exact document, token and case", () => {
  const { c, state } = control();
  const limits = {
    budgets: { hello: 1000, heartbeat: 1000, case: 1000, group: 2000, run: 5000 },
    runStartedAt: performance.now(),
  };
  expect(c.admitFixture("t", "d", "c", limits).state).toBe(state);
  for (const [token, doc, id] of [
    ["wrong", "d", "c"],
    ["t", "old", "c"],
    ["t", "d", "other"],
  ])
    expect(() => c.admitFixture(token!, doc!, id!, limits)).toThrow(ObservationClosed);
  c.abandon("revoked");
  expect(() => c.admitFixture("t", "d", "c", limits)).toThrow(ObservationClosed);
});
test("settlement must repeat the exact admitted metadata and cannot be reported twice", () => {
  const { c, send } = control();
  send({ kind: "allocation", entry });
  expect(() =>
    send({
      kind: "worker-settled",
      entry: { ...entry, scriptURL: "http://localhost/foreign" },
      outcome: "registered",
    }),
  ).toThrow();
  expect(c.registrationAttempts[0]?.state).toBe("admitted");
  send({ kind: "worker-settled", entry, outcome: "rejected" });
  expect(() => send({ kind: "worker-settled", entry, outcome: "registered" })).toThrow();
  expect(c.registrationAttempts).toEqual([{ entry, state: "settled", outcome: "rejected" }]);
});

test("aggregate page failures preserve primary and cleanup causes", async () => {
  const { formatHostError } = await import("./protocol.js");
  const text = formatHostError(
    new AggregateError(
      [
        new Error("PRIMARY"),
        new AggregateError([new Error("UNREGISTER"), new Error("RUNTIME")], "CLEANUP"),
      ],
      "BOTH",
    ),
  );
  expect(text).toContain("PRIMARY");
  expect(text).toContain("UNREGISTER");
  expect(text).toContain("RUNTIME");
  expect(text.indexOf("PRIMARY")).toBeLessThan(text.indexOf("UNREGISTER"));
});

test("nested worker scope allowance belongs only to the exact declared script", async () => {
  const collector = new Collector("r", ["c"], ["c"], {
    listIds: () => ["c"],
    check() {},
  });
  const host = serveCollector(collector, { "/assets/sw.js": "", "/other.js": "" }, undefined, 0);
  const owned: ServiceWorkerEntry = {
    kind: "service-worker",
    name: `${host.origin}/_waffle_owned/r/`,
    clientURL: `${host.origin}/_waffle_owned/r/client.html?token=t`,
    scriptURL: `${host.origin}/assets/sw.js?waffle-run=r`,
  };
  collector.declareWorker("c", owned);
  try {
    const response = await fetch(owned.scriptURL);
    expect(response.status).toBe(200);
    expect(response.headers.get("Service-Worker-Allowed")).toBe(owned.name);
    for (const path of ["/assets/sw.js", "/other.js", "/assets/sw.js?waffle-run=foreign"]) {
      const other = await fetch(host.origin + path);
      expect(other.headers.get("Service-Worker-Allowed")).toBeNull();
      if (path.includes("foreign")) expect(other.status).toBe(404);
    }
  } finally {
    await host.server.stop(true);
  }
});
