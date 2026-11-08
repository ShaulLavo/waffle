import { expect, test } from "bun:test";
import { FrameworkCollector } from "./framework-collector.js";
import { dispatchReports } from "./collector-fetch.js";
import { reportingPage, reportBody, waitUntil } from "./reporting-fixture.js";
import type { FrameworkObservation } from "./framework-page.js";

const expected = Array.from({ length: 38 }, (_, index) => ({
  file: "synthetic.ts",
  fullName: `synthetic ${index}`,
  sourceKey: `synthetic:${index}`,
  timeoutMs: 15000,
  retries: 0 as const,
}));
const tasks = expected.map(
  (item, index) =>
    ({
      id: String(index),
      parentId: null,
      type: "test",
      file: item.file,
      fullName: item.fullName,
      mode: "run",
      timeoutMs: item.timeoutMs,
      retries: 0,
    }) as const,
);
test("actual bootstrap accessor paces 38 synthetic outcomes behind exact collector ACKs", async () => {
  const collector = new FrameworkCollector(expected);
  const document = collector.expect("tester", "http://fixture/tester");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let hold = false;
  const post = async (url: string, init: RequestInit) => {
    const reply = await dispatchReports(new Request(`http://fixture${url}`, init), collector);
    if (!reply) throw new Error("Missing actual collector reply");
    if (hold && url === "/report") {
      entered.resolve();
      await gate.promise;
    }
    return reply;
  };
  try {
    await reportingPage(collector.run, document.token, post, async ({ observation, snapshot }) => {
      await waitUntil(() => document.doc !== null);
      document.admitted = true;
      collector.viewportConsumed = true;
      await observation.collected(() => tasks);
      hold = true;
      let started = false;
      const first = observation
        .taskStarted(() => "0")
        .then(() => {
          started = true;
        });
      await entered.promise;
      expect(document.messages.length - 1).toBe(2);
      expect(snapshot().ackedThrough).toBe(1);
      expect(started).toBe(false);
      gate.resolve();
      await first;
      for (let index = 0; index < 38; index++) {
        if (index) await observation.taskStarted(() => String(index));
        const update = {
          id: String(index),
          state: index % 2 ? "fail" : "pass",
          errors: [],
          hooks: {},
          retryCount: 0,
        } as const;
        await observation.taskUpdate(() => [update]);
        await observation.caseSettled(() => [update]);
      }
      await observation.caseSettled(() => null);
      const closing = observation.executionFlushed();
      expect(snapshot().contentClosed).toBe(true);
      await closing;
      await observation.testerCleanupSettled();
      expect(collector.cases.filter((item) => item.outcome !== null)).toHaveLength(38);
      expect(collector.cases.map((item) => item.outcome?.state)).toEqual(
        Array.from({ length: 38 }, (_, index) => (index % 2 ? "fail" : "pass")),
      );
      expect(snapshot().pending).toBe(0);
      expect(snapshot().ackedThrough).toBe(document.messages.length - 1);
      expect(snapshot().failure).toBeNull();
      expect(document.cutoff).toBeNull();
    });
  } finally {
    gate.resolve();
  }
});
const categories = (observation: FrameworkObservation) => [
  () => observation.collected(() => tasks),
  () => observation.taskStarted(() => "id"),
  () => observation.taskUpdate(() => []),
  () => observation.caseSettled(() => null),
  () => observation.error(() => ({ error: "nested", source: "synthetic" })),
];
for (let category = 0; category < 5; category++) {
  test(`factory category ${category} rejects conversion reentry without a sequence or self-wait`, async () => {
    const messages: unknown[] = [];
    await reportingPage(
      "run",
      "token",
      async (_url, init) => {
        const body = reportBody(init);
        messages.push(body);
        return Response.json({ ackedThrough: body.seq });
      },
      async ({ observation, snapshot }) => {
        await waitUntil(() => snapshot().pending === 0);
        let nested: Promise<void> | undefined;
        const outer = observation.error(() => {
          nested = categories(observation)[category]?.();
          return { error: "outer", source: "synthetic" };
        });
        await expect(outer).rejects.toThrow("reentry");
        await expect(nested).rejects.toThrow("reentry");
        expect(snapshot().ackedThrough).toBe(0);
        expect(snapshot().pending).toBe(0);
        expect(messages).toHaveLength(1);
        expect(observation.signal.aborted).toBe(true);
        const closing = observation.testerCleanupSettled();
        expect(snapshot().contentClosed).toBe(true);
        await expect(closing).rejects.toThrow("reentry");
      },
    );
  });
}
test("pagehide cancels actual reporting while abort-ignoring fetch retains its slot", async () => {
  const gate = Promise.withResolvers<void>();
  let hold = false;
  try {
    await reportingPage(
      "run",
      "token",
      async (_url, init) => {
        if (hold) await gate.promise;
        return Response.json({ ackedThrough: reportBody(init).seq });
      },
      async ({ observation, snapshot, pagehide }) => {
        await waitUntil(() => snapshot().pending === 0);
        hold = true;
        const delivery = observation.error(() => ({ error: "held", source: "cpu" }));
        const owned = delivery.catch(() => {});
        await Bun.sleep(0);
        pagehide();
        expect(observation.signal.aborted).toBe(true);
        expect(snapshot().pending).toBe(1);
        gate.resolve();
        await owned;
        await expect(delivery).rejects.toThrow();
        expect(snapshot().ackedThrough).toBe(0);
      },
    );
  } finally {
    gate.resolve();
  }
});
