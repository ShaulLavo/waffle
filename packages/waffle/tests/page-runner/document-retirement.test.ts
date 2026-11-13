import { expect, spyOn, test } from "bun:test";
import { BrowserObservation, WorkerCloseUnconfirmed } from "./browser-observation.js";
import { HostConsumers } from "./owned-consumers.js";

function fixture(cleanup: () => Promise<void> = async () => {}) {
  const consumers = new HostConsumers();
  const ledger = new BrowserObservation("owned", consumers, cleanup);
  const events: string[] = [];
  ledger.onWorker((event) => {
    events.push(event.kind);
  });
  ledger.created("one", "https://owned.test/one.js");
  const worker = ledger.workers()[0]!;
  return { consumers, ledger, worker, events };
}
function retire(ledger: BrowserObservation) {
  ledger.beginDocumentClose();
  ledger.documentClosed("safari-target-destroyed");
  return ledger.documentRetirement();
}

for (const timing of ["missing", "before-stop", "after-stop"] as const)
  test(`exact document retirement keeps Worker receipt distinct: ${timing}`, async () => {
    const f = fixture();
    const waiting = f.ledger.waitForWorkerClose(f.worker);
    let settled = false;
    void waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const proof = await retire(f.ledger);
    expect(proof).toMatchObject({
      intent: "close",
      source: "safari-target-destroyed",
      outstandingWorkers: [1],
      outstandingCount: 1,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.outstandingWorkers)).toBe(true);
    expect(Reflect.set(proof, "intent", "navigation")).toBe(false);
    expect(Reflect.set(proof.outstandingWorkers, "0", 999)).toBe(false);
    f.ledger.documentClosed("playwright-page-close");
    expect(await f.ledger.documentRetirement()).toBe(proof);
    expect(settled).toBe(false);
    expect(f.events).toEqual(["created"]);
    if (timing === "before-stop") f.ledger.terminated("one", "safari-worker-terminated");
    await f.ledger.stop();
    if (timing === "after-stop") f.ledger.terminated("one", "safari-worker-terminated");
    if (timing === "before-stop") {
      await waiting;
      await f.ledger.waitForWorkerClose(f.worker);
      expect(f.events).toEqual(["created", "closed"]);
    } else {
      await expect(waiting).rejects.toBeInstanceOf(WorkerCloseUnconfirmed);
      await expect(f.ledger.waitForWorkerClose(f.worker)).rejects.toMatchObject({
        worker: 1,
        retirement: proof.source,
      });
      expect(f.events).toEqual(["created"]);
    }
    const snapshot = f.ledger.diagnosticSnapshot();
    expect(snapshot.retirement).toBe(proof);
    const stages = snapshot.workers.completed
      .find((entry) => entry.facts.worker === 1)
      ?.stages.map((entry) => entry.stage);
    if (timing === "after-stop")
      expect(stages).toEqual(["native-created", "receipt-unconfirmed", "safari-worker-terminated"]);
    expect(await f.consumers.join(100)).toBe(true);
  });

for (const moment of ["callback", "cleanup"] as const)
  for (const termination of [false, true])
    test(`creation during held ${moment}, later termination=${termination}, has permanent stop outcome`, async () => {
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let cleanups = 0;
      let reentrant: Promise<void> | undefined;
      const f = fixture(async () => {
        cleanups++;
        reentrant = f.ledger.stop();
        entered.resolve();
        if (moment === "cleanup") await held.promise;
      });
      if (moment === "callback") f.ledger.onWorker(() => held.promise);
      f.ledger.terminated("one", "safari-worker-terminated");
      const stopped = f.ledger.stop();
      try {
        expect(f.ledger.stop()).toBe(stopped);
        if (moment === "cleanup") await entered.promise;
        f.ledger.created("two", "https://owned.test/two.js");
        const worker = f.ledger.workerIdentity("two");
        const waiting = f.ledger.waitForWorkerClose(worker);
        await expect(waiting).rejects.toThrow("Worker observation retired");
        if (termination) f.ledger.terminated("two", "safari-worker-terminated");
        await expect(f.ledger.waitForWorkerClose(worker)).rejects.toThrow(
          "Worker observation retired",
        );
        expect(f.events).toEqual(["created", "closed"]);
        expect(await f.consumers.join(1)).toBe(false);
        expect(cleanups).toBe(moment === "cleanup" ? 1 : 0);
      } finally {
        held.resolve();
        await stopped;
      }
      expect(cleanups).toBe(1);
      expect(reentrant).toBe(stopped);
      await f.ledger.waitForWorkerClose(f.worker);
      expect(await f.consumers.join(100)).toBe(true);
    });

