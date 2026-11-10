import { expect, test } from "bun:test";
import { BrowserObservation, requestEvent, workerEvent } from "./browser-observation.js";
import { HostConsumers } from "./owned-consumers.js";

const request = (url = "https://owned.test/python.wasm", sequence = 1, extras = {}) =>
  requestEvent(
    "Network.requestWillBeSent",
    {
      requestId: "request-1",
      frameId: "frame",
      loaderId: "loader",
      timestamp: 12,
      request: { url, method: "GET", headers: { Accept: "*/*" } },
      documentURL: "https://owned.test/",
      ...extras,
    },
    sequence,
  );

test("engine IDs preserve distinct same-URL workers and repeated stable references", () => {
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {});
  const sameURL = "https://owned.test/worker.js";
  const a = workerEvent({ workerId: "a", url: sameURL }),
    b = workerEvent({ workerId: "b", url: sameURL });
  expect(ledger.created(a.id, a.url)).toBe(true);
  expect(ledger.created(b.id, b.url)).toBe(true);
  expect(ledger.created(a.id, a.url)).toBe(false);
  const first = ledger.workers();
  expect(first[0]).not.toBe(first[1]);
  expect(ledger.workers()[0]).toBe(first[0]);
  ledger.terminated("a", "playwright-worker-close");
  expect(ledger.workers()).toHaveLength(1);
  expect(ledger.workers()[0]).toBe(first[1]);
  ledger.terminated("b", "playwright-worker-close");
  expect(ledger.workers()).toEqual([]);
  ledger.lose(new Error("target lost"));
  expect(() => ledger.workers()).toThrow("target lost");
});

test("ordered request replay keeps duplicates, redirect hops and complete metadata", async () => {
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {});
  ledger.requested(request());
  ledger.requested(
    request("https://owned.test/python.wasm", 2, {
      redirectResponse: { status: 302, url: "https://owned.test/from" },
    }),
  );
  const urls: string[] = [];
  const stop = ledger.onRequest((url) => {
    urls.push(url);
  });
  ledger.requested(request("https://owned.test/last", 3));
  expect(urls).toEqual([
    "https://owned.test/python.wasm",
    "https://owned.test/python.wasm",
    "https://owned.test/last",
  ]);
  expect(ledger.evidence()[1]?.details.redirectResponse).toEqual({
    status: 302,
    url: "https://owned.test/from",
  });
  await stop();
  ledger.requested(request("https://owned.test/after", 4));
  expect(urls).toHaveLength(3);
  await ledger.stop();
});

test("callback failure loses observation instead of manufacturing empty inventory", async () => {
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {});
  ledger.onRequest(() => {
    throw new Error("callback failed");
  });
  ledger.requested(request());
  await Promise.resolve();
  await Promise.resolve();
  expect(() => ledger.workers()).toThrow("callback failed");
  await expect(ledger.stop()).rejects.toThrow("callback failed");
});

test("abort revokes delivery but drain still owns an actually pending callback", async () => {
  const consumers = new HostConsumers();
  const ledger = new BrowserObservation("target", consumers, async () => {});
  const callback = Promise.withResolvers<void>();
  ledger.onRequest(() => callback.promise);
  ledger.requested(request());
  ledger.revoke();
  const drain = ledger.stop();
  expect(ledger.stop()).toBe(drain);
  expect(() => ledger.onRequest(() => {})).toThrow("revoked");
  expect(await consumers.join(1)).toBe(false);
  callback.resolve();
  await drain;
  expect(await consumers.join(100)).toBe(true);
});

test("malformed payloads, missing identities and local buffer overflow fail closed", () => {
  expect(() => workerEvent({ workerId: "x" })).toThrow();
  expect(() =>
    requestEvent("Network.requestWillBeSent", { request: { url: "/relative" } }, 1),
  ).toThrow();
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {}, {
    workers: 1,
    requests: 1,
    bytes: 4096,
  });
  ledger.created("first", "https://owned.test/worker.js");
  expect(() => ledger.created("second", "https://owned.test/worker.js")).toThrow("bound");
  expect(() => ledger.terminated("missing", "playwright-worker-close")).toThrow("unobserved");
  ledger.requested(request());
  expect(() => ledger.requested(request())).toThrow("bound");
});

test("revocation stops public delivery but receive reduction remains live until detach", async () => {
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {});
  const urls: string[] = [];
  ledger.onRequest((url) => {
    urls.push(url);
  });
  ledger.created("first", "https://owned.test/worker.js");
  ledger.revoke();
  ledger.requested(request());
  ledger.terminated("first", "playwright-worker-close");
  expect(urls).toEqual([]);
  expect(() => ledger.workers()).toThrow("revoked");
  await ledger.stop();
});

