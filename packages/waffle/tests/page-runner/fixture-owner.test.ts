import { expect, test } from "bun:test";
import { FixtureOwner } from "./fixture-owner.js";

test("fixture is inert until start and joins actual callback before one close", async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const latch = Promise.withResolvers<unknown>();
  const owner = new FixtureOwner({ caseId: "c", create: () => ({
    async start({ origin }) { events.push(origin); return [{ path: "/idle", get: () => { entered.resolve(); return latch.promise; } }]; },
    async close() { events.push("close"); },
  }) });
  expect(events).toEqual([]);
  await owner.start({ origin: "http://127.0.0.1:1234", run: "r", scratch: "unused", signal: new AbortController().signal });
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