test("a callback propagating the unconfirmed receipt fails before transport cleanup", async () => {
  let callbackSettled = false;
  const cleanup = Error("cleanup failure");
  const f = fixture(async () => {
    expect(callbackSettled).toBe(true);
    throw cleanup;
  });
  f.ledger.onWorker(async (event) => {
    if (event.kind !== "created") return;
    try {
      await f.ledger.waitForWorkerClose(event.worker);
    } finally {
      callbackSettled = true;
    }
  });
  await retire(f.ledger);
  const [result] = await Promise.allSettled([f.ledger.stop()]);
  if (result?.status !== "rejected" || !(result.reason instanceof AggregateError))
    throw Error("Missing aggregate");
  expect(result.reason.errors[0]).toBeInstanceOf(WorkerCloseUnconfirmed);
  expect(result.reason.errors[1]).toBe(cleanup);
  expect(await f.consumers.join(100)).toBe(true);
});

for (const end of [
  "navigation",
  "wrong-source",
  "lost-after",
  "lost-before",
  "stop-empty",
  "stop-live",
] as const)
  test(`retirement preserves loss and navigation policy: ${end}`, async () => {
    const f = fixture();
    const waiting = f.ledger.waitForWorkerClose(f.worker);
    if (end === "stop-empty") f.ledger.terminated("one", "safari-worker-terminated");
    if (end === "navigation") f.ledger.beginDocumentClose("https://owned.test/next");
    else f.ledger.beginDocumentClose();
    const retired = f.ledger.documentRetirement();
    const loss = Error("original loss");
    if (end === "lost-before") f.ledger.lose(loss);
    else if (end === "wrong-source" || end === "navigation")
      f.ledger.documentClosed("safari-navigation-request");
    else if (end === "lost-after") {
      f.ledger.documentClosed("safari-target-destroyed");
      f.ledger.lose(loss);
    }
    const outcomes = await Promise.allSettled([retired, waiting, f.ledger.stop()]);
    if (end === "lost-after") expect(outcomes[0]?.status).toBe("fulfilled");
    else expect(outcomes[0]?.status).toBe("rejected");
    if (end === "stop-empty") {
      expect(outcomes[1]?.status).toBe("fulfilled");
      expect(outcomes[2]?.status).toBe("fulfilled");
      await expect(retired).rejects.toThrow("stopped before document retirement");
    } else expect(outcomes[2]?.status).toBe("rejected");
    if (end.startsWith("lost-")) expect(outcomes[1]).toEqual({ status: "rejected", reason: loss });
    if (end === "navigation") await expect(retired).rejects.toThrow("not requested");
    if (end === "wrong-source") await expect(retired).rejects.toThrow("Navigation cannot retire");
    if (end === "stop-live" || end === "navigation")
      await expect(f.ledger.stop()).rejects.toThrow("Missing final browser Worker close");
    expect(await f.consumers.join(100)).toBe(true);
  });

