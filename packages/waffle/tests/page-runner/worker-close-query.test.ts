import { expect, test } from "bun:test";
import { BrowserObservation } from "./browser-observation.js";
import { Collector } from "./collector.js";
import { HostConsumers } from "./owned-consumers.js";
import { serveCollector } from "./suite-host.js";

function fixture() {
  const consumers = new HostConsumers();
  const collector = new Collector("run", ["case"], ["case"], {
    listIds: () => ["case"],
    check() {},
  });
  const state = collector.expect(
    { id: "case", role: "case", caseIds: ["case"], execution: "host" },
    "token",
    "http://owned.test/?token=token",
    "window",
  );
  collector.receive({
    run: "run",
    doc: "document",
    seq: 0,
    kind: "hello",
    token: "token",
    group: "case",
  });
  collector.receive({ run: "run", doc: "document", seq: 1, kind: "case-ready", caseId: "case" });
  collector.beginHost(state, "case");
  const observation = new BrowserObservation("owned", consumers, async () => {});
  collector.bindObservation(state, observation, consumers, () => performance.now() + 1000);
  observation.created("worker", "http://owned.test/worker.js");
  const query = {
    run: "run",
    token: "token",
    doc: "document",
    documentURL: state.expectedURL,
    url: "http://owned.test/worker.js",
  };
  return { collector, state, observation, consumers, query };
}

test("the real collector close route waits outside driver serialization and authenticates its document", async () => {
  const f = fixture();
  const server = serveCollector(f.collector, {}, undefined, 0, undefined, f.consumers);
  const query = (body: unknown) =>
    fetch(`${server.origin}/_waffle_worker_close`, { method: "POST", body: JSON.stringify(body) });
  try {
    for (const bad of [
      { token: "wrong" },
      { doc: "old-generation" },
      { run: "other" },
      { documentURL: "http://other.test/" },
    ])
      expect((await query({ ...f.query, ...bad })).status).toBe(410);
    expect((await query({ ...f.query, url: "http://owned.test/missing.js" })).status).toBe(409);
    let settled = false;
    const answer = query(f.query).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    f.observation.terminated("worker", "safari-worker-terminated");
    const response = await answer;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true });
    expect((await query(f.query)).status).toBe(200);
    f.state.physical = "closed";
    expect((await query(f.query)).status).toBe(410);
    expect(f.collector.failures).toEqual([]);
  } finally {
    await f.observation.stop();
    expect(await f.consumers.join(100)).toBe(true);
    await server.server.stop(true);
  }
});

test("query cancellation cannot discharge actual close debt and observation loss rejects pending queries", async () => {
  const f = fixture();
  const server = serveCollector(f.collector, {}, undefined, 0, undefined, f.consumers);
  const controller = new AbortController();
  try {
    const response = fetch(`${server.origin}/_waffle_worker_close`, {
      method: "POST",
      body: JSON.stringify(f.query),
      signal: controller.signal,
    });
    await Bun.sleep(10);
    controller.abort();
    await expect(response).rejects.toThrow();
    expect(await f.consumers.join(1)).toBe(false);
    f.observation.lose(new Error("observation stream lost"));
    await expect(f.observation.stop()).rejects.toThrow("stream lost");
    expect(await f.consumers.join(100)).toBe(true);
  } finally {
    await f.observation.stop().catch(() => {});
    await server.server.stop(true);
  }
});

test("retirement rejects an outstanding close query without fabricating close", async () => {
  const f = fixture();
  const query = f.collector.workerCloseQuery(f.query);
  await f.observation.stop();
  await expect(query).rejects.toThrow("retired");
  expect(await f.consumers.join(100)).toBe(true);
});

test("retirement closes new URL query admission before asynchronous cleanup finishes", async () => {
  const f = fixture();
  const cleanup = Promise.withResolvers<void>();
  const observation = new BrowserObservation("owned", f.consumers, () => cleanup.promise);
  observation.created("worker", f.query.url);
  const worker = observation.workers()[0]!;
  observation.terminated("worker", "safari-worker-terminated");
  const admitted = observation.waitForWorkerURLClose(f.query.url);
  const stopped = observation.stop();
  try {
    expect(() => observation.waitForWorkerURLClose(f.query.url)).toThrow("revoked");
    await admitted;
    await observation.waitForWorkerClose(worker);
    expect(await f.consumers.join(1)).toBe(false);
  } finally {
    cleanup.resolve();
    await stopped;
    await f.observation.stop();
    expect(await f.consumers.join(100)).toBe(true);
  }
});

test("a retired observation rejects a new authenticated close query for a closed Worker", async () => {
  const f = fixture();
  f.observation.terminated("worker", "playwright-worker-close");
  const server = serveCollector(f.collector, {}, undefined, 0, undefined, f.consumers);
  await f.observation.stop();
  try {
    const response = await fetch(`${server.origin}/_waffle_worker_close`, {
      method: "POST",
      body: JSON.stringify(f.query),
    });
    expect(response.status).toBe(410);
  } finally {
    expect(await f.consumers.join(100)).toBe(true);
    await server.server.stop(true);
  }
});
