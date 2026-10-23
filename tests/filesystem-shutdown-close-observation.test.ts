import { expect, spyOn, test } from "bun:test";
import {
  before,
  evidenceJson,
  failureValue,
  failureReasons,
  observe,
  type BeforeRecord,
} from "./filesystem-shutdown-browser.js";

function clockFixture() {
  const handle = setTimeout(() => {}, 2_147_483_647);
  handle.unref();
  let wallMs = 10_000;
  let monotonicMs = 200;
  const wall = spyOn(Date, "now").mockImplementation(() => wallMs);
  const monotonic = spyOn(performance, "now").mockImplementation(() => monotonicMs);
  const timer = spyOn(globalThis, "setTimeout").mockReturnValue(handle);
  return {
    expire() {
      wallMs += 1000;
      monotonicMs += 1000;
      const scheduled = timer.mock.calls[0];
      if (!scheduled || typeof scheduled[0] !== "function")
        throw new Error("Actual before timer was not installed");
      expect(scheduled[1]).toBe(1000);
      scheduled[0]();
    },
    close() {
      timer.mockRestore();
      wall.mockRestore();
      monotonic.mockRestore();
      clearTimeout(handle);
    },
  };
}

async function lateClose(reason: unknown, reject: boolean) {
  const clock = clockFixture();
  const original = Promise.withResolvers<void>();
  const called = Promise.withResolvers<void>();
  const records: BeforeRecord<void>[] = [];
  const primary = new Error("distinct primary failure");
  let calls = 0;
  try {
    const bounded = before(
      55_000,
      "owned context close",
      () => {
        calls++;
        called.resolve();
        return original.promise;
      },
      1000,
      { events: records },
    );
    await called.promise;
    clock.expire();
    const invalid = await bounded;
    expect(invalid).toEqual({ kind: "invalid", cause: "owned context close: deadline expired" });
    if (reject) original.reject(reason);
    else original.resolve();
    // Join only the test-controlled operation, never a wall-clock grace period.
    await original.promise.catch(() => {});
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(await bounded).toBe(invalid);
    const returned = records.find((event) => event.kind === "operation-returned");
    expect(returned?.kind).toBe("operation-returned");
    if (returned?.kind !== "operation-returned")
      throw new Error("Original close promise was not retained");
    expect(returned.promise).toBe(original.promise);
    const settled = records.find((event) => event.kind === "operation-settled");
    expect(settled?.kind).toBe("operation-settled");
    if (settled?.kind !== "operation-settled")
      throw new Error("Late original outcome was not retained");
    expect(settled.outcome.kind).toBe(reject ? "rejected" : "fulfilled");
    if (settled.outcome.kind === "rejected")
      expect(Object.is(settled.outcome.reason, reason)).toBe(true);
    const evidence = {
      primary: { kind: "rejected", reason: primary },
      cleanup: settled.outcome,
      bounded: invalid,
    };
    expect(evidence.primary.reason).toBe(primary);
    expect(evidenceJson(evidence)).toContain("distinct primary failure");
    const started = records.find((event) => event.kind === "started");
    expect(started).toEqual({
      kind: "started",
      at: { wallMs: 10_000, monotonicMs: 200 },
      effectiveMs: 1000,
      timerDueMonotonicMs: 1200,
    });
    expect(records.find((event) => event.kind === "timer-scheduled")).toEqual({
      kind: "timer-scheduled",
      at: { wallMs: 10_000, monotonicMs: 200 },
      timerDueMonotonicMs: 1200,
    });
    expect(records.find((event) => event.kind === "timer-fired")).toEqual({
      kind: "timer-fired",
      at: { wallMs: 11_000, monotonicMs: 1200 },
    });
    expect(records.map((event) => event.kind)).toEqual([
      "started",
      "timer-scheduled",
      "operation-returned",
      "timer-fired",
      "returned",
      "operation-settled",
    ]);
  } finally {
    original.resolve();
    clock.close();
  }
}

