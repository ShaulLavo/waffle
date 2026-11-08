import { expect, test } from "bun:test";
import { FrameworkCollector } from "./framework-collector.js";
import { dispatchReports } from "./collector-fetch.js";
import type {
  ExpectedCase,
  FrameworkEvent,
  FrameworkTask,
  FrameworkUpdate,
} from "./framework-types.js";

function fixture(timeouts: readonly number[] = [15000]) {
  const expected: ExpectedCase[] = timeouts.map((timeoutMs, index) => ({
    file: "original.ts",
    fullName: index === 0 ? "suite > required" : `suite > required ${index}`,
    sourceKey: `original:${index + 1}`,
    timeoutMs,
    retries: 0,
  }));
  const collector = new FrameworkCollector(expected);
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
  const suites: FrameworkTask[] = [
    {
      id: "actual-suite",
      parentId: null,
      type: "suite",
      file: "original.ts",
      fullName: "suite",
      mode: "run",
      timeoutMs: 30000,
      retries: 0,
    },
  ];
  const actual = suites.concat(
    expected.map((item, index): FrameworkTask => ({
      ...item,
      id: index === 0 ? "actual-case" : `actual-case-${index}`,
      parentId: "actual-suite",
      type: "test",
      mode: "run",
    })),
  );
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

function malformedEvent(field: string, value: unknown, f: ReturnType<typeof fixture>): unknown {
  if (field === "task-type")
    return {
      kind: "collected",
      tasks: f.actual.map((task) => (task.type === "suite" ? { ...task, type: value } : task)),
    };
  f.send({ kind: "collected", tasks: f.actual });
  if (field === "event-kind") return { kind: value };
  f.send({ kind: "task-started", id: "actual-case" });
  return {
    kind: "case-settled",
    updates: [{ id: "actual-case", state: value, errors: [], hooks: null, retryCount: 0 }],
  };
}
for (const [field, label] of Object.entries({
  "task-type": "suite",
  "event-kind": "execution-flushed",
  "terminal-state": "skip",
})) {
  for (const value of [[label], { value: label }]) {
    test(`non-string ${field} ${JSON.stringify(value)} is a sticky collector failure`, async () => {
      const f = fixture();
      const event = malformedEvent(field, value, f);
      const messages = f.tester.messages.length;
      const response = await dispatchReports(
        new Request("http://fixture/report", {
          method: "POST",
          body: JSON.stringify({
            run: f.collector.run,
            token: f.tester.token,
            doc: f.tester.doc,
            seq: messages,
            kind: "event",
            event,
          }),
        }),
        f.collector,
      );
      expect(response?.status).toBe(409);
      expect(f.collector.failures).toHaveLength(1);
      expect(f.collector.failures[0]?.category).toBe("collector");
      expect(f.tester.messages).toHaveLength(messages);
      expect(f.collector.cases[0]?.outcome).toBeNull();
    });
  }
}

test("collection retains mixed declared clocks by identity, not inventory order", () => {
  const { collector, actual, send } = fixture([15000, 20000, 1000]);
  actual.reverse();
  send({ kind: "collected", tasks: actual });
  expect(collector.collection).toEqual(actual);
  expect(collector.cases.map((item) => item.expected.timeoutMs)).toEqual([15000, 20000, 1000]);
  expect(collector.cases.map((item) => item.actualId)).toEqual([
    "actual-case",
    "actual-case-1",
    "actual-case-2",
  ]);
  expect(collector.cases.every((item) => !item.started)).toBe(true);
});

for (const { expectedMs, actualMs } of [
  { expectedMs: 20000, actualMs: 15000 },
  { expectedMs: 15000, actualMs: 20000 },
  { expectedMs: 20000, actualMs: 1000 },
]) {
  test(`collection rejects declared ${expectedMs} ms versus actual ${actualMs} ms`, () => {
    const { collector, actual, send } = fixture([expectedMs]);
    const tasks = actual.map((item) =>
      item.type === "test" ? { ...item, timeoutMs: actualMs } : item,
    );
    expect(() => send({ kind: "collected", tasks })).toThrow("Original case options changed");
    expect(collector.collection).toEqual([]);
    expect(collector.cases[0]?.actualId).toBeNull();
    expect(collector.cases[0]?.started).toBe(false);
  });
}

test("collection rejects clocks swapped between independently named cases", () => {
  const { collector, actual, send } = fixture([20000, 15000]);
  const tasks = actual.map((item) =>
    item.type === "test" ? { ...item, timeoutMs: item.timeoutMs === 20000 ? 15000 : 20000 } : item,
  );
  expect(() => send({ kind: "collected", tasks })).toThrow("Original case options changed");
  expect(collector.collection).toEqual([]);
  expect(collector.cases.every((item) => item.actualId === null && !item.started)).toBe(true);
});

for (const timeoutMs of [undefined, null, "20000", false, 0, -1, NaN, Infinity, -Infinity]) {
  test(`collection rejects invalid actual clock ${String(timeoutMs)} without binding`, () => {
    const { collector, actual, send } = fixture([20000]);
    const item = actual.find((item) => item.type === "test");
    if (!item) throw new Error("Missing fixture case");
    Reflect.set(item, "timeoutMs", timeoutMs);
    expect(() => send({ kind: "collected", tasks: actual })).toThrow();
    expect(collector.collection).toEqual([]);
    expect(collector.cases[0]?.actualId).toBeNull();
    expect(collector.cases[0]?.started).toBe(false);
    expect(collector.events).toEqual([]);
  });
}

test("nondefault actual clocks still require run mode and zero retries", () => {
  for (const changed of [{ mode: "skip" }, { retries: 1 }]) {
    const { collector, actual, send } = fixture([20000]);
    const tasks = actual.map((item) => (item.type === "test" ? { ...item, ...changed } : item));
    expect(() => send({ kind: "collected", tasks })).toThrow("Original case options changed");
    expect(collector.collection).toEqual([]);
    expect(collector.cases[0]?.actualId).toBeNull();
  }
});
