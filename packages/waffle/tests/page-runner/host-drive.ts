import { bounded, type Driver } from "./driver.js";
import {
  record,
  resultByteLimit,
  type Budgets,
  type HostCase,
  type HostVerdict,
} from "./protocol.js";
import type { Collector, DocumentState } from "./collector.js";

/** A revoked capability cannot stop arbitrary callback code. Cleanup joins its actual settlement. */
export class HostConsumers {
  private readonly pending = new Set<Promise<void>>();
  private readonly revokers = new Set<() => void>();
  invoke<T>(callback: () => T | PromiseLike<T>): Promise<T> {
    const result = Promise.withResolvers<T>();
    const settled = result.promise.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    try {
      result.resolve(callback());
    } catch (error) {
      result.reject(error);
    }
    return result.promise;
  }
  register(revoke: () => void): void {
    this.revokers.add(revoke);
  }
  revoke(): void {
    for (const revoke of this.revokers) revoke();
  }
  async join(ms: number): Promise<boolean> {
    this.revoke();
    try {
      await bounded(Promise.all(this.pending), ms, "host callback and command join");
      return this.pending.size === 0;
    } catch {
      return false;
    }
  }
}
class ExpressionFailure extends Error {}
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
  private readonly body = new AbortController();
  private deadline = Infinity;
  private active = false;
  private uncertain = false;
  private delivered = false;
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
    consumers.register(() => this.revoke());
    const queue = <T>(callback: () => Promise<T>, signal: AbortSignal) =>
      abortable(this.enqueue(callback), signal);
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
        return driver.uncertain;
      },
    };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const next = this.consumers.invoke(() => previous.then(operation));
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private infrastructure(recovery = false): void {
    if (!recovery) this.signal.throwIfAborted();
    if (!recovery && performance.now() - this.started >= this.budgets.run)
      throw new Error("Absolute run deadline");
    if (this.driver.uncertain || this.uncertain) throw new Error("Uncertain host dispatch");
    if (this.collector.active !== this.state || this.state.cutoff !== null)
      throw new Error("Host document observation closed");
  }
  private checkBody(): void {
    if (performance.now() >= this.deadline && !this.body.signal.aborted)
      this.body.abort(new Error("Host setup/body timed out"));
    this.body.signal.throwIfAborted();
    if (!this.active) throw new Error("Host case capability revoked");
  }
  private guard(source: string, user: boolean): string {
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
        const value = await this.driver.script(this.guard(source, user), signal);
        this.infrastructure(recovery);
        if (!record(value)) throw new Error("Malformed bound command answer");
        if (value.kind === "binding-error") throw new Error("Host document binding changed");
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
    if (!this.uncertain) this.collector.fail("host-command", String(error), this.state);
    this.uncertain = true;
    this.body.abort(error);
  }
  async admit(): Promise<void> {
    for (;;) {
      const accepted = await this.execute(
        "if (h.phase === 'admitting') return false; if (h.phase !== 'ready') throw new Error('Host receiver admission repeated'); h.phase = 'driving'; return true;",
        false,
      );
      if (accepted === true) return;
      const overdue = this.collector.deadline(this.budgets, this.started);
      if (overdue || this.collector.failures.length)
        throw new Error(overdue ?? "Host admission failed");
      await Bun.sleep(25);
    }
  }
  private async task(source: string): Promise<void> {
    this.checkBody();
    const operation = crypto.randomUUID();
    await abortable(
      this.execute(
        `h.task(${JSON.stringify(operation)}, ${JSON.stringify(source)});`,
        true,
        this.signal,
        () => this.collector.registerTask(this.state, operation),
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
    return record(result) && record(result.teardown) && result.teardown.status === "timeout";
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
        task: (source) => this.task(source),
        sleep: (ms) => this.sleep(ms),
      };
      const returned = this.consumers.invoke(() => callback(host));
      this.checkBody();
      const result = await abortable(returned, this.body.signal);
      this.checkBody();
      const evidence = compact(result);
      this.checkBody();
      verdict = { status: "pass", result: evidence };
    } catch (error) {
      verdict = { status: "fail", error: String(error).slice(0, 16_384) };
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
    if (this.delivered) throw new Error("Host verdict already delivered");
    this.delivered = true;
    const deliverySignal = AbortSignal.any([this.signal, AbortSignal.timeout(5000)]);
    if (!this.signal.aborted)
      await this.execute(`h.verdict(${JSON.stringify(verdict)});`, false, deliverySignal);
    else
      await this.execute(
        `h.verdict(${JSON.stringify(verdict)});`,
        false,
        AbortSignal.timeout(5000),
        undefined,
        true,
      );
  }
}