test("actual before retains the one deferred close after its timer wins", () =>
  lateClose(undefined, false));
for (const reason of failureReasons)
  test(`actual before retains late original rejection without falsy loss: ${reason}`, () =>
    lateClose(failureValue(reason), true));

import {
  ContextCloseObservation,
  shutdownSelection,
} from "./filesystem-shutdown-close-observation.js";
import {
  stopBrowserResource,
  type BrowserResourceOwner,
  type ResourceCloseObserver,
} from "./process-recycling-browser-runner-control.js";

function contextFixture() {
  const operation = Promise.withResolvers<void>();
  const invoked = Promise.withResolvers<void>();
  const receiver = Promise.withResolvers<unknown>();
  let listener: (() => void) | undefined;
  let getters = 0;
  let calls = 0;
  const context = {
    once(event: "close", callback: () => void) {
      expect(event).toBe("close");
      listener = callback;
    },
    get close() {
      expect(listener).toBeDefined();
      getters++;
      return function (this: unknown) {
        calls++;
        expect(listener).toBeDefined();
        receiver.resolve(this);
        listener?.();
        invoked.resolve();
        return operation.promise;
      };
    },
  };
  return {
    context,
    operation,
    invoked: invoked.promise,
    receiver: receiver.promise,
    counts: () => ({ getters, calls }),
  };
}
async function contextCase(reason: unknown, reject: boolean, late: boolean) {
  const clock = clockFixture();
  const fixture = contextFixture();
  const observation = new ContextCloseObservation("exact-owner", Promise.resolve(fixture.context));
  try {
    const bounded = observation.observeBefore(55_000);
    await fixture.invoked;
    expect(await fixture.receiver).toBe(fixture.context);
    expect(observation.original.kind).toBe("returned");
    if (observation.original.kind !== "returned") throw new Error("Missing original call");
    expect(observation.original.promise).toBe(fixture.operation.promise);
    expect(observation.original.context).toBe(fixture.context);
    expect(observation.closeEvent.kind).toBe("fulfilled");
    if (late) clock.expire();
    const beforeSettlement = late ? await bounded : undefined;
    if (reject) fixture.operation.reject(reason);
    else fixture.operation.resolve();
    const result = await bounded;
    await fixture.operation.promise.catch(() => {});
    await Promise.resolve();
    expect(fixture.counts()).toEqual({ getters: 1, calls: 1 });
    expect(result.kind).toBe(late ? "invalid" : reject ? "rejected" : "fulfilled");
    if (late) {
      if (!beforeSettlement) throw new Error("Missing original bounded result");
      expect(result).toBe(beforeSettlement);
    }
    const snapshot = observation.originalSnapshot();
    if (snapshot.kind !== "returned" || !("outcome" in snapshot.settled))
      throw new Error("Missing original settlement");
    expect(snapshot.exactAllocatedContext).toBe(true);
    expect(snapshot.settled.outcome.kind).toBe(reject ? "rejected" : "fulfilled");
    if (snapshot.settled.outcome.kind === "rejected")
      expect(Object.is(snapshot.settled.outcome.reason, reason)).toBe(true);
    expect(snapshot.at).toEqual({ wallMs: 10_000, monotonicMs: 200 });
    expect(snapshot.settled.at.wallMs).toBe(late ? 11_000 : 10_000);
  } finally {
    fixture.operation.resolve();
    clock.close();
  }
}
for (const late of [false, true]) {
  test(`retained context exact receiver/raw promise, fulfillment, late=${late}`, () =>
    contextCase(undefined, false, late));
  for (const reason of failureReasons)
    test(`retained context exact rejection ${reason}, late=${late}`, () =>
      contextCase(failureValue(reason), true, late));
}

