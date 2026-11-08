import { reportingTypes } from "./reporting-types.js";
import { expect, test } from "bun:test";
import { FrameworkCollector } from "./framework-collector.js";
import { dispatchReports } from "./collector-fetch.js";
import { reportingPage, reportBody, waitUntil } from "./reporting-fixture.js";
import type { FrameworkObservation, FrameworkUpdate } from "./framework-page.js";

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
async function reportOutcomes(observation: FrameworkObservation): Promise<void> {
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
}
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
    await reportingPage(
      collector.run,
      document.token,
      post,
      async ({ observation, snapshot }) => {
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
        await reportOutcomes(observation);
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
      },
      () => gate.resolve(),
    );
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
      () => gate.resolve(),
    );
  } finally {
    gate.resolve();
  }
});

// Compile the negative call shapes without invoking their reporting operations.
void reportingTypes;

test("local cutoff rejects held ACK, late tail append and wrong final watermark", async () => {
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
      async ({ observation, snapshot, cutoff, retire }) => {
        await waitUntil(() => snapshot().pending === 0);
        const oldTail = snapshot().ackedThrough;
        hold = true;
        const closing = observation.executionFlushed();
        expect(snapshot().contentClosed).toBe(true);
        expect(() => cutoff(oldTail)).toThrow("not drained");
        gate.resolve();
        await closing;
        expect(() => cutoff(oldTail)).toThrow("not drained");
        const retired = observation.waitForRetirement();
        retire();
        await waitUntil(() => snapshot().ackedThrough === oldTail + 2);
        expect(cutoff(snapshot().ackedThrough)).toBe(true);
        await retired;
      },
      () => gate.resolve(),
    );
  } finally {
    gate.resolve();
  }
});
async function encodingReentry(
  page: Parameters<Parameters<typeof reportingPage>[3]>[0],
): Promise<void> {
  const { observation, snapshot } = page;
  await waitUntil(() => snapshot().pending === 0);
  let nested: Promise<void> | undefined;
  let reads = 0;
  const convert = () => {
    nested = observation.collected(() => {
      reads++;
      return tasks;
    });
    return "once";
  };
  const error = Object.defineProperty({}, "toJSON", { value: convert });
  const outer = observation.error(() => ({ error, source: "cpu" }));
  await expect(outer).rejects.toThrow("reentry");
  await expect(nested).rejects.toThrow("reentry");
  expect(reads).toBe(0);
  expect(snapshot().ackedThrough).toBe(0);
  expect(snapshot().pending).toBe(0);
}
test("encoding toJSON reentry refuses reporting without a nested conversion", () =>
  reportingPage(
    "run",
    "token",
    async (_url, init) => Response.json({ ackedThrough: reportBody(init).seq }),
    encodingReentry,
  ));

test("bootstrap snapshots external updates once before the held delivery", async () => {
  const gate = Promise.withResolvers<void>();
  let hold = false;
  const bodies: Record<string, unknown>[] = [];
  await reportingPage(
    "run",
    "token",
    async (_url, init) => {
      if (hold) await gate.promise;
      const body = reportBody(init);
      bodies.push(body);
      return Response.json({ ackedThrough: body.seq });
    },
    async ({ observation, snapshot }) => {
      await waitUntil(() => snapshot().pending === 0);
      hold = true;
      const errors = ["original"];
      const update: { -readonly [Key in keyof FrameworkUpdate]: FrameworkUpdate[Key] } = {
        id: "case",
        state: "pass",
        errors,
        hooks: { beforeEach: "pass" },
        retryCount: 0,
      };
      const reporting = observation.taskUpdate(() => [update]);
      update.state = "fail";
      errors.push("late");
      update.retryCount = 1;
      gate.resolve();
      await reporting;
      expect(bodies[1]?.event).toEqual({
        kind: "task-update",
        updates: [
          {
            id: "case",
            state: "pass",
            errors: ["original"],
            hooks: { beforeEach: "pass" },
            retryCount: 0,
          },
        ],
      });
    },
    () => gate.resolve(),
  );
});
function errorBurst(observation: FrameworkObservation): Promise<void>[] {
  return Array.from({ length: 64 }, (_, index) =>
    observation.error(() => ({ error: String(index), source: "cpu-burst" })),
  );
}
test("65 unpaced bootstrap errors fail incomplete while the admitted prefix drains", async () => {
  const gate = Promise.withResolvers<void>();
  let hold = false;
  const sequences: unknown[] = [];
  await reportingPage(
    "run",
    "token",
    async (_url, init) => {
      if (hold) await gate.promise;
      const body = reportBody(init);
      sequences.push(body.seq);
      return Response.json({ ackedThrough: body.seq });
    },
    async ({ observation, snapshot }) => {
      await waitUntil(() => snapshot().pending === 0);
      hold = true;
      const pending = errorBurst(observation);
      try {
        await expect(
          observation.error(() => ({ error: "overflow", source: "cpu-burst" })),
        ).rejects.toThrow("capacity");
        expect(snapshot().pending).toBe(64);
        gate.resolve();
        await Promise.all(pending);
        expect(snapshot().pending).toBe(0);
        expect(snapshot().ackedThrough).toBe(64);
        expect(snapshot().failure).toContain("capacity");
        expect(sequences).toEqual(Array.from({ length: 65 }, (_, index) => index));
      } finally {
        gate.resolve();
        await Promise.allSettled(pending);
      }
    },
    () => gate.resolve(),
  );
});

