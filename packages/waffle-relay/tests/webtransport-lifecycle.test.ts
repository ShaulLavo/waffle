import { expect, test } from "bun:test";
import {
  WebTransportLifecycle,
  type ManagedEndpoint,
  type RotationTestDependencies,
  type EndpointFailure,
} from "../src/webtransport-lifecycle.js";

function fixture(
  options: {
    hook?: (failure: EndpointFailure) => void | Promise<void>;
    failGeneration?: number;
    holdReady?: number;
    holdClosed?: number;
    operator?: boolean;
    notBeforeOffset?: number;
    rotationMs?: number;
  } = {},
) {
  let wall = 100000;
  let mono = 0;
  let check = () => {};
  let generation = 0;
  const endpoints: {
    ready: ReturnType<typeof Promise.withResolvers<void>>;
    closed: ReturnType<typeof Promise.withResolvers<void>>;
    stops: number;
    fenced: boolean;
  }[] = [];
  const dependencies: RotationTestDependencies = {
    wallNow: () => wall,
    monotonicNow: () => mono,
    scheduleCheck(callback) {
      check = callback;
      return () => {
        check = () => {};
      };
    },
    endpointStateChanged() {},
  };
  const owner = new WebTransportLifecycle(
    {
      rotationMs: options.rotationMs ?? 1000,
      hashMode: !options.operator,
      certificate: async () => ({
        cert: "fixture",
        key: "private-fixture",
        starts: wall + (options.notBeforeOffset ?? 0),
        expires: wall + 13 * 86400000,
        hash: { algorithm: "sha-256", value: String(++generation) },
      }),
      construct() {
        const ready = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const id = generation;
        const item = { ready, closed, stops: 0, fenced: false };
        endpoints.push(item);
        const native: ManagedEndpoint = {
          ready: ready.promise,
          closed: closed.promise,
          start() {
            if (options.failGeneration === id) ready.reject(new Error("bind failed"));
            else if (options.holdReady !== id) ready.resolve();
          },
          fence() {
            item.fenced = true;
          },
          async stop() {
            item.stops++;
            if (options.holdClosed !== id) closed.resolve();
            await closed.promise;
          },
        };
        return native;
      },
      discovery: (certificate) => ({
        url: "https://127.0.0.1:4433/v1/tcp/wt",
        certificateHashes: [certificate.hash],
      }),
      onEndpointFailure: options.hook,
      log() {},
    },
    dependencies,
  );
  return {
    owner,
    endpoints,
    tick(delta = 1001) {
      wall += delta;
      check();
    },
    jump(value: number) {
      wall = value;
      check();
    },
    mono(value: number) {
      mono = value;
    },
    certificateStarts: () => wall,
  };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("lifecycle did not settle");
}
test("recycling fences synchronously, coalesces callbacks and publishes one replacement hash", async () => {
  const run = fixture();
  try {
    await run.owner.ready;
    expect(run.owner.discovery()?.certificateHashes?.[0]?.value).toBe("1");
    run.tick();
    expect(run.endpoints[0]!.fenced).toBe(true);
    expect(run.owner.discovery()).toBeNull();
    run.tick(0);
    await until(() => run.owner.status().generation === 2);
    expect(run.endpoints.length).toBe(2);
    expect(run.endpoints[0]!.stops).toBe(1);
    expect(run.owner.discovery()?.certificateHashes?.[0]?.value).toBe("2");
  } finally {
    await run.owner.close();
  }
  expect(run.owner.status().ownedEndpoints).toBe(0);
});
test("late ready after close cannot publish and close is idempotent", async () => {
  const run = fixture({ holdReady: 1 });
  await until(() => run.endpoints.length === 1);
  const first = run.owner.close();
  expect(run.owner.close()).toBe(first);
  run.endpoints[0]!.ready.resolve();
  await first;
  expect(run.owner.discovery()).toBeNull();
  expect(run.owner.status()).toMatchObject({ state: "closed", ownedEndpoints: 0 });
});
test("candidate bind failure closes both records and notification can close without deadlock", async () => {
  let notifications = 0;
  let closing: Promise<void> | undefined;
  const run = fixture({
    failGeneration: 2,
    hook() {
      notifications++;
      closing = run.owner.close();
      throw new Error("observer failed");
    },
  });
  await run.owner.ready;
  run.tick();
  await run.owner.failure;
  await until(() => notifications === 1);
  await closing;
  expect(run.endpoints.map((entry) => entry.stops)).toEqual([1, 1]);
  expect(run.owner.discovery()).toBeNull();
  expect(run.owner.status().ownedEndpoints).toBe(0);
});
test("an unconfirmed close retains ownership and a concurrent close cannot renew the budget", async () => {
  const run = fixture({ holdReady: 2, holdClosed: 2 });
  await run.owner.ready;
  run.tick();
  await until(() => run.endpoints.length === 2);
  run.mono(13000);
  const closing = run.owner.close();
  run.endpoints[1]!.ready.resolve();
  await expect(closing).rejects.toThrow("unsettled");
  expect(run.owner.status().ownedEndpoints).toBe(1);
  expect(run.owner.close()).toBe(closing);
  run.endpoints[1]!.closed.resolve();
});
test("backward clock jumps rotate without advertising an old or not-yet-valid hash", async () => {
  const run = fixture();
  try {
    await run.owner.ready;
    run.jump(90000);
    expect(run.owner.discovery()).toBeNull();
    await until(() => run.owner.status().generation === 2);
    expect(run.owner.discovery()?.certificateHashes?.[0]?.value).toBe("2");
  } finally {
    await run.owner.close();
  }
});

test("a pending failure observer cannot hold cleanup and file expiry is manual-only", async () => {
  const run = fixture({ failGeneration: 2, hook: () => new Promise(() => {}) });
  await run.owner.ready;
  run.tick();
  await run.owner.failure;
  await run.owner.close();
  expect(run.owner.status().ownedEndpoints).toBe(0);
  let notifications = 0;
  const operator = fixture({
    operator: true,
    hook() {
      notifications++;
    },
  });
  await operator.owner.ready;
  operator.jump(100000 + 13 * 86400000 + 1);
  expect(await operator.owner.failure).toEqual({
    code: "certificate-expired",
    manualActionRequired: true,
  });
  expect(operator.owner.discovery()).toBeNull();
  await operator.owner.close();
  expect(notifications).toBe(0);
});

test("rotation interval and not-yet-valid certificates fail before publication", async () => {
  for (const rotationMs of [0, 999, 12 * 86400000 + 1])
    expect(() => fixture({ rotationMs })).toThrow("rotation interval");
  const generated = fixture({ notBeforeOffset: 1000 });
  await expect(generated.owner.ready).rejects.toThrow("certificate validity");
  expect(generated.owner.discovery()).toBeNull();
  expect(generated.endpoints.length).toBe(0);
  await generated.owner.close();
  const operator = fixture({ operator: true, notBeforeOffset: 1000 });
  await expect(operator.owner.ready).rejects.toThrow("certificate validity");
  expect((await operator.owner.failure).manualActionRequired).toBe(true);
  await operator.owner.close();
});