test("memory-cache notifications retain their distinct original payload and ordered URL delivery", async () => {
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {});
  const event = requestEvent(
    "Network.requestServedFromMemoryCache",
    {
      requestId: "cached",
      frameId: "main",
      loaderId: "original",
      timestamp: 2,
      documentURL: "https://owned.test/",
      initiator: { type: "script" },
      resource: { url: "https://owned.test/cached", type: "Script", bodySize: 123 },
    },
    3,
  );
  ledger.requested(event);
  const urls: string[] = [];
  ledger.onRequest((url) => {
    urls.push(url);
  });
  expect(urls).toEqual(["https://owned.test/cached"]);
  expect(ledger.evidence()[0]?.kind).toBe("memory-cache");
  expect(ledger.evidence()[0]?.details.resource).toEqual({
    url: "https://owned.test/cached",
    type: "Script",
    bodySize: 123,
  });
  await ledger.stop();
});

test("ignored unsubscribe wait cannot detach callback debt from the document owner", async () => {
  const consumers = new HostConsumers();
  const ledger = new BrowserObservation("target", consumers, async () => {});
  const callback = Promise.withResolvers<void>();
  const unsubscribe = ledger.onRequest(() => callback.promise);
  ledger.requested(request());
  const removed = unsubscribe();
  expect(unsubscribe()).toBe(removed);
  const stopped = ledger.stop();
  let settled = false;
  void stopped.then(() => {
    settled = true;
  });
  expect(await consumers.join(1)).toBe(false);
  expect(settled).toBe(false);
  callback.resolve();
  await stopped;
  await removed;
  expect(await consumers.join(100)).toBe(true);
});

test("unsubscribe retains an earlier callback failure and waits for later pending callbacks", async () => {
  const consumers = new HostConsumers();
  let cleaned = false;
  const ledger = new BrowserObservation("target", consumers, async () => {
    cleaned = true;
  });
  const pending = Promise.withResolvers<void>();
  let count = 0;
  const unsubscribe = ledger.onRequest(() => {
    if (++count === 1) throw new Error("earlier callback rejection");
    return pending.promise;
  });
  ledger.requested(request());
  ledger.requested(request("https://owned.test/second", 2));
  await ledger.failure;
  const removed = unsubscribe();
  let drained = false;
  void removed.then(
    () => {
      drained = true;
    },
    () => {
      drained = true;
    },
  );
  const stopped = ledger.stop();
  void stopped.catch(() => {});
  expect(await consumers.join(1)).toBe(false);
  expect(drained).toBe(false);
  expect(cleaned).toBe(false);
  pending.resolve();
  await expect(removed).rejects.toThrow("earlier callback rejection");
  await expect(stopped).rejects.toThrow("earlier callback rejection");
  expect(cleaned).toBe(true);
  expect(await consumers.join(100)).toBe(true);
});

test("unsubscribe after a settled callback rejection does not report success", async () => {
  const ledger = new BrowserObservation("target", new HostConsumers(), async () => {});
  const unsubscribe = ledger.onRequest(() => {
    throw new Error("settled failure");
  });
  ledger.requested(request());
  await ledger.failure;
  await expect(unsubscribe()).rejects.toThrow("settled failure");
  await expect(ledger.stop()).rejects.toThrow("settled failure");
});