test("missing allocation/call remains missing when the existing cap expires", async () => {
  const clock = clockFixture();
  const allocation = Promise.withResolvers<ReturnType<typeof contextFixture>["context"]>();
  const observation = new ContextCloseObservation("missing", allocation.promise);
  try {
    const bounded = observation.observeBefore(55_000);
    clock.expire();
    expect((await bounded).kind).toBe("invalid");
    expect(observation.snapshot().allocation.kind).toBe("pending");
    expect(observation.original.kind).toBe("not-invoked");
    expect(observation.snapshot().closeEvent.kind).toBe("pending");
  } finally {
    allocation.reject(undefined);
    await allocation.promise.catch(() => {});
    clock.close();
  }
});

test("exhausted arm does not invoke close or install another timer", async () => {
  const clock = clockFixture();
  const fixture = contextFixture();
  const observation = new ContextCloseObservation("exhausted", Promise.resolve(fixture.context));
  try {
    expect(await observation.observeBefore(9999)).toEqual({
      kind: "invalid",
      cause: "owned context close: arm deadline exhausted",
    });
    expect(fixture.counts()).toEqual({ getters: 0, calls: 0 });
    expect(observation.original.kind).toBe("not-invoked");
  } finally {
    clock.close();
  }
});

async function enclosingCase(reason: unknown, reject: boolean) {
  const clock = clockFixture();
  const fixture = contextFixture();
  const observation = new ContextCloseObservation("outer", Promise.resolve(fixture.context));
  const browserClose = Promise.withResolvers<void>();
  const browserInvoked = Promise.withResolvers<void>();
  let browserCalls = 0;
  const browser = {
    close() {
      browserCalls++;
      expect(observation.outer.map((event) => event.event)).toEqual(["started"]);
      browserInvoked.resolve();
      return browserClose.promise;
    },
  };
  const observer: ResourceCloseObserver = {
    errors: [],
    record(event) {
      observation.enclosing(event);
    },
  };
  const owner: BrowserResourceOwner = {
    creation: Promise.resolve(browser),
    stopped: false,
    observeClose: observer,
  };
  const owners = new Set([owner]);
  try {
    const bounded = observation.observeBefore(55_000);
    await fixture.invoked;
    clock.expire();
    const invalid = await bounded;
    const cleanup = stopBrowserResource(owners, owner);
    await browserInvoked.promise;
    const during = observation.snapshot();
    expect(during.original.kind).toBe("returned");
    if (reject) fixture.operation.reject(reason);
    else fixture.operation.resolve();
    await fixture.operation.promise.catch(() => {});
    if (reject) browserClose.reject(reason);
    else browserClose.resolve();
    const actualCleanup = await cleanup.then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, reason: error }),
    );
    expect(actualCleanup.kind).toBe(reject ? "rejected" : "fulfilled");
    if (actualCleanup.kind === "rejected")
      expect(Object.is(actualCleanup.reason, reason)).toBe(true);
    expect(browserCalls).toBe(1);
    expect(fixture.counts()).toEqual({ getters: 1, calls: 1 });
    expect(observation.bounded).toBe(invalid);
    expect(observation.outer.map((event) => event.event)).toEqual([
      "started",
      reject ? "rejected" : "fulfilled",
    ]);
    expect(observer.errors).toEqual([]);
    expect(during.outer).toHaveLength(1);
  } finally {
    fixture.operation.resolve();
    browserClose.resolve();
    clock.close();
  }
}
for (const reason of failureReasons)
  test(`actual enclosing resource close snapshots preserve ${reason}`, () =>
    enclosingCase(failureValue(reason), true));
test("actual enclosing close fulfillment cannot cure invalid context", () =>
  enclosingCase(undefined, false));

