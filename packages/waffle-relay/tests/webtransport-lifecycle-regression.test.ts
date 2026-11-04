import { expect, test } from "bun:test";
import type { CertificateMaterial } from "../src/webtransport-certificate.js";
import { WebTransportLifecycle, type ManagedEndpoint } from "../src/webtransport-lifecycle.js";

function fixture(
  options: {
    holdGeneration?: boolean;
    holdReady?: boolean;
    operator?: boolean;
    closedAtConstruction?: "resolve" | "reject";
  } = {},
) {
  let wall = 100000;
  let mono = 0;
  let check = () => {};
  let generations = 0;
  let notifications = 0;
  const logs: Record<string, unknown>[] = [];
  const material: CertificateMaterial = {
    cert: "fixture",
    key: "fixture",
    starts: wall,
    expires: wall + (options.operator ? 8 : 13) * 86400000,
    hash: { algorithm: "sha-256", value: "fixture" },
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
    fence() {
      fences++;
    },
    async stop() {
      stops++;
      closed.resolve();
      await closed.promise;
    },
  };
  const owner = new WebTransportLifecycle(
    {
      rotationMs: 1000,
      hashMode: !options.operator,
      certificate() {
        generations++;
        return options.holdGeneration ? generation.promise : Promise.resolve(material);
      },
      construct(_record, admission) {
        live = admission;
        if (options.closedAtConstruction === "resolve") closed.resolve();
        if (options.closedAtConstruction === "reject")
          closed.reject(new Error("closed at construction"));
        return endpoint;
      },
      discovery: () => ({ url: "https://127.0.0.1:4433/v1/tcp/wt" }),
      onEndpointFailure() {
        notifications++;
      },
      log: (event) => logs.push(event),
    },
    {
      wallNow: () => wall,
      monotonicNow: () => mono,
      scheduleCheck(callback) {
        check = callback;
        return () => {
          check = () => {};
        };
      },
      endpointStateChanged() {},
    },
  );
  return {
    owner,
    generation,
    ready,
    closed,
    material,
    logs,
    live: () => live(),
    counts: () => ({ generations, notifications, stops, fences }),
    advanceMonotonic() {
      mono = 13000;
    },
    tick(days: number) {
      wall += days * 86400000;
      check();
    },
  };
}

async function yieldCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test.each([false, true])(
  "pending certificate generation remains failed debt, late rejection=%s",
  async (reject) => {
    const run = fixture({ holdGeneration: true });
    try {
      run.advanceMonotonic();
      const closing = run.owner.close();
      const failure = await closing.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(run.owner.close()).toBe(closing);
      await expect(run.owner.close()).rejects.toBe(failure);
      expect(run.owner.status()).toMatchObject({
        state: "failed",
        ownedEndpoints: 0,
        generationPending: true,
        cleanupFailed: true,
      });
      if (reject) run.generation.reject(new Error("late cancelled generation"));
      else run.generation.resolve(run.material);
      await run.owner.ready.catch(() => {});
      await yieldCallbacks();
      expect(run.owner.discovery()).toBeNull();
      expect(run.owner.status()).toMatchObject({ generationPending: false, cleanupFailed: true });
      expect(run.counts()).toMatchObject({ generations: 1, stops: 0, notifications: 0 });
      await expect(run.owner.close()).rejects.toBe(failure);
    } finally {
      run.generation.resolve(run.material);
      await run.owner.ready.catch(() => {});
      await run.owner.close().catch(() => {});
    }
  },
);

test.each([false, true])(
  "confirmed cancelled generation joins cleanly, rejected=%s",
  async (reject) => {
    const run = fixture({ holdGeneration: true });
    const closing = run.owner.close();
    if (reject) run.generation.reject(new Error("cancelled generation joined"));
    else run.generation.resolve(run.material);
    await closing;
    expect(run.owner.status()).toMatchObject({ state: "closed", ownedEndpoints: 0 });
    expect(run.owner.discovery()).toBeNull();
    expect(run.counts()).toMatchObject({ generations: 1, stops: 0, notifications: 0 });
  },
);

const closureCases: {
  phase: "construction" | "candidate" | "serving";
  outcome: "resolve" | "reject";
}[] = [
  { phase: "construction", outcome: "resolve" },
  { phase: "construction", outcome: "reject" },
  { phase: "candidate", outcome: "resolve" },
  { phase: "candidate", outcome: "reject" },
  { phase: "serving", outcome: "resolve" },
  { phase: "serving", outcome: "reject" },
];
test.each(closureCases)(
  "unexpected native closed $outcome fences a $phase endpoint",
  async ({ phase, outcome }) => {
    const run = fixture({
      holdReady: phase !== "serving",
      closedAtConstruction: phase === "construction" ? outcome : undefined,
    });
    try {
      if (phase === "serving") await run.owner.ready;
      else await yieldCallbacks();
      expect(run.live()).toBe(phase === "serving");
      if (outcome === "resolve") run.closed.resolve();
      else run.closed.reject(new Error("native liveness failure"));
      await Promise.resolve();
      expect(run.live()).toBe(false);
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
  },
);

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
    expect(run.logs.filter((event) => event.result === "certificate-soon-expiring")).toHaveLength(
      0,
    );
    run.tick(1);
    expect(run.logs.filter((event) => event.result === "certificate-soon-expiring")).toHaveLength(
      0,
    );
    run.tick(1);
    expect(run.owner.discovery()).not.toBeNull();
    run.tick(1);
    run.owner.status();
    expect(run.logs.filter((event) => event.result === "certificate-soon-expiring")).toHaveLength(
      1,
    );
  } finally {
    await run.owner.close();
  }
});
