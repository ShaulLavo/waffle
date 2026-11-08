import { expect, test } from "bun:test";
import { FixtureOwner } from "./fixture-owner.js";

test("fixture is inert until start and joins actual callback before one close", async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const latch = Promise.withResolvers<unknown>();
  const owner = new FixtureOwner({
    caseId: "c",
    create: () => ({
      async start({ origin }) {
        events.push(origin);
        return [
          {
            path: "/idle",
            get: () => {
              entered.resolve();
              return latch.promise;
            },
          },
        ];
      },
      async close() {
        events.push("close");
      },
    }),
  });
  expect(events).toEqual([]);
  await owner.start({
    origin: "http://127.0.0.1:1234",
    run: "r",
    scratch: "unused",
    signal: new AbortController().signal,
  });
  const pending = owner.get("/idle", new AbortController().signal);
  await entered.promise;
  owner.revoke("stop");
  const result = await owner.finish(performance.now() + 20);
  expect(result.callbacks.status).toBe("unconfirmed");
  expect(result.fixture.status).toBe("unconfirmed");
  expect(events).toEqual(["http://127.0.0.1:1234"]);
  latch.resolve({ sockets: 0 });
  await expect(pending).rejects.toThrow();
  await owner.closed;
  expect(events).toEqual(["http://127.0.0.1:1234", "close"]);
  expect(result.fixture.status).toBe("unconfirmed");
});

test("startup loss retains actual startup and closes once only after it settles", async () => {
  const startup = Promise.withResolvers<[]>();
  const entered = Promise.withResolvers<void>();
  let closes = 0;
  const owner = new FixtureOwner({
    caseId: "start",
    create: () => ({
      start: () => {
        entered.resolve();
        return startup.promise;
      },
      close: async () => {
        closes++;
      },
    }),
  });
  const starting = owner.start({
    origin: "http://localhost",
    run: "r",
    scratch: "owned",
    signal: new AbortController().signal,
  });
  void starting.catch(() => {});
  await entered.promise;
  const cleanup = await owner.finish(performance.now() + 15);
  expect(cleanup.callbacks.status).toBe("unconfirmed");
  expect(cleanup.callbacks.detail).toContain("startup settled=false");
  expect(closes).toBe(0);
  startup.resolve([]);
  await expect(starting).rejects.toThrow();
  await owner.closed;
  expect(closes).toBe(1);
  expect(cleanup.fixture.status).toBe("unconfirmed");
});
test("startup join and close share a single decreasing cleanup budget", async () => {
  const close = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const owner = new FixtureOwner({
    caseId: "budget",
    create: () => ({
      start: async () => {
        await started.promise;
        return [];
      },
      close: () => close.promise,
    }),
  });
  const starting = owner.start({
    origin: "http://localhost",
    run: "r",
    scratch: "owned",
    signal: new AbortController().signal,
  });
  await Promise.resolve();
  const before = performance.now();
  const finishing = owner.finish(before + 30);
  setTimeout(started.resolve, 15);
  const cleanup = await finishing;
  await starting.catch(() => {});
  expect(cleanup.fixture.status).toBe("unconfirmed");
  expect(performance.now() - before).toBeLessThan(60);
  close.resolve();
  await owner.closed;
});
for (const error of [null, undefined, false, ""]) {
  test(`falsy close rejection remains a failed actual close: ${String(error)}`, async () => {
    const owner = new FixtureOwner({
      caseId: "close",
      create: () => ({ start: async () => [], close: () => Promise.reject(error) }),
    });
    const cleanup = await owner.finish(performance.now() + 100);
    expect(cleanup.fixture.status).toBe("unconfirmed");
  });
}