test("cancellation after actual collector acceptance preserves the missing page ACK", async () => {
  const collector = new FrameworkCollector(expected.slice(0, 1));
  const document = collector.expect("tester", "http://fixture/tester");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let hold = false;
  await reportingPage(
    collector.run,
    document.token,
    async (url, init) => {
      const reply = await dispatchReports(new Request(`http://fixture${url}`, init), collector);
      if (!reply) throw new Error("Missing collector reply");
      if (hold && url === "/report") {
        entered.resolve();
        await gate.promise;
      }
      return reply;
    },
    async ({ observation, snapshot, pagehide }) => {
      await waitUntil(() => document.doc !== null);
      document.admitted = true;
      collector.viewportConsumed = true;
      await observation.collected(() => tasks.slice(0, 1));
      hold = true;
      const reporting = observation.taskStarted(() => "0");
      const owned = reporting.catch(() => {});
      await entered.promise;
      expect(collector.cases[0]?.started).toBe(true);
      expect(document.messages.length - 1).toBe(2);
      expect(snapshot().ackedThrough).toBe(1);
      pagehide();
      expect(snapshot().pending).toBe(1);
      gate.resolve();
      await owned;
      await expect(reporting).rejects.toThrow();
      expect(snapshot().pending).toBe(0);
      expect(snapshot().ackedThrough).toBe(1);
      expect(document.cutoff).toBeNull();
    },
    () => gate.resolve(),
  );
});

function heldHeartbeat(phase: "fetch" | "parse") {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const messages: Record<string, unknown>[] = [];
  const post = async (url: string, init: RequestInit) => {
    if (url === "/report") {
      const body = reportBody(init);
      messages.push(body);
      return Response.json({ ackedThrough: body.seq });
    }
    if (phase === "fetch") {
      entered.resolve();
      await release.promise;
    }
    const response = Response.json({ kind: "live", retire: false });
    if (phase === "fetch") return response;
    const parse = response.json.bind(response);
    response.json = async () => {
      entered.resolve();
      await release.promise;
      return parse();
    };
    return response;
  };
  return { entered, release, messages, post };
}
async function pendingHeartbeatRetirement(
  page: Parameters<Parameters<typeof reportingPage>[3]>[0],
  fixture: ReturnType<typeof heldHeartbeat>,
): Promise<void> {
  await page.observation.executionFlushed();
  await page.observation.testerCleanupSettled();
  page.heartbeat();
  await fixture.entered.promise;
  page.retire();
  await Bun.sleep(0);
  expect(fixture.messages.some((body) => body.kind === "retire-ready")).toBe(false);
  expect(() => page.cutoff(page.snapshot().ackedThrough)).toThrow("not drained");
}
for (const phase of ["fetch", "parse"] as const) {
  test(`bootstrap retirement and fixture cleanup join held heartbeat ${phase}`, async () => {
    const fixture = heldHeartbeat(phase);
    const { release, post } = fixture;
    const callbackDone = Promise.withResolvers<void>();
    let finished = false;
    const use: Parameters<typeof reportingPage>[3] = async (page) => {
      await pendingHeartbeatRetirement(page, fixture);
    };
    const observing: typeof use = (page) => use(page).finally(() => callbackDone.resolve());
    const running = reportingPage("run", "token", post, observing).finally(() => {
      finished = true;
    });
    void running.catch(() => {});
    try {
      await Promise.race([callbackDone.promise, running]);
      await Bun.sleep(0);
      expect(finished).toBe(false);
    } finally {
      release.resolve();
      await running;
    }
    expect(finished).toBe(true);
  });
}

for (const phase of ["fetch", "parse"] as const) {
  test(`healthy retirement waits for heartbeat ${phase} before exact ready ACK and cutoff`, async () => {
    const fixture = heldHeartbeat(phase);
    const { release, messages, post } = fixture;
    const use: Parameters<typeof reportingPage>[3] = async (page) => {
      await pendingHeartbeatRetirement(page, fixture);
      release.resolve();
      await waitUntil(
        () =>
          messages.some((body) => body.kind === "retire-ready") && page.snapshot().pending === 0,
      );
      expect(page.snapshot().failure).toBeNull();
      const retired = page.observation.waitForRetirement();
      expect(page.cutoff(page.snapshot().ackedThrough)).toBe(true);
      await retired;
    };
    await reportingPage("run", "token", post, use, () => release.resolve());
  });
}
