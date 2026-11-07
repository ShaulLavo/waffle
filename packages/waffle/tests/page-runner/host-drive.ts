import { HostConsumers } from "./owned-consumers.js";
import { type Driver } from "./driver.js";
import {
  record,
  formatHostError,
  resultByteLimit,
  type Budgets,
  type HostCase,
  type HostVerdict,
} from "./protocol.js";
import type { Collector, DocumentState } from "./collector.js";

class ExpressionFailure extends Error {}
class ObservationFailure extends Error {}
function compact(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > resultByteLimit)
    throw new ExpressionFailure("Host callback must return compact serializable evidence");
  return JSON.parse(encoded);
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const abort = Promise.withResolvers<never>();
  const listener = () => abort.reject(signal.reason);
  signal.addEventListener("abort", listener, { once: true });
  try {
    return await Promise.race([promise, abort.promise]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
export class HostDrive {
  private tail = Promise.resolve();
  private pending = 0;
  private readonly body = new AbortController();
  private deadline = Infinity;
  private active = false;
  private uncertain = false;
  private delivered = false;
  private closed = false;
  private bodyFailure: { message: string; stack: string | null; details: unknown } | null = null;
  readonly transport: Driver;
  constructor(
    private readonly driver: Driver,
    private readonly collector: Collector,
    readonly state: DocumentState,
    private readonly consumers: HostConsumers,
    private readonly budgets: Budgets,
    private readonly started: number,
    private readonly signal: AbortSignal,
  ) {
    consumers.register(() => {
      this.closed = true;
      this.revoke();
    });
    const queue = <T>(callback: () => Promise<T>, signal: AbortSignal) =>
      abortable(this.enqueue(callback), signal);
    const isUncertain = () => this.uncertain || driver.uncertain;
    this.transport = {
      start: (signal) => queue(() => driver.start(signal), signal),
      navigate: (url, signal) => queue(() => driver.navigate(url, signal), signal),
      handle: (signal) => queue(() => driver.handle(signal), signal),
      handles: (signal) => queue(() => driver.handles(signal), signal),
      url: (signal) => queue(() => driver.url(signal), signal),
      script: (source, signal) =>
        this.execute(
          source,
          false,
          signal,
          undefined,
          this.signal.aborted && signal !== this.signal,
        ),
      stop: () => driver.stop(),
      get uncertain() {
        return isUncertain();
      },
    };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    this.pending++;
    const next = this.consumers.invoke(() => previous.then(operation));
    this.tail = next.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return next;
  }
  private infrastructure(recovery = false): void {
    if (this.closed) throw new Error("Host command owner stopped");
    if (!recovery) this.signal.throwIfAborted();
    if (!recovery) {
      const overdue = this.collector.deadline(this.budgets, this.started);
      if (overdue) throw new ObservationFailure(overdue);
      if (this.collector.failures.length) throw new ObservationFailure("Sticky host failure");
    }
    if (this.driver.uncertain || this.uncertain) throw new Error("Uncertain host dispatch");
    if (this.collector.active !== this.state || this.state.cutoff !== null)
      throw new Error("Host document observation closed");
  }
  private checkBody(): void {
    this.infrastructure();
    if (performance.now() >= this.deadline && !this.body.signal.aborted)
      this.body.abort(new Error("Host setup/body timed out"));
    this.body.signal.throwIfAborted();
    if (!this.active) throw new Error("Host case capability revoked");
  }
  private guard(source: string, user: boolean, recovery: boolean): string {
    const identity = JSON.stringify({
      run: this.collector.run,
      token: this.state.token,
      doc: this.state.doc,
      caseId: this.state.group.caseIds[0],
      url: this.state.expectedURL,
    });
    return `const identity = ${identity};
const c = window.__suiteConfiguration, r = window.__pageRunner, h = window.__hostCase;
if (!c || !r || !h || c.run !== identity.run || c.token !== identity.token ||
 c.caseId !== identity.caseId || c.role !== 'case' || c.execution !== 'host' ||
 r.doc !== identity.doc || r.retired || location.href !== identity.url ||
 !${JSON.stringify(user ? ["driving"] : ["admitting", "ready", "driving", "teardown", "terminal"])}.includes(h.phase))
 return {kind:'binding-error'};
if (!${JSON.stringify(recovery)} && r.failure) return {kind:'reporter-error', error:String(r.failure)};
try {
 const value = new Function("h", "window", "location", ${JSON.stringify(source)})(h, window, location);
 if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); return {kind:'expression-error', error:'Use host.task for asynchronous work'}; }
 return value === undefined ? {kind:'void'} : {kind:'value', value};
} catch (error) {return {kind:'expression-error',error:String(error).slice(0,16384)};}`;
  }
  private execute(
    source: string,
    user: boolean,
    signal = this.signal,
    beforeDispatch?: () => void,
    recovery = false,
  ): Promise<unknown> {
    const queued = this.enqueue(async () => {
      if (user) this.checkBody();
      try {
        this.infrastructure(recovery);
        if ((await this.driver.handle(signal)) !== this.state.handle)
          throw new Error("Host window handle changed");
        this.infrastructure(recovery);
        if (user) this.checkBody();
        beforeDispatch?.();
        if (user) this.checkBody();
        const value = await this.driver.script(this.guard(source, user, recovery), signal);
        this.infrastructure(recovery);
        if (!record(value)) throw new Error("Malformed bound command answer");
        if (value.kind === "binding-error") throw new Error("Host document binding changed");
        if (value.kind === "reporter-error")
          throw new ObservationFailure(`Page reporting failed: ${String(value.error)}`);
        if (value.kind === "expression-error" && typeof value.error === "string")
          throw new ExpressionFailure(value.error);
        if (value.kind !== "void" && (value.kind !== "value" || !("value" in value)))
          throw new Error("Invalid bound command answer");
        if (user) this.checkBody();
        return value.kind === "void" ? undefined : value.value;
      } catch (error) {
        if (!(error instanceof ExpressionFailure) && error !== this.body.signal.reason)
          this.fault(error);
        else if (this.driver.uncertain) this.fault(error);
        throw error;
      }
    });
    return abortable(queued, signal);
  }
  private fault(error: unknown): void {
    if (!this.uncertain && !this.closed && this.state.cutoff === null)
      this.collector.fail("host-command", String(error), this.state);
    this.uncertain ||=
      !(error instanceof ObservationFailure) &&
      !(this.signal.aborted && error === this.signal.reason && !this.driver.uncertain);
    this.body.abort(error);
  }
  async admit(): Promise<void> {
    for (;;) {
      const accepted = await this.execute(
        "if (h.phase === 'admitting') return false; if (h.phase !== 'ready') throw new Error('Host receiver admission repeated'); h.phase = 'driving'; return true;",
        false,
      );
      if (accepted === true) {
        this.infrastructure();
        return;
      }
      const overdue = this.collector.deadline(this.budgets, this.started);
      if (overdue || this.collector.failures.length)
        throw new Error(overdue ?? "Host admission failed");
      await Bun.sleep(25);
    }
  }
  private async allocateDatabase(prefix: string): Promise<string> {
    this.checkBody();
    if (!prefix || prefix.length > 900) throw new Error("Invalid database prefix");
    const name = `${prefix}-${this.collector.run}`;
    await this.task(
      (operation) => `h.allocateDatabase(${JSON.stringify(operation)}, ${JSON.stringify(name)});`,
    );
    this.checkBody();
    return name;
  }
  private async task(command: (operation: string) => string): Promise<void> {
    this.checkBody();
    const operation = crypto.randomUUID();
    await abortable(
      this.execute(command(operation), true, this.signal, () =>
        this.collector.registerTask(this.state, operation),
      ),
      this.body.signal,
    );
    for (;;) {
      this.checkBody();
      const task = this.state.tasks.get(operation);
      if (task?.status === "pass") return;
      if (task?.status === "fail") throw new ExpressionFailure(task.error);
      await this.sleep(10);
    }
  }
  private sleep(ms: number): Promise<void> {
    this.checkBody();
    if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new Error("Invalid host sleep"));
    const waiting = Promise.withResolvers<void>();
    const timer = setTimeout(
      waiting.resolve,
      Math.min(ms, Math.max(0, this.deadline - performance.now())),
    );
    return abortable(waiting.promise, this.body.signal)
      .then(() => this.checkBody())
      .finally(() => clearTimeout(timer));
  }
  revoke(): void {
    this.active = false;
    if (!this.body.signal.aborted) this.body.abort(new Error("Host case capability revoked"));
  }
  uncontainedPageWork(): boolean {
    if (Array.from(this.state.tasks.values()).some((task) => task.status === "pending"))
      return true;
    const result = this.collector.results[this.state.group.caseIds[0] ?? ""];
    return (
      record(result) &&
      record(result.teardown) &&
      result.teardown.status === "timeout" &&
      result.teardown.settled === false
    );
  }
  failureEvidence(): unknown {
    return { caseId: this.state.group.caseIds[0], body: this.bodyFailure };
  }
  async drive(callback: (host: HostCase) => Promise<unknown>): Promise<void> {
    const caseId = this.state.group.caseIds[0];
    if (!caseId) throw new Error("Missing host case ID");
    const priorFailures = this.collector.failures.length;
    const stop = () => this.body.abort(this.signal.reason);
    this.signal.addEventListener("abort", stop, { once: true });
    const monitor = setInterval(() => {
      const overdue = this.collector.deadline(this.budgets, this.started);
      if (overdue) this.collector.fail(overdue, "Host case infrastructure deadline", this.state);
      if (overdue || this.collector.failures.length > priorFailures)
        this.body.abort(new Error(overdue ?? "Sticky host failure"));
      if (performance.now() >= this.deadline)
        this.body.abort(new Error("Host setup/body timed out"));
    }, 25);
    let verdict: HostVerdict;
    try {
      this.infrastructure();
      this.active = true;
      this.collector.beginHost(this.state, caseId);
      this.deadline = performance.now() + this.budgets.case;
      const host: HostCase = {
        signal: this.body.signal,
        remainingMs: () =>
          Math.max(0, Math.min(this.deadline, this.started + this.budgets.run) - performance.now()),
        script: (source) => {
          this.checkBody();
          return abortable(this.execute(source, true), this.body.signal);
        },
        task: (source) =>
          this.task(
            (operation) => `h.task(${JSON.stringify(operation)}, ${JSON.stringify(source)});`,
          ),
        allocateDatabase: (prefix) => this.allocateDatabase(prefix),
        sleep: (ms) => this.sleep(ms),
      };
      this.checkBody();
      const returned = this.consumers.invoke(() => callback(host));
      this.checkBody();
      const result = await abortable(returned, this.body.signal);
      this.checkBody();
      const evidence = compact(result);
      this.checkBody();
      verdict = { status: "pass", result: evidence };
    } catch (error) {
      if (error instanceof ObservationFailure) this.fault(error);
      const message = String(error);
      this.bodyFailure = {
        message,
        stack: error instanceof Error ? (error.stack ?? null) : null,
        details: error,
      };
      verdict = { status: "fail", error: formatHostError(message) };
    } finally {
      clearInterval(monitor);
      this.signal.removeEventListener("abort", stop);
      this.revoke();
    }
    this.collector.results[caseId] = { body: verdict, teardown: { status: "not-entered" } };
    if (this.uncontainedPageWork())
      this.collector.fail(
        "page-task-unconfirmed",
        "Page task outlived its host waiter",
        this.state,
      );
    await this.deliver(verdict);
    if (this.signal.aborted || this.collector.failures.length) await this.recoverTeardown();
  }
  private async recoverTeardown(): Promise<void> {
    const signal = AbortSignal.timeout((this.budgets.teardown ?? this.budgets.case) + 10_000);
    while (this.state.host?.kind !== "terminal") {
      const observed = await this.execute(
        "return {phase:h.phase, failure:window.__pageRunner.failure};",
        false,
        signal,
        undefined,
        true,
      );
      if (record(observed) && observed.phase === "terminal" && observed.failure)
        throw new ObservationFailure(`Teardown reporting failed: ${String(observed.failure)}`);
      await abortable(Bun.sleep(10), signal);
    }
  }
  private async deliver(verdict: HostVerdict): Promise<void> {
    if (this.delivered) throw new Error("Host verdict already delivered");
    if (this.pending) {
      this.infrastructure();
      await abortable(this.tail, this.signal);
    }
    await this.execute(
      `h.verdict(${JSON.stringify(verdict)});`,
      false,
      AbortSignal.timeout(5000),
      () => {
        this.delivered = true;
      },
      true,
    );
  }
}
