import { expect, test } from "bun:test";
import {
  WebTransportLifecycle,
  type ManagedEndpoint,
} from "../src/webtransport-lifecycle.js";

function fixture(options: { holdGeneration?: boolean; holdReady?: boolean; operator?: boolean } = {}) {
  let wall = 100000;
  let mono = 0;
  let check = () => {};
  let generations = 0;
  let notifications = 0;
  const logs: Record<string, unknown>[] = [];
  const material = {
    cert: "fixture",
    key: "fixture",
    starts: wall,
    expires: wall + (options.operator ? 8 : 13) * 86400000,
    hash: { algorithm: "sha-256" as const, value: "fixture" },
  };
  const generation = Promise.withResolvers<typeof material>();
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let stops = 0;
  let fences = 0;
  let live = () => false;
  const endpoint: ManagedEndpoint = {
    ready: ready.promise,
    closed: closed.promise,
    start() {
      if (!options.holdReady) ready.resolve();
    },
    fence() { fences++; },
    async stop() {
      stops++;
      closed.resolve();
      await closed.promise;
    },
  };
  const owner = new WebTransportLifecycle({
    rotationMs: 1000,
    hashMode: !options.operator,
    certificate() {
      generations++;
      return options.holdGeneration ? generation.promise : Promise.resolve(material);
    },
    construct(_record, admission) { live = admission; return endpoint; },
    discovery: () => ({ url: "https://127.0.0.1:4433/v1/tcp/wt" }),
    onEndpointFailure() { notifications++; },
    log: (event) => logs.push(event),
  }, {
    wallNow: () => wall,
    monotonicNow: () => mono,
    scheduleCheck(callback) { check = callback; return () => { check = () => {}; }; },
    endpointStateChanged() {},
  });
  return {
    owner, generation, ready, closed, material, logs,
    live: () => live(),
    counts: () => ({ generations, notifications, stops, fences }),
    advanceMonotonic() { mono = 13000; },
    tick(days: number) { wall += days * 86400000; check(); },
  };
}

async function yieldCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("pending certificate generation remains failed cleanup debt with no endpoint", async () => {
  const run = fixture({ holdGeneration: true });
  try {
    run.advanceMonotonic();
    const closing = run.owner.close();
    const failure = await closing.then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(run.owner.close()).toBe(closing);
    await expect(run.owner.close()).rejects.toBe(failure);
    expect(run.owner.status()).toMatchObject({ state: "failed", ownedEndpoints: 0 });
    run.generation.resolve(run.material);
    await run.owner.ready.catch(() => {});
    await yieldCallbacks();
    expect(run.owner.discovery()).toBeNull();
    expect(run.counts()).toMatchObject({ generations: 1, stops: 0, notifications: 0 });
    await expect(run.owner.close()).rejects.toBe(failure);
  } finally {
    run.generation.resolve(run.material);
    await run.owner.ready.catch(() => {});
    await run.owner.close().catch(() => {});
  }
});

test("confirmed cancelled generation joins cleanly without publishing", async () => {
  const run = fixture({ holdGeneration: true });
  const closing = run.owner.close();
  run.generation.resolve(run.material);
  await closing;
  expect(run.owner.status()).toMatchObject({ state: "closed", ownedEndpoints: 0 });
  expect(run.owner.discovery()).toBeNull();
  expect(run.counts()).toMatchObject({ generations: 1, stops: 0, notifications: 0 });
});

for (const phase of ["candidate", "serving"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`unexpected native closed ${outcome} fences a ${phase} endpoint`, async () => {
      const run = fixture({ holdReady: phase === "candidate" });
      try {
        if (phase === "serving") await run.owner.ready;
        else await yieldCallbacks();
        expect(run.live()).toBe(phase === "serving");
        if (outcome === "resolve") run.closed.resolve();
        else run.closed.reject(new Error("native liveness failure"));
        await yieldCallbacks();
        expect(run.owner.status().state).toBe("failed");
        expect(run.owner.discovery()).toBeNull();
        expect(run.live()).toBe(false);
        expect(run.counts().notifications).toBe(1);
        expect(run.counts().stops).toBe(1);
        run.ready.resolve();
        await run.owner.ready.catch(() => {});
        await yieldCallbacks();
        expect(run.owner.status().generation).toBe(phase === "serving" ? 1 : 0);
        expect(run.counts().notifications).toBe(1);
        if (outcome === "reject") await expect(run.owner.close()).rejects.toThrow();
        else await run.owner.close();
      } finally {
        run.ready.resolve();
        run.closed.resolve();
        await run.owner.ready.catch(() => {});
        await run.owner.close().catch(() => {});
      }
    });
  }
}

test("normal endpoint stop does not notify a liveness failure", async () => {
  const run = fixture();
  await run.owner.ready;
  await run.owner.close();
  await yieldCallbacks();
  expect(run.counts()).toMatchObject({ notifications: 0, stops: 1 });
  expect(run.owner.status().state).toBe("closed");
});

test("file certificate warns once after crossing seven days remaining", async () => {
  const run = fixture({ operator: true });
  try {
    await run.owner.ready;
    expect(run.logs.filter((event) => event.result === "certificate-soon-expiring")).toHaveLength(0);
    run.tick(2);
    expect(run.owner.discovery()).not.toBeNull();
    run.tick(1);
    run.owner.status();
    expect(run.logs.filter((event) => event.result === "certificate-soon-expiring")).toHaveLength(1);
  } finally {
    await run.owner.close();
  }
});
