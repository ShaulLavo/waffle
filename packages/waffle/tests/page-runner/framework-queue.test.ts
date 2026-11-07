import { expect, test } from "bun:test";
import { FrameworkQueue } from "./framework-queue.js";
import { HostConsumers } from "./owned-consumers.js";

function fixture() {
  const consumers = new HostConsumers(),
    faults: string[] = [];
  let expired = false;
  const queue = new FrameworkQueue(
    consumers,
    () => {
      if (expired) throw new Error("Expired operation");
    },
    (detail) => faults.push(detail),
  );
  return {
    queue,
    consumers,
    faults,
    expire: () => {
      expired = true;
    },
  };
}
test("one queue joins nested entries and owns the actual HTTP settlement independently of callback return", async () => {
  const { queue, faults } = fixture();
  const order: string[] = [];
  let request: RequestInit = {};
  const first = queue.run(async () => {
    await queue.run(async () => {
      order.push("nested");
    });
    request = queue.guard({ signal: AbortSignal.timeout(1000) });
    order.push("callback-return");
  });
  const next = queue.run(async () => {
    order.push("probe");
  });
  await Bun.sleep(15);
  expect(order).toEqual(["nested", "callback-return"]);
  queue.response({ statusCode: 200, body: { value: null } }, request);
  await first;
  await next;
  expect(order).toEqual(["nested", "callback-return", "probe"]);
  expect(faults).toEqual([]);
});
test("unowned, revoked, and inherited expired operation contexts cannot enter the request boundary", async () => {
  const { queue } = fixture();
  expect(() => queue.guard({})).toThrow("Unowned");
  let late: (() => void) | undefined;
  await queue.run(async () => {
    late = () => queue.guard({});
  });
  expect(late).toBeDefined();
  queue.revoke();
  await expect(queue.run(async () => queue.guard({}))).rejects.toThrow("revoked");
});
test("a previously queued operation is checked at dispatch, not just enqueue time", async () => {
  const { queue, expire } = fixture();
  const release = Promise.withResolvers<void>();
  const first = queue.run(() => release.promise);
  let dispatched = false;
  const waiting = queue.run(async () => {
    dispatched = true;
  });
  await Bun.sleep(5);
  expire();
  release.resolve();
  await first.catch(() => {});
  await waiting.catch(() => {});
  expect(dispatched).toBe(false);
});
test("malformed responses caught by an SDK caller remain sticky via actual transport events", async () => {
  const { queue, faults } = fixture();
  let settle: ((event: unknown) => void) | undefined;
  queue.observe({
    on(_event: string, listener: (event: unknown) => void) {
      settle = listener;
    },
    off() {},
  });
  await queue.run(async () => {
    const request = queue.guard({});
    settle?.({ request, success: false, error: new Error("Could not parse response") });
  });
  expect(faults.some((fault) => fault.includes("Could not parse"))).toBe(true);
});
test("the request guard composes the original SDK signal instead of replacing it", async () => {
  const { queue } = fixture();
  const sdk = new AbortController();
  await queue.run(async () => {
    const request = queue.guard({ signal: sdk.signal });
    sdk.abort("SDK timeout");
    expect(request.signal?.aborted).toBe(true);
    queue.response({ statusCode: 200, body: { value: null } }, request);
  });
});

test("SDK hook observations retain their operation token but never substitute for actual HTTP settlement", async () => {
  const { queue } = fixture();
  const release = Promise.withResolvers<void>();
  let request: RequestInit = {};
  const first = queue.run(async () => {
    queue.commandStarted();
    request = queue.guard({});
    void release.promise.then(() => queue.commandSettled());
  });
  let probed = false;
  const second = queue.run(async () => {
    probed = true;
  });
  await Bun.sleep(10);
  expect(probed).toBe(false);
  queue.response({ statusCode: 200, body: { value: null } }, request);
  await first;
  await second;
  expect(probed).toBe(true);
  release.resolve();
  await Bun.sleep(0);
  expect(queue.commandHooks).toHaveLength(2);
  expect(queue.commandHooks[0]?.operation).toBe(queue.commandHooks[1]?.operation);
  expect(queue.commandHooks[1]?.revoked).toBe(true);
});