test("lifecycle replay is ordered across reentry and latest URL lookup retains closed history", async () => {
  const consumers = new HostConsumers();
  const ledger = new BrowserObservation("document-1", consumers, async () => {});
  const url = "https://owned.test/same.js";
  ledger.created("first", url);
  const first = ledger.workers()[0]!;
  ledger.terminated("first", "safari-worker-terminated");
  const events: string[] = [];
  const remove = ledger.onWorker((event) => {
    events.push(`${event.kind}:${event.worker === first ? "first" : "second"}`);
    if (events.length === 1) ledger.created("second", url);
  });
  expect(events).toEqual(["created:first", "closed:first", "created:second"]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(first.url).toBe(url);
  await ledger.waitForWorkerClose(first);
  let closed = false;
  const waiting = ledger.waitForWorkerURLClose(url).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  ledger.terminated("second", "safari-worker-terminated");
  await waiting;
  expect(events).toEqual(["created:first", "closed:first", "created:second", "closed:second"]);
  await expect(ledger.waitForWorkerURLClose("https://owned.test/missing.js")).rejects.toThrow(
    "not observed",
  );
  expect(() => ledger.created("first", url)).toThrow("reused");
  expect(() => ledger.created("other", "relative")).toThrow();
  await remove();
  await ledger.stop();
  expect(await consumers.join(100)).toBe(true);
});

test("generation ownership rejects foreign objects and cannot close a same-URL successor or claimant", async () => {
  const consumers = new HostConsumers();
  const old = new BrowserObservation("generation-1", consumers, async () => {});
  const next = new BrowserObservation("generation-2", consumers, async () => {});
  const claimant = new BrowserObservation("claimant", consumers, async () => {});
  for (const owner of [old, next, claimant])
    owner.created("reused-across-generations", "https://owned.test/same.js");
  const worker = old.workers()[0]!;
  await expect(next.waitForWorkerClose(worker)).rejects.toThrow("another document");
  let closed = 0;
  next.onWorker((event) => {
    if (event.kind === "closed") closed++;
  });
  claimant.onWorker((event) => {
    if (event.kind === "closed") closed++;
  });
  old.beginDocumentClose();
  old.documentClosed();
  old.terminated("reused-across-generations", "safari-worker-terminated");
  await old.waitForWorkerClose(worker);
  expect(closed).toBe(0);
  expect(next.workers()).toHaveLength(1);
  expect(claimant.workers()).toHaveLength(1);
  await Promise.all([old.stop(), next.stop(), claimant.stop()]);
  expect(await consumers.join(100)).toBe(true);
});

for (const reason of [undefined, null, false, 0, ""]) {
  test(`Worker callback retains falsy rejection ${String(reason)} and later ignored-removal debt`, async () => {
    const consumers = new HostConsumers();
    let cleaned = false;
    const ledger = new BrowserObservation("owned", consumers, async () => {
      cleaned = true;
    });
    const pending = Promise.withResolvers<void>();
    let calls = 0;
    const remove = ledger.onWorker(() =>
      ++calls === 1 ? Promise.reject(reason) : pending.promise,
    );
    ledger.created("one", "https://owned.test/one.js");
    ledger.created("two", "https://owned.test/two.js");
    await ledger.failure;
    const removed = remove();
    expect(remove()).toBe(removed);
    const stopped = ledger.stop();
    void stopped.catch(() => {});
    expect(await consumers.join(1)).toBe(false);
    expect(cleaned).toBe(false);
    pending.resolve();
    const outcomes = await Promise.allSettled([removed, stopped]);
    expect(outcomes).toEqual([
      { status: "rejected", reason },
      { status: "rejected", reason },
    ]);
    expect(cleaned).toBe(true);
    expect(await consumers.join(100)).toBe(true);
  });
}

test("intentional close keeps admitted callbacks live but missing final close fails", async () => {
  const ledger = new BrowserObservation("owned", new HostConsumers(), async () => {});
  const events: string[] = [];
  ledger.onWorker((event) => {
    events.push(event.kind);
  });
  ledger.created("one", "https://owned.test/one.js");
  const worker = ledger.workers()[0]!;
  const closed = ledger.waitForWorkerClose(worker);
  ledger.beginDocumentClose();
  expect(() => ledger.workers()).toThrow("revoked");
  expect(() => ledger.onWorker(() => {})).toThrow("revoked");
  ledger.documentClosed();
  expect(events).toEqual(["created"]);
  ledger.terminated("one", "safari-worker-terminated");
  await closed;
  expect(events).toEqual(["created", "closed"]);
  await ledger.stop();
  const missing = new BrowserObservation("missing", new HostConsumers(), async () => {});
  missing.created("one", "https://owned.test/one.js");
  const waiting = missing.waitForWorkerClose(missing.workers()[0]!);
  missing.beginDocumentClose();
  missing.documentClosed();
  const outcomes = await Promise.allSettled([missing.stop(), waiting]);
  expect(outcomes.every((result) => result.status === "rejected")).toBe(true);
});

test("callback and teardown failures are both retained, including a falsy primary", async () => {
  const cleanup = new Error("detach failed");
  const ledger = new BrowserObservation("owned", new HostConsumers(), () => {
    throw cleanup;
  });
  ledger.onWorker(() => {
    throw false;
  });
  ledger.created("one", "https://owned.test/worker.js");
  await ledger.failure;
  const [result] = await Promise.allSettled([ledger.stop()]);
  expect(result?.status).toBe("rejected");
  if (result?.status !== "rejected" || !(result.reason instanceof AggregateError))
    throw new Error("Missing combined failure");
  expect(result.reason.errors).toEqual([false, cleanup]);
});

test("action-only revocation preserves lifecycle subscriptions and close queries through teardown", async () => {
  const ledger = new BrowserObservation("owned", new HostConsumers(), async () => {});
  const events: string[] = [];
  ledger.onWorker((event) => {
    events.push(event.kind);
  });
  ledger.onRequest(() => {
    throw new Error("request admission must be revoked");
  });
  ledger.created("one", "https://owned.test/one.js");
  const worker = ledger.workers()[0]!;
  ledger.revokeActions();
  ledger.requested(request());
  const waiting = ledger.waitForWorkerClose(worker);
  ledger.terminated("one", "safari-worker-terminated");
  await waiting;
  expect(events).toEqual(["created", "closed"]);
  await ledger.stop();
});
