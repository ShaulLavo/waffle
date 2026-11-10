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
  expect(ledger.created(a.id)).toBe(true);
  expect(ledger.created(b.id)).toBe(true);
  expect(ledger.created(a.id)).toBe(false);
  const first = ledger.workers();
  expect(first[0]).not.toBe(first[1]);
  expect(ledger.workers()[0]).toBe(first[0]);
  ledger.terminated("a");
  expect(ledger.workers()).toHaveLength(1);
  expect(ledger.workers()[0]).toBe(first[1]);
  ledger.terminated("b");
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
  ledger.created("first");
  expect(() => ledger.created("second")).toThrow("bound");
  expect(() => ledger.terminated("missing")).toThrow("unobserved");
  ledger.requested(request());
  expect(() => ledger.requested(request())).toThrow("bound");
});
