import { expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { OpfsCloseArmResult } from "./opfs-close-browser-runner.js";
import type { OpfsClosePage, OpfsCloseRequest } from "./opfs-close-browser.js";

const scenarios = [
  "clean",
  "late-undefined",
  "late-false",
  "late-error",
  "late-messageerror",
  "late-duplicate",
  "late-unowned",
  "terminate-throw",
  "dispatch-undefined",
  "dispatch-timeout",
  "dispatch-exhausted",
] as const;
const selected = process.env.OPFS_OBSERVER_SCENARIO;
const trace: string[] = [];
const lateError = new Error("labelled late observer error");
const terminationError = new Error("labelled termination call error");
let lateReason: unknown;
let elapsed = 0;
let activePageIndex = 0;
const pages: StandInPage[] = [];
const nativeSetTimeout = globalThis.setTimeout;

class StandInOriginal extends EventEmitter {
  constructor(readonly token: string) {
    super();
  }
  url(): string {
    return `/opfs-close-worker.js?token=${this.token}`;
  }
  async evaluate(): Promise<string> {
    return new URL(this.url(), "http://observer.invalid/").href;
  }
}
class StandInDOMWorker extends EventTarget {
  readonly original: StandInOriginal;
  readonly token: string;
  constructor(url: string) {
    super();
    this.token = new URL(url, "http://observer.invalid").searchParams.get("token")!;
    this.original = new StandInOriginal(this.token);
    const page = pages[activePageIndex];
    assert(page);
    page.workers.push(this);
    page.announce(this.original);
  }
  postMessage(request: OpfsCloseRequest): void {
    trace.push(`${this.token}:${request.command.kind}`);
    const reply = { id: request.id, status: "ok", receipt: { standIn: true } };
    this.dispatchEvent(new MessageEvent("message", { data: reply }));
    if (this.token !== "owner" || request.command.kind !== "inspect") return;
    if (selected?.startsWith("late-")) this.lateFailure(reply);
  }
  lateFailure(reply: unknown): void {
    trace.push("late-failure-after-owner-reply");
    if (selected === "late-duplicate" || selected === "late-unowned") {
      const data = selected === "late-duplicate" ? reply : { id: 999, status: "ok", receipt: {} };
      this.dispatchEvent(new MessageEvent("message", { data }));
      return;
    }
    if (selected === "late-messageerror") {
      lateReason = new MessageEvent("messageerror", { data: "labelled invalid transfer" });
      assert(lateReason instanceof MessageEvent);
      this.dispatchEvent(lateReason);
      return;
    }
    lateReason = lateError;
    if (selected === "late-undefined") lateReason = undefined;
    if (selected === "late-false") lateReason = false;
    const event = new Event("error");
    Object.defineProperty(event, "error", { value: lateReason });
    this.dispatchEvent(event);
  }
  terminate(): void {
    trace.push(`terminate:${this.token}`);
    if (selected === "terminate-throw" && this.token === "owner") throw terminationError;
    if (selected === "dispatch-timeout" && this.token === "probe") return;
    if (selected === "dispatch-undefined" && this.token === "probe") {
      nativeSetTimeout(() => this.original.emit("close"), 0);
      return;
    }
    this.original.emit("close");
  }
}
class StandInPage {
  readonly workers: StandInDOMWorker[] = [];
  api!: OpfsClosePage;
  announce: (original: StandInOriginal) => void = () => undefined;
  dispatches = 0;
  on(_event: string, listener: (original: StandInOriginal) => void): void {
    this.announce = listener;
  }
  url(): string {
    return "http://observer.invalid/";
  }
  async goto(): Promise<void> {
    activePageIndex = pages.indexOf(this);
    const realm = { opfsClose: undefined };
    Object.defineProperty(globalThis, "window", { configurable: true, value: realm });
    await import(`./fixtures/opfs-close-page.ts?observer-realm=${pages.indexOf(this)}`);
    assert(realm.opfsClose);
    this.api = realm.opfsClose;
  }
  async evaluate(action: (...args: unknown[]) => unknown, value: unknown): Promise<unknown> {
    activePageIndex = pages.indexOf(this);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { opfsClose: this.api },
    });
    if (!String(action).includes("terminateAll")) return action(value);
    this.dispatches++;
    const response = action(value);
    if (pages.indexOf(this) !== 0) return response;
    if (selected?.startsWith("dispatch-")) {
      this.announce(new StandInOriginal("missing"));
      const afterMissing = new StandInOriginal("after-missing");
      this.announce(afterMissing);
      afterMissing.emit("close");
    }
    if (selected === "dispatch-exhausted") elapsed = 45_000;
    if (selected === "dispatch-undefined" || selected === "dispatch-exhausted") throw undefined;
    if (selected === "dispatch-timeout") return new Promise(() => undefined);
    return response;
  }
}
class StandInLifecycle {
  readonly scratch = "labelled-no-filesystem-allocation";
  async init(): Promise<void> {}
  async directory(): Promise<string> {
    return "labelled-no-profile";
  }
  serve(): string {
    return "http://observer.invalid/";
  }
  async persistent(): Promise<{ newPage(): Promise<StandInPage> }> {
    return { newPage: async () => newPage() };
  }
  async closeContext(): Promise<void> {}
  async close(): Promise<void> {
    trace.push("lifecycle-close");
    for (const page of pages) closePage(page);
  }
}
function newPage(): StandInPage {
  const page = new StandInPage();
  pages.push(page);
  return page;
}
function closePage(page: StandInPage): void {
  for (const worker of page.workers) worker.original.emit("close");
}
function installStandIns(): void {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: StandInDOMWorker });
  Object.defineProperty(performance, "now", { configurable: true, value: () => elapsed });
  const timer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> =>
    nativeSetTimeout(
      () => {
        elapsed += delay;
        callback();
      },
      (selected?.startsWith("dispatch-") || selected === "terminate-throw") &&
        trace.filter((value) => value === "probe:probe").length === 2
        ? 0
        : delay,
    );
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: timer });
  mock.module("./browser-runner-lifecycle.js", () => ({
    BrowserRunnerLifecycle: StandInLifecycle,
    browserBundle: async () => "labelled-no-bundle",
    engines: { chromium: {} },
  }));
}
function observerFailures(result: OpfsCloseArmResult): unknown[] {
  return result.receipts.flatMap((receipt) => {
    const failures: unknown = receipt.observerFailures;
    return Array.isArray(failures) ? failures : [];
  });
}
function checkLateFailure(result: OpfsCloseArmResult): void {
  assert.notEqual(result.status, "observations-complete", "F1 late error must prevent success");
  const failures = observerFailures(result);
  assert.equal(failures.length, 1, "F1 export one unexpected per-original failure");
  assert(trace.indexOf("probe:probe") < trace.indexOf("late-failure-after-owner-reply"));
  assert.equal(trace.filter((value) => value === "probe:probe").length, 2);
  assert(trace.includes("terminate:probe"), "safe sibling must still be terminated");
  const diagnostic = JSON.stringify(failures);
  assert(diagnostic.includes('"token":"owner"'));
  if (selected === "late-undefined") assert(diagnostic.includes('"type":"undefined"'));
  if (selected === "late-error") assert(diagnostic.includes(lateError.message));
  if (selected === "late-false") assert(diagnostic.includes('"type":"boolean","value":"false"'));
  if (selected === "late-messageerror") assert(diagnostic.includes("messageerror"));
  if (selected === "late-duplicate" || selected === "late-unowned")
    assert(diagnostic.includes("Unowned or duplicate Worker reply"));
}
function checkJoins(result: OpfsCloseArmResult): void {
  const originals = result.workers.slice(0, 4);
  assert.equal(originals.length, 4);
  assert.equal(pages[0]?.dispatches, 1, "F2 intervention dispatch is never retried");
  const joins = result.operations.filter((operation) =>
    operation.phase.startsWith("exact original join"),
  );
  assert.equal(joins.length, 4, "F2 both registered originals need awaited join outcomes");
  for (const original of originals) assert(original.join, "F2 explicit per-original join receipt");
  assert(result.primaryErrors.length, "dispatch error must remain independent");
  if (selected === "dispatch-exhausted") {
    assert(originals.every((original) => JSON.stringify(original.join).includes("rejected")));
    return;
  }
  assert.equal(joins[0]?.state, "fulfilled", "already-resolved original is still awaited");
  if (selected === "dispatch-undefined") assert.equal(joins[1]?.state, "fulfilled");
  assert(JSON.stringify(originals[2]?.join).includes("rejected"), "missing original is explicit");
  assert.equal(joins[3]?.state, "fulfilled", "safe original after a missing join is awaited");
  if (selected === "dispatch-timeout") {
    assert(result.cleanupErrors.length, "missing original join must have its own failure");
    assert(JSON.stringify(originals[1]?.join).includes("rejected"));
  }
}
async function scenario(): Promise<void> {
  installStandIns();
  const { runOpfsCloseArm } = await import("./opfs-close-browser-runner.js");
  const result = await runOpfsCloseArm("chromium", "native-success");
  if (selected?.startsWith("late-")) checkLateFailure(result);
  else if (selected?.startsWith("dispatch-")) checkJoins(result);
  else if (selected === "terminate-throw") {
    assert(trace.includes("terminate:probe"), "F1 safe sibling after one terminate throws");
    assert.notEqual(result.status, "observations-complete");
  } else {
    assert.equal(result.status, "observations-complete");
    assert.equal(observerFailures(result).length, 0, "intentional cancellation is not unexpected");
  }
  const owner = pages[0]?.api;
  assert(owner);
  if (
    selected === "late-error" ||
    selected === "late-undefined" ||
    selected === "late-false" ||
    selected === "late-messageerror"
  ) {
    const rejected = await Promise.allSettled([owner.request("owner", { kind: "close" })]);
    assert.equal(rejected[0]?.status, "rejected");
    if (rejected[0]?.status === "rejected") assert(Object.is(rejected[0].reason, lateReason));
  }
  console.log(
    JSON.stringify({
      scenario: selected,
      labelledStandInsOnly: true,
      status: result.status,
      trace,
    }),
  );
}
if (selected) await scenario();
else
  test.each(scenarios)(
    "actual observer source with labelled stand-ins: %s",
    async (name) => {
      const child = Bun.spawn([process.execPath, import.meta.path], {
        env: { ...process.env, OPFS_OBSERVER_SCENARIO: name },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ status, stdout, stderr }).toEqual({
        status: 0,
        stdout: expect.any(String),
        stderr: "",
      });
    },
    10_000,
  );
