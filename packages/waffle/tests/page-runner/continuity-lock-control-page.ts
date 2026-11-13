import { acquirePublicationGuard } from "../../fs/publication-attachment.js";
import { crossTabEvaluator } from "./cross-tab-evaluator.js";
import { encodeCrossTabValue, decodeCrossTabValue } from "./cross-tab-value.js";
import {
  observeContinuityLocks,
  installContinuityLockDiagnostic,
  continuityDiagnosticSnapshot,
  projectContinuityDiagnostic,
} from "./continuity-lock-diagnostic.js";
import { StallDiagnostics } from "./stall-diagnostics.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const key = "waffle:publication:continuity:private-workspace-token";
const owner = () => ({ activeJobs: [7], activeJobCount: 1 });
type Mode = "success" | "null" | "sync" | "reject" | "lifetime" | "query" | "query-throw";
const nativeManager = navigator.locks;
const nativeRequest = nativeManager.request;
const nativeQuery = nativeManager.query;
function fake(mode: Mode, primary?: unknown) {
  let requests = 0,
    queries = 0;
  let requestResult: unknown, queryResult: unknown, callbackResult: unknown;
  const callbackReceiver = {};
  const manager = {
    request: new Proxy(nativeRequest, {
      apply(_target, receiver, args: unknown[]) {
        check(receiver === manager, "request receiver");
        requests++;
        if (mode === "sync") throw primary;
        if (mode === "reject") return (requestResult = Promise.reject(primary));
        const callback = args[2];
        check(typeof callback === "function", "original callback");
        const lock = mode === "null" ? null : { name: args[0], mode: "exclusive" };
        callbackResult = Reflect.apply(callback, callbackReceiver, [lock, 19]);
        requestResult = Promise.resolve(callbackResult).then((value) => {
          if (mode === "lifetime") throw primary;
          return value;
        });
        return requestResult;
      },
    }),
    query: new Proxy(nativeQuery, {
      apply(_target, receiver, args: unknown[]) {
        check(receiver === manager && args.length === 0, "query receiver/arguments");
        queries++;
        if (mode === "query-throw") throw primary;
        queryResult =
          mode === "query" ? Promise.reject(primary) : Promise.resolve({ held: [], pending: [] });
        return queryResult;
      },
    }),
  };
  return {
    manager,
    counts: () => ({ requests, queries }),
    results: () => ({ requestResult, queryResult, callbackResult }),
    callbackReceiver,
  };
}
function replaceManager(manager: Pick<LockManager, "request" | "query">): void {
  Object.defineProperty(navigator, "locks", { configurable: true, value: manager });
}
async function failureOf(work: Promise<unknown>, expected: unknown): Promise<void> {
  try {
    await work;
  } catch (error) {
    check(Object.is(error, expected), "original rejection identity");
    return;
  }
  throw new Error("Expected original rejection");
}
async function helperControls(): Promise<string[]> {
  // A failed original peer attachment assigns its copied descriptor before acquisition.
  // This initializes the untouched helper without starting an authority or guest Worker.
  const initial = fake("null");
  replaceManager(initial.manager);
  const { control } = await import("../publication-cross-tab-browser.js");
  try {
    await control("peer", {
      kind: "file",
      workspace: "private-workspace-token",
      instance: "control",
      epoch: 1,
      description: "control",
      handle: 1,
    });
  } catch {}
  const labels: string[] = [];
  for (const mode of [
    "success",
    "null",
    "sync",
    "reject",
    "lifetime",
    "query",
    "query-throw",
  ] as const) {
    const fixture = fake(mode, 0);
    replaceManager(fixture.manager);
    const observer = observeContinuityLocks(fixture.manager, owner);
    check((await control("exclusive")) === (mode === "success"), `original helper ${mode}`);
    const snapshot = observer.snapshot();
    const phases = snapshot.records.map((record) => record.phase);
    const expected = {
      success: "query-fulfilled",
      null: "callback-null",
      sync: "request-threw",
      reject: "request-rejected",
      lifetime: "request-rejected",
      query: "query-rejected",
      "query-throw": "query-threw",
    }[mode];
    check(
      phases.some((phase) => phase === expected),
      `phase ${mode}: ${JSON.stringify(snapshot)}`,
    );
    check(fixture.counts().requests === 1, "exact original request count");
    check(
      fixture.counts().queries === (["success", "query", "query-throw"].includes(mode) ? 1 : 0),
      "no rescue query",
    );
    check(!JSON.stringify(snapshot).includes("private-workspace-token"), "no workspace token");
    labels.push(`original-helper-${mode}`);
  }
  return labels;
}
async function guardFailures(): Promise<void> {
  for (const mode of ["sync", "reject", "lifetime", "query", "query-throw"] as const) {
    for (const primary of [undefined, null, false, 0, "", new TypeError("x")]) {
      const fixture = fake(mode, primary);
      replaceManager(fixture.manager);
      observeContinuityLocks(fixture.manager, owner);
      const acquisition = acquirePublicationGuard(
        "private-workspace-token",
        "exclusive",
        new AbortController().signal,
        true,
      );
      if (mode === "sync" || mode === "reject") {
        await failureOf(acquisition, primary);
        continue;
      }
      const guard = await acquisition;
      await failureOf(guard.release(), primary);
    }
  }
}
async function identityControls(): Promise<void> {
  const fixture = fake("success");
  const observer = observeContinuityLocks(fixture.manager, owner);
  const value = {};
  function callback(this: unknown, ...args: unknown[]) {
    check(
      this === fixture.callbackReceiver && args.length === 2 && args[1] === 19,
      "callback this/arguments",
    );
    return value;
  }
  const result = fixture.manager.request(key, { mode: "exclusive", ifAvailable: true }, callback);
  check(
    result === fixture.results().requestResult && fixture.results().callbackResult === value,
    "request/callback identity",
  );
  check((await result) === value, "callback return value");
  const callbackPromise = Promise.resolve(value);
  await fixture.manager.request(key, {}, () => callbackPromise);
  check(fixture.results().callbackResult === callbackPromise, "callback Promise identity");
  const query = fixture.manager.query();
  check(query === fixture.results().queryResult, "query Promise identity");
  await query;
  const primary = {};
  try {
    fixture.manager.request(key, {}, () => {
      throw primary;
    });
  } catch (error) {
    check(error === primary, "callback throw identity");
  }
  check(
    observer.snapshot().records.some((entry) => entry.phase === "callback-threw"),
    "callback throw record",
  );
  const before = observer.snapshot().records.length;
  await fixture.manager.request("unrelated", {}, () => value);
  await fixture.manager.request(
    `${key.replace("private-workspace-token", "")}bootstrap:excluded`,
    {},
    () => value,
  );
  check(observer.snapshot().records.length === before, "scope excludes other locks/bootstrap");
}
async function boundsAndFaults(): Promise<void> {
  let overlapping = true;
  const fixture = fake(
    "query",
    Object.assign(new Error("x".repeat(20_000)), { name: "secret".repeat(2000), errno: 6 }),
  );
  replaceManager(fixture.manager);
  const observer = observeContinuityLocks(fixture.manager, () =>
    overlapping ? { activeJobs: [7, 8], activeJobCount: 2 } : owner(),
  );
  for (let i = 0; i < 48; i++) {
    const guard = await acquirePublicationGuard(
      "private-workspace-token",
      "exclusive",
      new AbortController().signal,
      true,
    );
    await guard.release().catch(() => {});
  }
  const bounded = observer.snapshot();
  check(
    bounded.records.length <= 32 &&
      new TextEncoder().encode(JSON.stringify(bounded)).length <= 8192,
    "record/UTF8 byte bounds",
  );
  check(
    bounded.dropped > 0 &&
      bounded.ambiguous > 0 &&
      bounded.records.every((entry) => entry.correlation.ambiguous),
    "explicit loss and concurrency ambiguity",
  );
  check(
    bounded.records.every(
      (entry) =>
        !("error" in entry) ||
        (entry.error.name === null && entry.error.errno === 6 && entry.error.textOmitted),
    ),
    "bounded error scalars omit arbitrary strings",
  );
  overlapping = false;
  const wide = fake(
    "query",
    Object.assign(new Error("omitted"), { errno: Number.MAX_SAFE_INTEGER }),
  );
  replaceManager(wide.manager);
  const wideObserver = observeContinuityLocks(wide.manager, () => ({
    activeJobs: Array.from({ length: 8 }, (_, i) => Number.MAX_SAFE_INTEGER - i),
    activeJobCount: 8,
  }));
  for (let i = 0; i < 16; i++) {
    const guard = await acquirePublicationGuard(
      "byte-bound",
      "exclusive",
      new AbortController().signal,
      true,
    );
    await guard.release().catch(() => {});
  }
  const wideSnapshot = wideObserver.snapshot();
  check(
    wideSnapshot.records.length < 32 &&
      wideSnapshot.dropped > 0 &&
      new TextEncoder().encode(JSON.stringify(wideSnapshot)).length <= 8192,
    "UTF8 byte limit evicts before record limit",
  );
  const broken = fake("success");
  replaceManager(broken.manager);
  const unavailable = observeContinuityLocks(broken.manager, () => {
    throw new Error("recorder fault");
  });
  const guard = await acquirePublicationGuard(
    "control",
    "exclusive",
    new AbortController().signal,
    true,
  );
  await guard.release();
  check(
    unavailable.snapshot().unavailable > 0 && broken.counts().queries === 1,
    "recorder failure preserves settlement",
  );
  const originalClone = globalThis.structuredClone;
  try {
    globalThis.structuredClone = () => {
      throw new Error("clone fault");
    };
    check(observer.snapshot().unavailable > 0, "clone fault counted");
    const guard = await acquirePublicationGuard(
      "clone-fault",
      "exclusive",
      new AbortController().signal,
      true,
    );
    await guard.release();
  } finally {
    globalThis.structuredClone = originalClone;
  }
  const evil = new Proxy(
    {},
    {
      get() {
        throw new Error("projection fault");
      },
    },
  );
  check(projectContinuityDiagnostic(evil).unavailable > 0, "projection unavailable");
  const rejected = fake("reject", evil);
  replaceManager(rejected.manager);
  const failedRecorder = observeContinuityLocks(rejected.manager, owner);
  await failureOf(
    acquirePublicationGuard("fault", "exclusive", new AbortController().signal, true),
    evil,
  );
  check(
    failedRecorder.snapshot().unavailable > 0 && rejected.counts().queries === 0,
    "error projection fault retains original failure without rescue query",
  );
  const frozen = Object.freeze({ request: nativeRequest, query: nativeQuery });
  check(
    observeContinuityLocks(frozen, owner).snapshot().unavailable > 0,
    "unavailable manager installation counted",
  );
  window.__continuityLocks = {
    snapshot() {
      throw evil;
    },
  };
  const evaluator = crossTabEvaluator();
  const answer = { success: true };
  check(
    evaluator.reply(answer).answer === answer &&
      evaluator.reply(answer).diagnostics.continuityLocks.unavailable > 0,
    "snapshot fault retains success answer",
  );
  window.__continuityLocks = { snapshot: () => bounded };
  const host = new StallDiagnostics();
  host.page(1, evaluator.reply(answer).diagnostics);
  check(
    host.current().evaluations.pages[0]?.evidence.continuityLocks.records.length,
    "existing host path retains typed variant",
  );
}
async function nativePositive(): Promise<void> {
  let requests = 0,
    queries = 0;
  Object.defineProperties(nativeManager, {
    request: {
      configurable: true,
      writable: true,
      value: new Proxy(nativeRequest, {
        apply(target, receiver, args) {
          requests++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    },
    query: {
      configurable: true,
      writable: true,
      value: new Proxy(nativeQuery, {
        apply(target, receiver, args) {
          queries++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    },
  });
  replaceManager(nativeManager);
  window.__crossTabEvaluator = crossTabEvaluator();
  installContinuityLockDiagnostic(() => ({
    activeJobs: window.__crossTabEvaluator.activeJobs(),
    activeJobCount: window.__crossTabEvaluator.activeCount(),
  }));
  const evaluator = window.__crossTabEvaluator;
  Reflect.set(globalThis, "__realLockGuard", async () => {
    const guard = await acquirePublicationGuard(
      "native-positive",
      "exclusive",
      new AbortController().signal,
      true,
    );
    await guard.release();
    const { control } = await import("../publication-cross-tab-browser.js");
    return control("exclusive");
  });
  evaluator.submit({
    id: "positive",
    job: 11,
    source: "return globalThis.__realLockGuard()",
    value: encodeCrossTabValue(null),
  });
  evaluator.stop();
  await evaluator.run();
  const answer = evaluator.take("positive");
  check(answer?.status === "pass", `real evaluator answer ${JSON.stringify(answer)}`);
  check(decodeCrossTabValue(answer.value) === true, "real original helper returns true");
  const phases = continuityDiagnosticSnapshot().records.map((entry) => entry.phase);
  check(
    phases.filter((phase) => phase === "callback-granted").length === 2 &&
      phases.filter((phase) => phase === "query-fulfilled").length === 2,
    "real Chromium guard/helper positive",
  );
  Reflect.deleteProperty(globalThis, "__realLockGuard");
  check(requests === 2 && queries === 2, "exact real native request/query counts");
}
async function runControls(): Promise<string[]> {
  const unhandled: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", listener);
  try {
    const labels = await helperControls();
    await guardFailures();
    await identityControls();
    await boundsAndFaults();
    await nativePositive();
    // A browser task boundary, without adding a timer to the diagnostic observer.
    await fetch(location.href);
    check(unhandled.length === 0, "no unhandled observer rejection");
    return labels.concat([
      "falsy-errors",
      "identities",
      "bounds-faults-host-path",
      "real-chromium-positive",
      "no-unhandled-rejection",
    ]);
  } finally {
    window.removeEventListener("unhandledrejection", listener);
    replaceManager(nativeManager);
    Object.defineProperties(nativeManager, {
      request: { configurable: true, writable: true, value: nativeRequest },
      query: { configurable: true, writable: true, value: nativeQuery },
    });
  }
}
Reflect.set(window, "__runContinuityControls", runControls);