for (const brokenClone of [false, true])
  test(`authoritative retirement survives trace overflow and clone failure=${brokenClone}`, async () => {
    let cleaned = false;
    const f = fixture(async () => {
      cleaned = true;
    });
    const clone = brokenClone
      ? spyOn(globalThis, "structuredClone").mockImplementation(() => {
          throw Error("diagnostic clone failed");
        })
      : undefined;
    try {
      for (let index = 2; index <= 70; index++)
        f.ledger.created(String(index), `https://owned.test/${index}.js`);
      const workers = f.ledger.workers();
      const waits = workers.map((worker) => f.ledger.waitForWorkerClose(worker));
      let settled = 0;
      for (const wait of waits)
        void wait.then(
          () => {
            settled++;
          },
          () => {
            settled++;
          },
        );
      const proof = await retire(f.ledger);
      expect(proof.outstandingCount).toBe(70);
      expect(proof.outstandingWorkers).toHaveLength(64);
      expect(settled).toBe(0);
      f.ledger.terminated("one", "safari-worker-terminated");
      await waits[0];
      await f.ledger.stop();
      const outcomes = await Promise.allSettled(waits);
      expect(outcomes.filter((entry) => entry.status === "rejected")).toHaveLength(69);
      expect(f.events.filter((event) => event === "closed")).toHaveLength(1);
      expect(cleaned).toBe(true);
      expect(await f.consumers.join(100)).toBe(true);
    } finally {
      clone?.mockRestore();
      await f.ledger.stop();
    }
    const diagnostic = f.ledger.diagnosticSnapshot().workers;
    expect(brokenClone ? diagnostic.unavailable : diagnostic.truncated).toBeGreaterThan(0);
  });

test("ignored exact, retirement and immediate invalid waits have owned rejection observation", async () => {
  const moduleURL = new URL("./browser-observation.ts", import.meta.url).href;
  const consumersURL = new URL("./owned-consumers.ts", import.meta.url).href;
  const script = `
    import { BrowserObservation } from ${JSON.stringify(moduleURL)};
    import { HostConsumers } from ${JSON.stringify(consumersURL)};
    const consumers = new HostConsumers();
    const ledger = new BrowserObservation('owned', consumers, async () => {});
    ledger.documentRetirement();
    ledger.created('unrequested', 'https://owned.test/unrequested.js');
    ledger.created('ignored', 'https://owned.test/ignored.js');
    ledger.waitForWorkerClose(ledger.workers()[1]);
    ledger.beginDocumentClose();
    ledger.documentRetirement();
    await ledger.stop().catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    if (!await consumers.join(100)) throw Error('unjoined consumers');
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
  } finally {
    child.kill();
    await child.exited;
  }
});

for (const reason of [undefined, null, false, 0, ""])
  test(`retired document keeps falsy callback and cleanup aggregate order: ${String(reason)}`, async () => {
    const callback = Promise.withResolvers<void>();
    const cleanup = Error("retired transport cleanup failed");
    let cleaned = false;
    const f = fixture(async () => {
      cleaned = true;
      throw cleanup;
    });
    f.ledger.onWorker(() => callback.promise);
    await retire(f.ledger);
    const stopped = f.ledger.stop();
    try {
      expect(cleaned).toBe(false);
      callback.reject(reason);
      const [result] = await Promise.allSettled([stopped]);
      if (result?.status !== "rejected" || !(result.reason instanceof AggregateError))
        throw Error("Missing retired callback and cleanup aggregate");
      expect(result.reason.errors).toEqual([reason, cleanup]);
      expect(cleaned).toBe(true);
      expect(await f.consumers.join(100)).toBe(true);
    } finally {
      callback.resolve();
      await stopped.catch(() => {});
    }
  });

test("an unconfirmed receipt alone does not hide retired transport cleanup failure", async () => {
  const cleanup = Error("retired detach failed");
  const f = fixture(async () => {
    throw cleanup;
  });
  await retire(f.ledger);
  await expect(f.ledger.stop()).rejects.toBe(cleanup);
  expect(await f.consumers.join(100)).toBe(true);
});
