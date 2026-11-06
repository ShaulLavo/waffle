import { expect, test } from "bun:test";
import { FrameworkCollector } from "./framework-collector.js";
import type { FrameworkEvent, FrameworkTask, FrameworkUpdate } from "./framework-types.js";

function fixture() {
  const expected = {
    file: "original.ts",
    fullName: "suite > required",
    sourceKey: "original:1",
    timeoutMs: 15000,
    retries: 0,
  } as const;
  const collector = new FrameworkCollector([expected]);
  const top = collector.expect("orchestrator", "http://fixture/top");
  const tester = collector.expect("tester", "http://fixture/tester");
  function hello(document: typeof top, doc: string) {
    collector.receive({
      run: collector.run,
      token: document.token,
      doc,
      seq: 0,
      kind: "hello",
      role: document.kind,
      url: document.url,
    });
    document.admitted = true;
  }
  hello(top, "actual-top");
  hello(tester, "actual-tester");
  const send = (event: FrameworkEvent) => {
    const document = event.kind === "cleanup-response-received" ? top : tester;
    return collector.receive({
      run: collector.run,
      token: document.token,
      doc: document.doc,
      seq: document.messages.length,
      kind: "event",
      event,
    });
  };
  const actual: FrameworkTask[] = [
    {
      id: "actual-suite",
      parentId: null,
      type: "suite",
      file: expected.file,
      fullName: "suite",
      mode: "run",
      timeoutMs: 30000,
      retries: 0,
    },
    { ...expected, id: "actual-case", parentId: "actual-suite", type: "test", mode: "run" },
  ];
  collector.viewportConsumed = true;
  return { collector, actual, send, top, tester };
}
test("actual task IDs are bound only by independent collection, and repeated update revisions are not terminals", () => {
  const { collector, actual, send } = fixture();
  expect(collector.cases[0]?.actualId).toBeNull();
  send({ kind: "collected", tasks: actual });
  send({ kind: "task-started", id: "actual-suite" });
  send({ kind: "task-started", id: "actual-case" });
  const update: FrameworkUpdate = {
    id: "actual-case",
    state: "pass",
    errors: [],
    hooks: null,
    retryCount: 0,
  };
  send({ kind: "task-update", updates: [update] });
  send({ kind: "task-update", updates: [update] });
  expect(collector.cases[0]?.outcome).toBeNull();
  send({ kind: "case-settled", updates: [update] });
  send({ kind: "execution-flushed" });
  // Different document outboxes may arrive in either HTTP order after actual cleanup.
  send({ kind: "cleanup-response-received" });
  send({ kind: "tester-cleanup-settled" });
  expect(collector.cases[0]?.actualId).toBe("actual-case");
  expect(collector.cases[0]?.started).toBe(true);
  expect(collector.cleanupResponse && collector.cleanupSettled).toBe(true);
});
test("beforeAll failure retains actual skipped and unrun children without inventing starts", () => {
  const { collector, actual, send } = fixture();
  send({ kind: "collected", tasks: actual });
  send({ kind: "task-started", id: "actual-suite" });
  send({
    kind: "task-update",
    updates: [
      {
        id: "actual-suite",
        state: "fail",
        errors: ["BEFORE_ALL"],
        hooks: { beforeAll: "fail" },
        retryCount: 0,
      },
    ],
  });
  send({
    kind: "case-settled",
    updates: [{ id: "actual-case", state: "skip", errors: [], hooks: null, retryCount: 0 }],
  });
  expect(collector.cases[0]?.started).toBe(false);
  expect(collector.cases[0]?.outcome?.state).toBe("skip");
  expect(JSON.stringify(collector.events)).toContain("BEFORE_ALL");
});
for (const fault of [
  "missing",
  "extra",
  "duplicate",
  "skip",
  "timeout",
  "retry",
  "identity",
] as const) {
  test(`independent inventory rejects ${fault} without dropping the required row`, () => {
    const { collector, actual, send } = fixture();
    const item = actual[1];
    if (!item) throw new Error("Missing fixture case");
    let tasks = actual;
    if (fault === "missing") tasks = actual.slice(0, 1);
    if (fault === "extra") tasks = actual.concat({ ...item, id: "other" });
    if (fault === "duplicate") tasks = actual.concat(item);
    if (fault === "skip") tasks = [actual[0]!, { ...item, mode: "skip" }];
    if (fault === "timeout") tasks = [actual[0]!, { ...item, timeoutMs: 16000 }];
    if (fault === "retry") tasks = [actual[0]!, { ...item, retries: 1 }];
    if (fault === "identity") tasks = [actual[0]!, { ...item, fullName: "different" }];
    expect(() => send({ kind: "collected", tasks })).toThrow();
    expect(collector.cases).toHaveLength(1);
    expect(collector.cases[0]?.actualId).toBeNull();
  });
}
test("identical retries acknowledge once, conflicts and post-cutoff traffic cannot mutate state", () => {
  const { collector, top } = fixture();
  const message = {
    run: collector.run,
    token: top.token,
    doc: top.doc,
    seq: 1,
    kind: "event",
    event: { kind: "error", source: "control", error: "late" },
  };
  expect(collector.receive(message)).toEqual({ ackedThrough: 1 });
  expect(collector.receive(message)).toEqual({ ackedThrough: 1 });
  expect(collector.failures).toHaveLength(1);
  expect(() =>
    collector.receive({ ...message, event: { kind: "error", source: "other", error: "conflict" } }),
  ).toThrow();
  top.cutoff = performance.now();
  expect(() => collector.receive(message)).toThrow("retired");
  expect(collector.failures).toHaveLength(1);
});
