import { expect, test } from "bun:test";
import { Collector } from "./collector.js";

test("peer registration preserves the coordinator and independent ordered streams", () => {
  const collector = new Collector("run", ["case"], ["case"], {
    listIds: () => ["case"],
    check() {},
  });
  const root = collector.expect(
    { id: "case", role: "case", caseIds: ["case"], execution: "host" },
    "root",
    "http://runner/?token=root",
    "root",
  );
  collector.receive({
    run: "run",
    doc: "root-doc",
    seq: 0,
    kind: "hello",
    token: "root",
    group: "case",
  });
  collector.receive({ run: "run", doc: "root-doc", seq: 1, kind: "case-ready", caseId: "case" });
  collector.beginHost(root, "case");
  const admission = collector.prepareTransition(root, "create", performance.now() + 15000);
  collector.receive({
    run: "run",
    doc: "root-doc",
    seq: 2,
    kind: "transition-ready",
    transitionId: admission.id,
  });
  collector.executeTransition(admission, 2);
  if (!admission.target) throw new Error("Missing admission target");
  const peer = collector.expectPeer(
    root,
    admission.target.peer,
    admission.target.generation,
    admission.target.token,
    admission.target.url,
    "peer-handle",
    admission,
  );
  collector.receive({
    run: "run",
    doc: "peer-doc",
    seq: 0,
    kind: "hello",
    token: admission.target.token,
    group: "case",
  });
  collector.receive({ run: "run", doc: "peer-doc", seq: 1, kind: "peer-ready" });
  collector.receive({ run: "run", doc: "root-doc", seq: 3, kind: "error", message: "root" });
  collector.receive({ run: "run", doc: "peer-doc", seq: 2, kind: "error", message: "peer" });
  expect(collector.active).toBe(root);
  expect(peer.messages).toHaveLength(3);
  expect(root.messages).toHaveLength(4);
  expect(collector.failures.map((failure) => failure.detail)).toEqual(["root", "peer"]);
});

