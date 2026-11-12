import assert from "node:assert/strict";
import { join } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { BrowserObservation } from "./browser-observation.js";
import type { ConsoleFailure, ConsoleSummary } from "./console-observation.js";
import type { DriverObservation, DriverObservationBinding } from "./driver.js";
import type { FixtureRequest, SuiteFixture } from "./fixture-owner.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { SafariDriver } from "./safari-driver.js";
import type { SuiteAdapter, SuiteResult } from "./suite-host.js";

export const lateConsoleModes = [
  "page-late-before-cutoff",
  "worker-late-before-cutoff",
  "page-late-after-cutoff",
  "worker-late-after-cutoff",
] as const;
export type LateConsoleMode = (typeof lateConsoleModes)[number];
export function isLateConsoleMode(mode: string): mode is LateConsoleMode {
  return lateConsoleModes.some((value) => value === mode);
}
export function beforeConsoleCutoff(mode: LateConsoleMode): boolean {
  return mode.endsWith("before-cutoff");
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const result = Promise.withResolvers<T>();
  const aborted = () => result.reject(signal.reason);
  signal.addEventListener("abort", aborted, { once: true });
  void promise.then(result.resolve, result.reject);
  try {
    return await result.promise;
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
function clean(summary: ConsoleSummary): void {
  assert.equal(summary.first, null);
  assert.equal(summary.loss, null);
}
type Event = { name: string; at: number };
/** Selected controls only. Decorations observe real reductions and public cutoffs. */
export class LateConsoleControl implements SuiteFixture {
  private readonly stopped = new AbortController();
  private readonly arrived = Promise.withResolvers<void>();
  private readonly released = Promise.withResolvers<void>();
  private readonly delivered = Promise.withResolvers<void>();
  private observation: DriverObservation | undefined;
  private origin = "";
  private deadline: number | undefined;
  private active = 0;
  private gates = 0;
  private armed = 0;
  private closes = 0;
  private markers = 0;
  private firstUnexpected: ConsoleFailure | null = null;
  private delivery: ConsoleFailure | null = null;
  private frozen: ConsoleSummary | undefined;
  private frozenUnchanged = false;
  private readonly events: Event[] = [];
  constructor(
    readonly mode: LateConsoleMode,
    readonly marker: string,
    private readonly source: "console-api" | "playwright-console",
    private readonly now = () => performance.now(),
  ) {
    void this.delivered.promise.catch(() => {});
  }
  private event(name: string): void {
    this.events.push({ name, at: this.now() });
  }
  private has(name: string): boolean {
    return this.events.some((event) => event.name === name);
  }
  async start({ origin, signal }: Parameters<SuiteFixture["start"]>[0]) {
    this.origin = origin;
    return [
      { path: "/console-late-gate", get: (request: FixtureRequest) => this.gate(request, signal) },
      { path: "/console-late-armed", get: (request: FixtureRequest) => this.arm(request, signal) },
    ];
  }
  private async gate(request: FixtureRequest, signal: AbortSignal) {
    assert.equal(++this.gates, 1);
    this.deadline = request.deadline;
    this.event("gate-arrived");
    this.arrived.resolve();
    this.active++;
    try {
      await wait(
        this.released.promise,
        AbortSignal.any([request.signal, signal, this.stopped.signal]),
      );
      return { released: true };
    } finally {
      this.active--;
    }
  }
  private async arm(request: FixtureRequest, signal: AbortSignal) {
    await wait(
      this.arrived.promise,
      AbortSignal.any([request.signal, signal, this.stopped.signal]),
    );
    assert.equal(++this.armed, 1);
    this.event("armed");
    return { armed: true };
  }
  async close(): Promise<void> {
    this.stopped.abort("late fixture closed");
    this.closes++;
    this.event("fixture-closed");
  }
  adapter(base: SuiteAdapter<{ mode: string; marker: string }>): typeof base {
    return {
      ...base,
      suite: `console-${this.mode}`,
      inventory: () => [
        {
          id: "console",
          label: this.mode,
          console: "fail-on-error",
          request: () => ({ mode: this.mode, marker: this.marker }),
        },
      ],
      fixture: { caseId: "console", create: () => this },
      policy: {
        listIds: () => ["console"],
        requireResult: true,
        check: (id, result) => {
          assert.equal(id, "console");
          assert.deepEqual(result, { body: "pass", mode: this.mode, marker: this.marker });
          assert.equal(this.gates, 1);
          assert.equal(this.armed, 1);
          this.event("body-pass");
        },
      },
      assets: async (context) => ({
        ...(await base.assets(context)),
        "/page.js": await browserBundle(join(import.meta.dir, "console-late-control-page.ts")),
      }),
    };
  }
  private remaining(): number {
    assert.ok(this.deadline !== undefined, "Gate not admitted");
    const remaining = this.deadline - this.now();
    assert.ok(remaining > 0, "Late control exceeded original case deadline");
    return remaining;
  }
  private release(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.stopped.signal.throwIfAborted();
    this.remaining();
    assert.ok(!this.has("gate-released"));
    this.event("gate-released");
    this.released.resolve();
  }
  private sameObservation(ledger: BrowserObservation): boolean {
    const summary = this.observation?.console?.();
    const candidate = ledger.console();
    return (
      !!summary &&
      (summary === candidate || (candidate.first !== null && candidate.first === summary.first))
    );
  }
  private validOrigin(failure: ConsoleFailure): void {
    assert.equal(failure.source, this.source);
    assert.equal(failure.text, this.marker);
    if (this.mode.startsWith("page-")) {
      assert.equal(failure.context, "page");
      return;
    }
    const worker = failure.context;
    assert.ok(worker !== "page" && worker.kind === "dedicated-worker");
    const url = new URL(worker.url);
    assert.equal(url.origin, this.origin);
    assert.equal(url.pathname, "/console-worker.js");
    assert.equal(url.searchParams.get("mode"), "worker-only");
    assert.equal(url.searchParams.get("marker"), this.marker);
  }
  private capture(
    ledger: BrowserObservation,
    context: string,
    failure: Omit<ConsoleFailure, "context">,
  ): void {
    if (!this.sameObservation(ledger)) return;
    const actual = {
      ...failure,
      text: failure.text.slice(0, 1024),
      context: context === "page" ? ("page" as const) : ledger.workerIdentity(context),
    };
    if (actual.text !== this.marker) {
      this.firstUnexpected ??= Object.freeze({
        text: actual.text,
        source: actual.source.slice(0, 64),
        context:
          actual.context === "page"
            ? "page"
            : Object.freeze({ ...actual.context, url: actual.context.url.slice(0, 2048) }),
      });
      this.delivered.reject(new Error(`Unexpected Console error: ${actual.text}`));
      return;
    }
    this.markers++;
    this.delivery ??= Object.freeze(actual);
    try {
      this.remaining();
      this.validOrigin(actual);
      assert.equal(this.markers, 1);
      assert.ok(this.has("body-pass") && this.has("gate-released"));
      assert.equal(this.has("cutoff-complete"), !beforeConsoleCutoff(this.mode));
      if (!beforeConsoleCutoff(this.mode)) assert.ok(this.has("frozen-summary-clean"));
      this.event("console-delivered");
      this.delivered.resolve();
    } catch (error) {
      this.delivered.reject(error);
    }
  }
  private decorate(observation: DriverObservation, binding: DriverObservationBinding): void {
    assert.ok(!this.observation, "More than one declared case observation");
    assert.equal(new URL(binding.expectedURL).origin, this.origin);
    this.observation = observation;
  }
  private async settle(
    original: () => Promise<void>,
    binding: DriverObservationBinding,
  ): Promise<void> {
    assert.ok(this.has("body-pass") && this.has("gate-arrived") && this.has("armed"));
    this.event("settle-entered");
    const signal = AbortSignal.any([
      binding.signal,
      this.stopped.signal,
      AbortSignal.timeout(Math.max(0, Math.ceil(this.remaining()))),
    ]);
    if (beforeConsoleCutoff(this.mode)) {
      this.release(signal);
      await wait(this.delivered.promise, signal);
      await original();
      this.event("cutoff-complete");
      return;
    }
    await original();
    this.event("cutoff-complete");
    const frozen = this.observation?.console?.();
    assert.ok(frozen);
    clean(frozen);
    this.frozen = frozen;
    this.event("frozen-summary-clean");
    this.release(signal);
    await wait(this.delivered.promise, signal);
    assert.equal(this.observation?.console?.(), frozen);
    clean(frozen);
    this.frozenUnchanged = true;
  }
  async run<T>(execute: () => Promise<T>): Promise<T> {
    const restore: (() => void)[] = [];
    const replace = <K extends "observe" | "consoleMessage" | "settleConsole">(
      object: object,
      key: K,
      value: unknown,
    ) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      restore.push(() => {
        if (descriptor) Object.defineProperty(object, key, descriptor);
        else Reflect.deleteProperty(object, key);
      });
      Object.defineProperty(object, key, {
        ...descriptor,
        value,
        configurable: true,
        writable: true,
      });
    };
    const wrap =
      (original: (binding: DriverObservationBinding) => Promise<DriverObservation>) =>
      async (binding: DriverObservationBinding) => {
        const observation = await original(binding);
        if (!binding.console) return observation;
        this.decorate(observation, binding);
        const settle = observation.settleConsole?.bind(observation);
        assert.ok(settle);
        replace(observation, "settleConsole", () => this.settle(settle, binding));
        return observation;
      };
    const capture = this.capture.bind(this);
    const original = BrowserObservation.prototype.consoleMessage;
    try {
      const pw = PlaywrightDriver.prototype.observe,
        safari = SafariDriver.prototype.observe;
      replace(
        PlaywrightDriver.prototype,
        "observe",
        function (this: PlaywrightDriver, binding: DriverObservationBinding) {
          return wrap(pw.bind(this))(binding);
        },
      );
      replace(
        SafariDriver.prototype,
        "observe",
        function (this: SafariDriver, binding: DriverObservationBinding) {
          return wrap(safari.bind(this))(binding);
        },
      );
      replace(
        BrowserObservation.prototype,
        "consoleMessage",
        function (
          this: BrowserObservation,
          context: string,
          failure: Omit<ConsoleFailure, "context">,
        ) {
          original.call(this, context, failure);
          capture(this, context, failure);
        },
      );
      return await execute();
    } finally {
      this.stopped.abort("late control teardown");
      for (const undo of restore.reverse()) undo();
    }
  }
  evidence() {
    const arrivedAt = this.events.find((event) => event.name === "gate-arrived")?.at;
    const releasedAt = this.events.find((event) => event.name === "gate-released")?.at;
    return {
      holdMs: arrivedAt !== undefined && releasedAt !== undefined ? releasedAt - arrivedAt : null,
      remainingAtReleaseMs:
        releasedAt !== undefined && this.deadline !== undefined ? this.deadline - releasedAt : null,
      mode: this.mode,
      marker: this.marker,
      origin: this.origin,
      deadline: this.deadline,
      gates: this.gates,
      armed: this.armed,
      active: this.active,
      closes: this.closes,
      markers: this.markers,
      firstUnexpected: this.firstUnexpected,
      delivery: this.delivery,
      frozenUnchanged: this.frozenUnchanged,
      events: this.events,
    };
  }
  checkEvidence(): void {
    assert.equal(this.gates, 1);
    assert.equal(this.armed, 1);
    assert.equal(this.active, 0);
    assert.equal(this.closes, 1);
    assert.equal(this.markers, 1);
    assert.equal(this.firstUnexpected, null);
    assert.ok(this.delivery);
    this.validOrigin(this.delivery);
    const expected = ["gate-arrived", "armed", "body-pass", "settle-entered"];
    const tail = beforeConsoleCutoff(this.mode)
      ? ["gate-released", "console-delivered", "cutoff-complete", "fixture-closed"]
      : [
          "cutoff-complete",
          "frozen-summary-clean",
          "gate-released",
          "console-delivered",
          "fixture-closed",
        ];
    assert.deepEqual(
      this.events.map((event) => event.name),
      expected.concat(tail),
    );
  }
  check(result: SuiteResult): void {
    assert.equal(result.exit, beforeConsoleCutoff(this.mode) ? 1 : 0, JSON.stringify(result));
    assert.deepEqual(result.failures, []);
    assert.equal(result.runComplete, true);
    assert.deepEqual(result.results.console, {
      body: "pass",
      mode: this.mode,
      marker: this.marker,
    });
    for (const value of Object.values(result.cleanup))
      if (typeof value === "object") assert.notEqual(value.status, "unconfirmed");
    for (const key of ["session", "server", "scratch", "fixture", "callbacks"] as const)
      assert.equal(result.cleanup[key].status, "confirmed");
    this.checkEvidence();
    const summary = result.documents.find((document) => document.group === "console")?.console;
    assert.ok(summary);
    assert.equal(summary.loss, null);
    const outcome = result.outcomes.console;
    if (beforeConsoleCutoff(this.mode)) {
      assert.ok(
        outcome?.status === "fail" &&
          outcome.detail.includes("Browser console error in ") &&
          outcome.detail.includes(this.marker),
      );
      assert.deepEqual(summary.first, this.delivery);
    } else {
      assert.ok(outcome?.status === "pass" && !outcome.provisional);
      assert.ok(this.frozenUnchanged && this.frozen);
      clean(summary);
      clean(this.frozen);
    }
  }
}
