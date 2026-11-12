import { expect, test, spyOn } from "bun:test";
import {
  BoundedTrace,
  StallDiagnostics,
  bindDiagnostics,
  evaluationOperation,
  evaluationMode,
} from "./stall-diagnostics.js";
import { crossTabEvaluator } from "./cross-tab-evaluator.js";
import { encodeCrossTabValue } from "./cross-tab-value.js";
import { installPublicationCloseBridge } from "./publication-bootstrap.js";
import { nativeCrossTabLifecycle } from "./publication-cross-tab-host.js";
import type { HostCase, HostPeer } from "./protocol.js";

function globals(values: Record<string, unknown>) {
  const previous = Object.keys(values).map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  }));
  for (const [key, value] of Object.entries(values)) Reflect.set(globalThis, key, value);
  return () => {
    for (const { key, descriptor } of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

test("concurrent evaluator metadata retains held, completed and failed jobs through actual shutdown", async () => {
  const evaluator = crossTabEvaluator();
  const release = Promise.withResolvers<number>();
  const restore = globals({ __diagnosticHold: release.promise });
  evaluator.submit({
    id: "private-id",
    job: 1,
    operation: "guestDeath",
    mode: "proc",
    source: "return globalThis.__diagnosticHold",
    value: encodeCrossTabValue(undefined),
  });
  const running = evaluator.run();
  try {
    evaluator.submit({
      id: "complete",
      job: 2,
      source: "return 9",
      value: encodeCrossTabValue(undefined),
    });
    evaluator.submit({
      id: "fail",
      job: 3,
      source: "throw Error('private-body')",
      value: encodeCrossTabValue(undefined),
    });
    await Bun.sleep(0);
    expect(evaluator.take("complete")?.status).toBe("pass");
    expect(evaluator.take("fail")?.status).toBe("fail");
    expect(evaluator.take("complete")).toBeNull();
    evaluator.stop();
    let joined = false;
    void running.then(() => {
      joined = true;
    });
    await Bun.sleep(0);
    expect(joined).toBe(false);
    const snapshot = evaluator.diagnostics();
    expect(snapshot.active[0]?.facts).toMatchObject({
      job: 1,
      operation: "guestDeath",
      mode: "proc",
    });
    expect(snapshot.active[0]?.stages.map((item) => item.stage)).toEqual(["queued", "started"]);
    expect(snapshot.completed.map((item) => item.stages.at(-1)?.stage)).toEqual([
      "answer-consumed",
      "answer-consumed",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-id|private-body|__diagnosticHold|return 9/,
    );
    release.resolve(7);
    await running;
    expect(evaluator.take("private-id")?.status).toBe("pass");
    expect(evaluator.state()).toEqual({ accepting: false, queued: 0, pending: 0, unread: 0 });
  } finally {
    release.resolve(7);
    evaluator.stop();
    await running;
    restore();
  }
});

test("bridge invocation, response arrival and page acknowledgement stay distinct and concurrent correlation stays ambiguous", async () => {
  const evaluator = crossTabEvaluator();
  const held = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const bridgeState: { __crossTabBridgeTrace?: BoundedTrace } = {};
  const page = {
    ...bridgeState,
    __suiteConfiguration: { run: "private-run", token: "private-token" },
    __pageRunner: { doc: "private-doc" },
    __crossTabEvaluator: evaluator,
  };
  const restore = globals({
    window: page,
    location: { href: "https://private.test/?token=private-token" },
    __diagnosticHold: held.promise,
    __publicationWaitForClose: undefined,
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => response.promise, { preconnect: globalThis.fetch.preconnect }),
  );
  let bridge: Promise<unknown> | undefined;
  evaluator.submit({
    id: "one",
    job: 1,
    source: "return globalThis.__diagnosticHold",
    value: encodeCrossTabValue(undefined),
  });
  evaluator.submit({
    id: "two",
    job: 2,
    source: "return globalThis.__diagnosticHold",
    value: encodeCrossTabValue(undefined),
  });
  const running = evaluator.run();
  try {
    installPublicationCloseBridge();
    const close: unknown = Reflect.get(globalThis, "__publicationWaitForClose");
    if (typeof close !== "function") throw Error("Missing bridge");
    bridge = close("https://private.test/resident-guest.js?token=private-token");
    const entry = page.__crossTabBridgeTrace?.snapshot().active[0];
    expect(entry?.facts).toEqual({
      fixture: "/resident-guest.js",
      activeJobs: [1, 2],
      activeJobCount: 2,
      ambiguous: true,
    });
    expect(entry?.stages.map((item) => item.stage)).toEqual(["bridge-invoked"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve(Response.json({ closed: true }));
    await bridge;
    const completed = page.__crossTabBridgeTrace?.snapshot().completed[0];
    expect(completed?.stages.map((item) => item.stage)).toEqual([
      "bridge-invoked",
      "response-arrived",
      "page-acknowledged",
    ]);
    expect(JSON.stringify(completed)).not.toMatch(/private|terminate/);
    fetch.mockImplementation(
      Object.assign(async () => Response.json({ error: "private-error" }, { status: 409 }), {
        preconnect: globalThis.fetch.preconnect,
      }),
    );
    await expect(close("https://private.test/resident-guest.js")).rejects.toThrow();
    const failed = page.__crossTabBridgeTrace?.snapshot().completed.at(-1);
    expect(failed?.stages.map((item) => item.stage)).toEqual([
      "bridge-invoked",
      "response-arrived",
      "failed",
    ]);
    expect(JSON.stringify(failed)).not.toContain("private-error");
  } finally {
    response.resolve(Response.json({ closed: true }));
    await bridge?.catch(() => {});
    held.resolve();
    evaluator.stop();
    await running;
    fetch.mockRestore();
    restore();
  }
});

test("diagnostic overflow is capped, sanitized and independent of evaluator results", async () => {
  const evaluator = crossTabEvaluator();
  const diagnostics = new StallDiagnostics();
  const restore = globals({ window: { __crossTabBridgeTrace: undefined } });
  try {
    for (let job = 0; job < 200; job++)
      evaluator.submit({
        id: `private-${job}`,
        job,
        source: "return 5",
        value: encodeCrossTabValue(undefined),
      });
    evaluator.stop();
    await evaluator.run();
    for (let job = 0; job < 200; job++)
      expect(evaluator.take(`private-${job}`)?.status).toBe("pass");
    const evidence = evaluator.reply(null).diagnostics;
    expect(evidence.truncated).toBeGreaterThan(0);
    expect(evidence.entries.length).toBeLessThanOrEqual(96);
    for (let peer = 0; peer < 30; peer++)
      diagnostics.page(peer, { ...evidence, token: "private-token", script: "private-script" });
    const snapshot = diagnostics.snapshot().current;
    expect(JSON.stringify(snapshot.evaluations).length).toBeLessThanOrEqual(65536);
    expect(snapshot.truncated).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|return 5|token|script/);
    expect(evaluator.state().unread).toBe(0);
    expect(evaluationOperation({ operation: "private-op" })).toBe("other-evaluation");
    expect(evaluationMode({ value: { mode: "private-mode" } })).toBeNull();
  } finally {
    restore();
  }
});

async function nativeAdapterControl(pageFailure = false): Promise<void> {
  const evaluator = crossTabEvaluator();
  const diagnostics = new StallDiagnostics();
  const restore = globals({ window: { __crossTabEvaluator: evaluator } });
  const purposes: unknown[] = [];
  const unused = async () => {
    throw Error("Unexpected control");
  };
  const peer: HostPeer = {
    signal: new AbortController().signal,
    workers: async () => [],
    onWorker: () => async () => {},
    waitForWorkerClose: unused,
    script: async (source, purpose) => {
      purposes.push(purpose);
      return new Function("window", source)(window);
    },
    task: () => evaluator.run(),
    reload: unused,
    close: async () => {},
  };
  const host: HostCase = {
    ...peer,
    openPeer: async () => peer,
    onRequest: () => async () => {},
    holdAsset() {},
    press: unused,
    remainingMs: () => 1000,
    setTimeout() {},
    allocateDatabase: unused,
    sleep: (ms) => Bun.sleep(ms),
  };
  bindDiagnostics(peer, diagnostics, 2, 3);
  bindDiagnostics(host, diagnostics, 0, 0);
  const ingestion = pageFailure
    ? spyOn(diagnostics, "page").mockImplementation(() => {
        throw Error("DIAGNOSTIC_INGESTION_FAILURE");
      })
    : undefined;
  const lifecycle = nativeCrossTabLifecycle(host, []);
  const browser = await lifecycle.launch("ios-safari");
  const page = await (await browser.newContext()).newPage();
  try {
    expect(await page.evaluate(() => 9)).toBe(9);
    await page.close();
    expect(purposes).toEqual([
      "evaluator-submit",
      "evaluator-take",
      "evaluator-stop",
      "evaluator-state",
    ]);
    expect(diagnostics.snapshot().current.evaluations.owner.completed[0]?.facts).toMatchObject({
      peer: 2,
      generation: 3,
      job: 1,
      polls: 1,
    });
    if (pageFailure) expect(diagnostics.snapshot().current.unavailable).toBe(4);
  } finally {
    ingestion?.mockRestore();
    evaluator.stop();
    await lifecycle.closeBrowser(browser);
    restore();
  }
}
test("the native adapter keeps submit, take, stop and state transport counts unchanged", () =>
  nativeAdapterControl());
test("owner diagnostic ingestion failure preserves answers and transport counts", () =>
  nativeAdapterControl(true));

test("diagnostic collection and snapshots remain bounded when clone fails", () => {
  const diagnostics = new StallDiagnostics();
  diagnostics.observe(1, () => {
    throw Error("DIAGNOSTIC_OBSERVER_FAILURE");
  });
  const clone = spyOn(globalThis, "structuredClone").mockImplementation(() => {
    throw Error("DIAGNOSTIC_CLONE_FAILURE");
  });
  try {
    const ordinal = diagnostics.evaluations.begin("queued", { job: 1 });
    diagnostics.evaluations.mark(ordinal, "started");
    diagnostics.evaluations.end(ordinal, "completed");
    diagnostics.freeze("evaluation-failure");
    diagnostics.cleanup();
    const value = diagnostics.snapshot();
    expect(value.current.unavailable).toBeGreaterThan(0);
    expect(diagnostics.context).toBe("cleanup");
    expect(JSON.stringify(value).length).toBeLessThan(65536);
  } finally {
    clone.mockRestore();
  }
});

async function replyFailure(
  kind: "snapshot" | "serialization",
  bodyFailure = false,
): Promise<void> {
  const evaluator = crossTabEvaluator();
  const bridge = new BoundedTrace("page-monotonic-ms");
  const restore = globals({ window: { __crossTabBridgeTrace: bridge } });
  evaluator.submit({
    id: "one",
    job: 1,
    source: bodyFailure ? "throw Error('original-body')" : "return 19",
    value: encodeCrossTabValue(undefined),
  });
  evaluator.stop();
  await evaluator.run();
  const failure =
    kind === "snapshot"
      ? spyOn(bridge, "snapshot").mockImplementation(() => {
          throw Error("DIAGNOSTIC_SNAPSHOT_FAILURE");
        })
      : spyOn(JSON, "stringify").mockImplementationOnce(() => {
          throw Error("DIAGNOSTIC_SERIALIZATION_FAILURE");
        });
  try {
    const result = evaluator.reply(evaluator.take("one"));
    expect(result.answer).toEqual(
      bodyFailure
        ? { status: "fail", error: "Error: original-body" }
        : { status: "pass", value: encodeCrossTabValue(19) },
    );
    expect(result.diagnostics.unavailable).toBe(1);
    expect(result.diagnostics.entries).toEqual([]);
    expect(result.diagnostics.state.unread).toBe(0);
    expect(evaluator.take("one")).toBeNull();
    expect(Object.keys(result).sort()).toEqual(["answer", "diagnostics"]);
  } finally {
    failure.mockRestore();
    restore();
  }
}
test("diagnostic snapshot failure preserves a consumed successful answer in the same envelope", () =>
  replyFailure("snapshot"));
test("diagnostic serialization failure preserves a consumed successful answer in the same envelope", () =>
  replyFailure("serialization"));
test("diagnostic snapshot failure retains the original failed evaluation", () =>
  replyFailure("snapshot", true));
test("diagnostic serialization failure retains the original failed evaluation", () =>
  replyFailure("serialization", true));

test("throwing page metadata and observer snapshots leave bounded unavailable evidence", () => {
  const diagnostics = new StallDiagnostics();
  diagnostics.page(1, {
    get clock() {
      throw Error("DIAGNOSTIC_PAGE_FAILURE");
    },
  });
  diagnostics.observe(1, () => {
    throw Error("DIAGNOSTIC_OBSERVER_FAILURE");
  });
  const stringify = spyOn(JSON, "stringify").mockImplementationOnce(() => {
    throw Error("DIAGNOSTIC_PROJECTION_FAILURE");
  });
  try {
    expect(diagnostics.current().unavailable).toBeGreaterThan(0);
  } finally {
    stringify.mockRestore();
  }
  diagnostics.freeze("host-body-failure");
  expect(diagnostics.snapshot().firstFailure).toMatchObject({ reason: "host-body-failure" });
  expect(diagnostics.snapshot().current.observers).toEqual([
    { peer: 1, evidence: { unavailable: true } },
  ]);
});