function peersFixture() {
  let now = 0;
  const calls: string[][] = [];
  const collector = new Collector(
    "run",
    ["case"],
    ["case"],
    {
      listIds: () => ["case"],
      check() {},
      allocation(_entry, ids) {
        calls.push(Array.from(ids));
      },
    },
    () => now,
  );
  const root = collector.expect(
    { id: "case", role: "case", caseIds: ["case"], execution: "host" },
    "root",
    "http://runner/?token=root",
    "root",
  );
  const sequence = new Map<string, number>();
  function send(doc: string, body: import("./protocol.js").Body) {
    const seq = sequence.get(doc) ?? 0;
    const result = collector.receive({ run: "run", doc, seq, ...body });
    sequence.set(doc, seq + 1);
    return result;
  }
  send("root-doc", { kind: "hello", token: "root", group: "case" });
  send("root-doc", { kind: "case-ready", caseId: "case" });
  collector.beginHost(root, "case");
  function add(id: string) {
    const transition = collector.prepareTransition(root, "create", now + 15000);
    send("root-doc", { kind: "transition-ready", transitionId: transition.id });
    collector.executeTransition(transition, root.messages.length - 1);
    if (!transition.target) throw new Error("Missing target");
    const state = collector.expectPeer(
      root,
      transition.target.peer,
      transition.target.generation,
      transition.target.token,
      transition.target.url,
      id + "-handle",
      transition,
    );
    send(id, { kind: "hello", token: transition.target.token, group: "case" });
    send(id, { kind: "peer-ready" });
    collector.completeTransition(transition, state.handle, state, null);
    return state;
  }
  return {
    collector,
    root,
    send,
    add,
    calls,
    clock: (value: number) => {
      now = value;
    },
  };
}
test("four live peer streams interleave and retry without switching verdict authority", () => {
  const f = peersFixture();
  const peers = Array.from({ length: 4 }, (_, index) => f.add(`peer-${index}`));
  for (const [index, peer] of peers.entries()) {
    const operation = `operation-${index}`;
    f.collector.registerTask(peer, operation);
    const body = { kind: "task-end" as const, caseId: "case", operation, status: "pass" as const };
    expect(f.send(peer.doc ?? "", body)).toEqual({ ackedThrough: 2 });
    expect(f.collector.receive({ run: "run", doc: peer.doc, seq: 2, ...body })).toEqual({
      ackedThrough: 2,
    });
  }
  expect(f.collector.active).toBe(f.root);
  expect(f.collector.outcomes.case?.status).toBe("running");
  expect(f.collector.failures).toEqual([]);
});
for (const kind of [
  "case-start",
  "case-end",
  "case-ready",
  "case-teardown",
  "list",
  "run-complete",
  "doc-complete",
  "retire-ready",
]) {
  test(`peer cannot send coordinator-only ${kind}`, () => {
    const f = peersFixture();
    const peer = f.add("owner");
    expect(() =>
      f.collector.receive({
        run: "run",
        doc: peer.doc,
        seq: 2,
        kind,
        caseId: "case",
        status: "pass",
        remaining: [],
        cases: [],
      }),
    ).toThrow("authority");
    expect(f.collector.outcomes.case?.status).toBe("running");
    expect(f.collector.ledger).toEqual([]);
  });
}
test("unknown tokens and unsolicited successor hellos never acquire the active coordinator", () => {
  for (const token of ["wrong", "root", "owner-token"]) {
    const f = peersFixture();
    f.add("owner");
    expect(() =>
      f.collector.receive({
        run: "run",
        doc: "unannounced",
        seq: 0,
        kind: "hello",
        token,
        group: "case",
      }),
    ).toThrow();
    expect(f.collector.documents.every((state) => state.doc !== "unannounced")).toBe(true);
  }
});
test("successor registration is illegal until the acknowledged transition is executing", () => {
  const f = peersFixture();
  const transition = f.collector.prepareTransition(f.root, "create", 15000);
  expect(() =>
    f.collector.expectPeer(f.root, "peer", 0, "token", "url", "handle", transition),
  ).toThrow("Unauthorized");
  expect(f.collector.documents).toHaveLength(1);
});
test("transition source, one-use identity, watermark and deadline are enforced before consumption", () => {
  const f = peersFixture();
  const owner = f.add("owner");
  const transition = f.collector.prepareTransition(owner, "close", 15000);
  expect(() =>
    f.send("root-doc", { kind: "transition-ready", transitionId: transition.id }),
  ).toThrow("Unsolicited");
  expect(transition.progress.kind).toBe("accepted");
  expect(owner.cutoff).toBeNull();
  const g = peersFixture();
  const peer = g.add("peer");
  const close = g.collector.prepareTransition(peer, "close", 15000);
  expect(() => g.collector.executeTransition(close, 1)).toThrow("acknowledgement");
  expect(peer.cutoff).toBeNull();
});
test("per-generation liveness is not renewed by root or another peer", () => {
  const f = peersFixture();
  const silent = f.add("silent");
  f.add("alive");
  f.clock(10000);
  f.collector.heartbeat({ run: "run", doc: "root-doc", kind: "heartbeat", failure: null });
  f.collector.heartbeat({ run: "run", doc: "alive", kind: "heartbeat", failure: null });
  const budgets = { hello: 20000, heartbeat: 10000, case: 600000, group: 600000, run: 600000 };
  expect(f.collector.deadline(budgets, 0)).toBe("heartbeat-lost");
  expect(f.collector.overdueDocument(budgets)).toBe(silent);
});
test("reload keeps generations separate and the predecessor cannot authorize a second action", () => {
  const f = peersFixture();
  const old = f.add("owner");
  const transition = f.collector.prepareTransition(old, "reload", 15000);
  f.send("owner", { kind: "transition-ready", transitionId: transition.id });
  f.collector.executeTransition(transition, old.messages.length - 1);
  if (!transition.target) throw new Error("Missing successor target");
  const next = f.collector.expectPeer(
    f.root,
    transition.target.peer,
    transition.target.generation,
    transition.target.token,
    transition.target.url,
    old.handle,
    transition,
  );
  f.send("next", { kind: "hello", token: transition.target.token, group: "case" });
  f.send("next", { kind: "peer-ready" });
  f.collector.completeTransition(transition, old.handle, next, null);
  f.clock(9000);
  f.collector.heartbeat({ run: "run", doc: "owner", kind: "heartbeat", failure: null });
  expect(next.heartbeatAt).toBe(0);
  expect(old.physical).toBe("superseded");
  expect(() => f.collector.prepareTransition(old, "reload", 15000)).toThrow();
  expect(() => f.send("owner", { kind: "error", message: "old late event" })).toThrow("cutoff");
});
test("peer allocations use only their authorized case and exact duplicates are idempotent", () => {
  const f = peersFixture();
  f.add("owner");
  f.add("waiter");
  for (const doc of ["owner", "waiter"])
    f.send(doc, { kind: "allocation", entry: { kind: "indexeddb", name: "exact" } });
  expect(f.calls).toEqual([["case"], ["case"]]);
  expect(f.collector.ledger).toEqual([{ kind: "indexeddb", name: "exact" }]);
});
test("a cutoff is not physical containment and cannot finalize coordinator pass", () => {
  const f = peersFixture();
  const peer = f.add("owner");
  peer.cutoff = 1;
  f.send("root-doc", { kind: "case-teardown", caseId: "case" });
  f.send("root-doc", { kind: "case-end", caseId: "case", status: "pass" });
  f.send("root-doc", { kind: "doc-complete" });
  f.root.retiring = true;
  f.send("root-doc", { kind: "retire-ready" });
  expect(() => f.collector.retire(f.root, f.root.messages.length - 1)).toThrow("physically");
  expect(f.collector.outcomes.case).toEqual({ status: "pass", provisional: true });
});
for (const field of ["token", "peer", "generation", "url"] as const) {
  test(`peer admission rejects a wrong reserved ${field} before mutation`, () => {
    const f = peersFixture();
    const transition = f.collector.prepareTransition(f.root, "create", 15000);
    f.send("root-doc", { kind: "transition-ready", transitionId: transition.id });
    f.collector.executeTransition(transition, f.root.messages.length - 1);
    if (!transition.target) throw new Error("Missing reserved target");
    const target = transition.target;
    expect(() =>
      f.collector.expectPeer(
        f.root,
        field === "peer" ? "wrong" : target.peer,
        field === "generation" ? target.generation + 2 : target.generation,
        field === "token" ? "wrong" : target.token,
        field === "url" ? "http://foreign/" : target.url,
        "actual",
        transition,
      ),
    ).toThrow("Unauthorized");
    expect(f.collector.documents).toHaveLength(1);
    expect(f.collector.ledger).toEqual([]);
  });
}

