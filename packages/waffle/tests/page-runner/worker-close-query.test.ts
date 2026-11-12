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
    const diagnostic = f.collector.diagnostics.snapshot().current;
    expect(diagnostic.queries.completed.at(-1)?.stages.map((item) => item.stage)).toEqual([
      "query-admitted",
      "wait-resolved",
      "response-created",
    ]);
    expect(
      diagnostic.queries.completed.some(
        (entry) => entry.stages.at(-1)?.stage === "response-failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toMatch(/owned.test|token|documentURL|worker.js/);
    f.state.physical = "closed";
    expect((await query(f.query)).status).toBe(410);
    expect(f.collector.failures).toEqual([]);
  } finally {
    await f.observation.stop();
    expect(await f.consumers.join(100)).toBe(true);
    await server.server.stop(true);
  }
});

for (const end of ["before-query", "after-query", "physical-close", "lost", "retired"] as const)
  test(`exact close diagnostic progression survives ${end} without a fabricated receipt`, async () => {
    const f = fixture();
    f.observation.initialized("worker", true);
    if (end === "before-query") f.observation.terminated("worker", "safari-worker-terminated");
    const waiting = f.collector.workerCloseQuery({ ...f.query, query: 7 });
    try {
      const entry = f.collector.diagnostics.snapshot().current.queries.active[0];
      expect(entry?.facts).toMatchObject({
        peer: 0,
        generation: 0,
        worker: 1,
        query: 7,
        fixture: "other-worker",
      });
      if (end === "physical-close") {
        f.observation.beginDocumentClose();
        f.observation.documentClosed();
        let settled = false;
        void waiting.then(() => {
          settled = true;
        });
        await Bun.sleep(0);
        expect(settled).toBe(false);
      }
      if (end === "lost") f.observation.lose(Error("private-observer-error"));
      else if (end === "retired") await f.observation.stop();
      else if (end !== "before-query")
        f.observation.terminated("worker", "safari-worker-terminated");
      if (end === "lost" || end === "retired") await expect(waiting).rejects.toThrow();
      else await waiting;
      const snapshot = f.collector.diagnostics.snapshot().current;
      expect(snapshot.queries.active[0]?.stages.at(-1)?.stage).toBe(
        end === "lost" || end === "retired" ? "wait-rejected" : "wait-resolved",
      );
      const native = f.observation.diagnosticSnapshot().workers;
      const receipt = native.completed.find((item) => item.facts.worker === 1);
      if (end === "lost" || end === "retired") expect(receipt).toBeUndefined();
      else
        expect(receipt?.stages.map((item) => item.stage)).toEqual([
          "native-created",
          "initialization-acknowledged",
          "safari-worker-terminated",
        ]);
      expect(JSON.stringify(snapshot)).not.toMatch(
        /owned.test|private-observer-error|documentURL|token/,
      );
    } finally {
      await f.observation.stop().catch(() => {});
      await waiting.catch(() => {});
      expect(await f.consumers.join(100)).toBe(true);
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