test("default selection stays84 arms and explicit selector selects exactly one existing arm", () => {
  const defaults = shutdownSelection(["chromium", "firefox", "webkit"]);
  expect(defaults.selected).toEqual(["chromium", "firefox", "webkit"]);
  expect(defaults.arms).toEqual([
    "success",
    "drain-failure",
    "final-save-failure",
    "raw-close-failure",
  ]);
  expect(defaults.reasons).toEqual(failureReasons);
  expect(defaults.selected.length * (1 + 3 * defaults.reasons.length)).toBe(84);
  expect(
    shutdownSelection([
      "firefox",
      "--backend",
      "indexeddb",
      "--reason",
      "error",
      "--arm",
      "raw-close-failure",
    ]),
  ).toEqual({ selected: ["firefox"], reasons: ["error"], arms: ["raw-close-failure"] });
});
for (const args of [
  ["firefox", "--arm", "raw-close-failure"],
  ["chromium", "--reason", "error", "--arm", "raw-close-failure"],
  ["firefox", "webkit", "--reason", "error", "--arm", "raw-close-failure"],
  ["firefox", "--reason", "false", "--arm", "raw-close-failure"],
  ["firefox", "--backend", "opfs", "--reason", "error", "--arm", "raw-close-failure"],
  ["firefox", "--reason", "error", "--arm", "success"],
])
  test(`selector rejects incompatible ${args.join(" ")}`, () =>
    expect(() => shutdownSelection(args)).toThrow());

for (const reason of failureReasons)
  test(`synchronous original close throw retains exact ${reason}`, async () => {
    const clock = clockFixture();
    const error = failureValue(reason);
    let calls = 0;
    const context = {
      once() {},
      close(): Promise<void> {
        calls++;
        throw error;
      },
    };
    const observation = new ContextCloseObservation("sync-throw", Promise.resolve(context));
    try {
      const result = await observation.observeBefore(55_000);
      expect(calls).toBe(1);
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") expect(Object.is(result.reason, error)).toBe(true);
      expect(observation.original.kind).toBe("call-threw");
      if (observation.original.kind === "call-threw")
        expect(Object.is(observation.original.reason, error)).toBe(true);
    } finally {
      clock.close();
    }
  });

test("optional enclosing observer failure cannot replace original cleanup failure", async () => {
  const primary = new Error("primary sentinel");
  const cleanup = new Error("cleanup sentinel");
  const observer = new Error("observer sentinel");
  const errors: unknown[] = [];
  const owner: BrowserResourceOwner = {
    creation: Promise.resolve({ close: () => Promise.reject(cleanup) }),
    stopped: false,
    observeClose: {
      errors,
      record() {
        throw observer;
      },
    },
  };
  const result = await observe(stopBrowserResource(new Set([owner]), owner));
  expect(result.kind).toBe("rejected");
  if (result.kind === "rejected") expect(result.reason).toBe(cleanup);
  expect(errors).toEqual([observer, observer]);
  expect(primary).not.toBe(cleanup);
});

test("close getter failure remains a missing call and retains its original reason", async () => {
  const clock = clockFixture();
  let getters = 0;
  const context = {
    once() {},
    get close(): () => Promise<void> {
      getters++;
      throw undefined;
    },
  };
  const observation = new ContextCloseObservation("lookup-failure", Promise.resolve(context));
  try {
    const result = await observation.observeBefore(55_000);
    expect(result.kind).toBe("rejected");
    expect(getters).toBe(1);
    expect(observation.original.kind).toBe("lookup-threw");
    if (observation.original.kind === "lookup-threw")
      expect(observation.original.reason).toBeUndefined();
  } finally {
    clock.close();
  }
});

test("remaining Firefox selection contains exactly the eight never-run raw-close cells", () => {
  const selected = shutdownSelection(["firefox", "--remaining-firefox"]);
  expect(selected.selected).toEqual(["firefox"]);
  expect(selected.arms).toEqual(["raw-close-failure"]);
  expect(selected.reasons).toEqual(failureReasons.filter((reason) => reason !== "error"));
  expect(selected.reasons).toHaveLength(8);
});
for (const args of [
  ["webkit", "--remaining-firefox"],
  ["firefox", "webkit", "--remaining-firefox"],
  ["firefox", "--remaining-firefox", "--reason", "error"],
  ["firefox", "--remaining-firefox", "--remaining-firefox"],
])
  test(`remaining Firefox selector rejects ${args.join(" ")}`, () => {
    expect(() => shutdownSelection(args)).toThrow();
  });