test("an unsolicited reload hello fails against its consumed peer token without admitting it", () => {
  const f = peersFixture();
  const peer = f.add("owner");
  if (peer.owner.kind !== "peer") throw new Error("Expected peer owner");
  f.collector.registerTask(peer, "unfinished");
  f.clock(100);
  const messages = peer.messages.slice();
  const transitions = f.collector.transitions.length;
  expect(() =>
    f.collector.receive({
      run: "run",
      doc: "unannounced-reload",
      seq: 0,
      kind: "hello",
      token: peer.token,
      group: peer.group.id,
    }),
  ).toThrow("Wrong run or no expected document");
  expect(f.collector.failures).toEqual([
    {
      group: peer.group.id,
      category: "protocol",
      detail: "Wrong run or no expected document",
      document: {
        doc: peer.doc,
        peer: peer.owner.peer,
        generation: 0,
        handle: peer.handle,
      },
    },
  ]);
  expect(f.collector.active).toBe(f.root);
  expect(f.collector.documents).toHaveLength(2);
  expect(f.collector.transitions).toHaveLength(transitions);
  expect(peer.doc).toBe("owner");
  expect(peer.messages).toEqual(messages);
  expect(peer.heartbeatAt).toBe(0);
  expect(peer.cutoff).toBeNull();
  expect(peer.physical).toBe("live");
  expect(peer.tasks.get("unfinished")).toEqual({ status: "pending" });
  expect(f.collector.outcomes.case?.status).toBe("running");
  expect(f.collector.ledger).toEqual([]);
});

for (const fault of ["wrong-run", "unknown-token"] as const) {
  test(`an unbound ${fault} hello cannot claim peer failure attribution`, () => {
    const f = peersFixture();
    const peer = f.add("owner");
    expect(() =>
      f.collector.receive({
        run: fault === "wrong-run" ? "foreign" : "run",
        doc: "unannounced",
        seq: 0,
        kind: "hello",
        token: fault === "unknown-token" ? "unknown" : peer.token,
        group: peer.group.id,
      }),
    ).toThrow("Wrong run or no expected document");
    expect(f.collector.failures).toEqual([
      { group: "case", category: "protocol", detail: "Wrong run or no expected document" },
    ]);
    expect(f.collector.documents).toHaveLength(2);
    expect(peer.doc).toBe("owner");
    expect(peer.messages).toHaveLength(2);
    expect(f.collector.ledger).toEqual([]);
  });
}
