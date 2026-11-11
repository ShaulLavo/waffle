import type { AssetOwner } from "./asset-owner.js";
import { bounded, type Driver, type DriverPressControl, type DriverObservation } from "./driver.js";
import { HostConsumers } from "./owned-consumers.js";
import {
  record,
  formatHostError,
  resultByteLimit,
  type Budgets,
  type HostCase,
  type HostKey,
  type HostPeer,
  type HostVerdict,
  type HostWorker,
  type HostWorkerCallback,
} from "./protocol.js";
import type { Collector, DocumentState, PeerTransition } from "./collector.js";

type ScriptMode = "host" | "body" | "peer-admission";
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
  private teardownUntil: number | undefined;
  private teardownStartedAt = 0;
  private bodyWork: { kind: "pending"; promise: Promise<unknown> } | { kind: "settled" } = {
    kind: "settled",
  };
  private containmentFailed = false;
  private bodyStartedAt = 0;
  private active = false;
  private uncertain = false;
  private delivered = false;
  private closed = false;
  private livenessProbe: Promise<void> | undefined;
  private readonly peerSignals = new Map<DocumentState, AbortController>();
  private readonly closes = new Map<DocumentState, Promise<void>>();
  private bodyFailure: { message: string; stack: string | null; details: unknown } | null = null;
  readonly transport: Omit<Driver, "press">;
  constructor(
    private readonly driver: Driver,
    private readonly collector: Collector,
    readonly state: DocumentState,
    private readonly consumers: HostConsumers,
    private readonly budgets: Budgets,
    private readonly started: number,
    private readonly signal: AbortSignal,
    private readonly configurePeer?: (state: DocumentState, lookupToken: string) => void,
    private readonly assets?: AssetOwner,
    private readonly observation?: DriverObservation,
  ) {
    this.body.signal.addEventListener("abort", () => this.beginTeardown(), { once: true });
    void observation?.failure.then((error) => this.fault(new ObservationFailure(error.message)));
    consumers.register(() => {
      this.closed = true;
      this.revoke();
    });
    const queue = <T>(callback: () => Promise<T>, signal: AbortSignal) =>
      abortable(this.enqueue(callback), signal);
    const isUncertain = () => this.uncertain || driver.uncertain;
    this.transport = {
      createWindow: (signal) => queue(() => driver.createWindow(signal), signal),
      selectWindow: (handle, signal) => queue(() => driver.selectWindow(handle, signal), signal),
      reloadWindow: (signal) => queue(() => driver.reloadWindow(signal), signal),
      closeWindow: (signal) => queue(() => driver.closeWindow(signal), signal),
      start: (signal) => queue(() => driver.start(signal), signal),
      navigate: (url, signal) => queue(() => driver.navigate(url, signal), signal),
      handle: (signal) => queue(() => driver.handle(signal), signal),
      handles: (signal) => queue(() => driver.handles(signal), signal),
      url: (signal) => queue(() => driver.url(signal), signal),
      script: (source, signal) =>
        this.execute(
          source,
          "host",
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
    this.observation?.check();
    if (performance.now() >= this.deadline && !this.body.signal.aborted)
      this.body.abort(new Error("Host setup/body timed out"));
    this.body.signal.throwIfAborted();
    if (!this.active) throw new Error("Host case capability revoked");
  }
  private guard(source: string, mode: ScriptMode, recovery: boolean, state = this.state): string {
    const phases =
      mode === "body"
        ? ["driving"]
        : mode === "peer-admission"
          ? ["admitting", "driving"]
          : ["admitting", "ready", "driving", "teardown", "terminal"];
    const identity = JSON.stringify({
      run: this.collector.run,
      token: state.token,
      doc: state.doc,
      caseId: state.group.caseIds[0],
      url: state.expectedURL,
      role: state.group.role,
      peer: state.owner.kind === "peer" ? state.owner.peer : null,
      generation: state.owner.kind === "peer" ? state.owner.generation : null,
    });
    return `const identity = ${identity};
const c = window.__suiteConfiguration, r = window.__pageRunner, h = window.__hostCase;
if (!c || !r || !h || c.run !== identity.run || c.token !== identity.token ||
 c.caseId !== identity.caseId || c.role !== identity.role || c.execution !== 'host' ||
 (identity.role === 'peer' && (c.peer !== identity.peer || c.generation !== identity.generation)) ||
 r.doc !== identity.doc || r.retired || location.href !== identity.url ||
 !${JSON.stringify(phases)}.includes(h.phase))
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
    mode: ScriptMode,
    signal = this.signal,
    beforeDispatch?: () => void,
    recovery = false,
    state = this.state,
    until = mode !== "host"
      ? this.operationDeadline()
      : Math.min(
          performance.now() + (this.budgets.operation ?? 15_000),
          recovery ? Infinity : this.started + this.budgets.run,
        ),
    transitioning = false,
  ): Promise<unknown> {
    const user = mode !== "host";
    const signals = [
      signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(until - performance.now()))),
    ];
    if (user) signals.push(this.body.signal);
    const operationSignal = AbortSignal.any(signals);
    const queued = this.enqueue(async () => {
      if (user) this.checkBody();
      try {
        return await this.boundCommand(
          source,
          mode,
          operationSignal,
          () => {
            this.infrastructure(recovery);
            this.checkTarget(state, until, transitioning);
            if (user) this.checkBody();
          },
          beforeDispatch,
          recovery,
          state,
        );
      } catch (error) {
        if (!(error instanceof ExpressionFailure) && error !== this.body.signal.reason)
          this.fault(error, state);
        else if (this.driver.uncertain) this.fault(error, state);
        throw error;
      }
    });
    return abortable(queued, operationSignal);
  }
  private async boundCommand(
    source: string,
    mode: ScriptMode,
    signal: AbortSignal,
    check: () => void,
    beforeDispatch?: () => void,
    recovery = false,
    state = this.state,
  ): Promise<unknown> {
    const request = <T>(send: () => Promise<T>) => this.checkedRequest(check, signal, send);
    await request(() => this.driver.selectWindow(state.handle, signal));
    if ((await request(() => this.driver.handle(signal))) !== state.handle)
      throw new Error("Host window handle changed");
    check();
    beforeDispatch?.();
    const value = await request(() =>
      this.driver.script(this.guard(source, mode, recovery, state), signal),
    );
    if (!record(value)) throw new Error("Malformed bound command answer");
    if (value.kind === "binding-error") throw new Error("Host document binding changed");
    if (value.kind === "reporter-error")
      throw new ObservationFailure(`Page reporting failed: ${String(value.error)}`);
    if (value.kind === "expression-error" && typeof value.error === "string")
      throw new ExpressionFailure(value.error);
    if (value.kind !== "void" && (value.kind !== "value" || !("value" in value)))
      throw new Error("Invalid bound command answer");
    return value.kind === "void" ? undefined : value.value;
  }
  private async checkedRequest<T>(
    check: () => void,
    signal: AbortSignal,
    send: () => Promise<T>,
  ): Promise<T> {
    const value = await this.consumers.invoke(() => {
      check();
      signal.throwIfAborted();
      return send();
    });
    check();
    signal.throwIfAborted();
    return value;
  }
  private async workers() {
    this.checkBody();
    if (!this.observation)
      throw new Error("Browser observation was not declared before navigation");
    await this.execute("", "body");
    this.checkBody();
    return this.observation.workers();
  }
  private press(key: HostKey): Promise<void> {
    if (key !== "Home" && key !== "ArrowUp" && key !== "ArrowRight" && key !== "Enter")
      throw new TypeError("Unsupported host key");
    this.checkBody();
    const until = this.operationDeadline();
    const signal = AbortSignal.any([
      this.signal,
      this.body.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(until - performance.now()))),
    ]);
    return abortable(
      this.enqueue(() => this.pressEntry(key, until, signal)),
      signal,
    );
  }
  private async pressEntry(key: HostKey, until: number, signal: AbortSignal): Promise<void> {
    let open = true;
    let busy = false;
    let active: Promise<unknown> | undefined;
    let failure: { error: unknown } | undefined;
    const ignoreDrainRejection = () => undefined;
    const check = () => {
      if (!open) throw new Error("Driver press dispatch lease closed");
      this.checkBody();
      this.checkTarget(this.state, until);
      signal.throwIfAborted();
    };
    const fail = (error: unknown) => {
      failure ??= { error };
      this.fault(error);
    };
    const dispatch = <T>(send: () => Promise<T>): Promise<T> => {
      if (!open) return Promise.reject(new Error("Driver press dispatch lease closed"));
      if (busy) {
        const error = new Error("Overlapping driver press dispatch");
        fail(error);
        return Promise.reject(error);
      }
      busy = true;
      const result = this.consumers.invoke(async () => {
        await this.boundCommand("", "body", signal, check);
        const value = await this.checkedRequest(check, signal, send);
        await this.boundCommand("", "body", signal, check);
        return value;
      });
      active = result;
      const settled = () => {
        busy = false;
        active = undefined;
      };
      void result.then(settled, (error: unknown) => {
        settled();
        fail(error);
      });
      return result;
    };
    const control: DriverPressControl = { signal, dispatch };
    try {
      check();
      await this.driver.press(key, control);
    } catch (error) {
      open = false;
      fail(error);
    } finally {
      open = false;
      if (active) {
        fail(new Error("Driver press settled with an active dispatch"));
        await active.catch(ignoreDrainRejection);
      }
    }
    if (failure) throw failure.error;
    this.checkBody();
    this.checkTarget(this.state, until);
  }
  private bodyLimit(): number {
    return Math.min(
      this.started + this.budgets.run,
      this.state.startedAt + (this.budgets.caseDocument ?? this.budgets.group),
    );
  }
  private setTimeout(timeoutMs: number): void {
    this.checkBody();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("Host timeout must be positive and finite");
    this.deadline = Math.min(this.bodyStartedAt + timeoutMs, this.bodyLimit());
    this.checkBody();
  }
  private operationDeadline(): number {
    return Math.min(
      this.budgets.operation === undefined ? Infinity : performance.now() + this.budgets.operation,
      this.bodyLimit(),
    );
  }
  private checkTarget(state: DocumentState, until: number, transitioning = false): void {
    if (performance.now() >= until) throw new ExpressionFailure("Host operation timed out");
    if (
      !this.collector.owns(state) ||
      state.cutoff !== null ||
      (!transitioning && state.physical !== "live")
    )
      throw new Error("Peer generation revoked");
  }
  private fault(error: unknown, state = this.state): void {
    if (!this.uncertain && !this.closed && this.state.cutoff === null)
      this.collector.fail("host-command", String(error), state);
    this.uncertain ||=
      !(error instanceof ObservationFailure) &&
      !(this.signal.aborted && error === this.signal.reason && !this.driver.uncertain);
    this.body.abort(error);
  }
  async admit(): Promise<void> {
    for (;;) {
      const accepted = await this.execute(
        "if (h.phase === 'admitting') return false; if (h.phase !== 'ready') throw new Error('Host receiver admission repeated'); h.phase = 'driving'; return true;",
        "host",
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
  private async task(command: (operation: string) => string, state = this.state): Promise<void> {
    const until = this.operationDeadline();
    this.checkBody();
    const operation = crypto.randomUUID();
    await abortable(
      this.execute(
        command(operation),
        "body",
        this.signal,
        () => this.collector.registerTask(state, operation),
        false,
        state,
        until,
      ),
      this.body.signal,
    );
    for (;;) {
      this.checkBody();
      this.checkTarget(state, until);
      const task = state.tasks.get(operation);
      if (task?.status === "pass") return;
      if (task?.status === "fail") throw new ExpressionFailure(task.error);
      await this.sleep(10);
    }
  }
  private async sleep(ms: number): Promise<void> {
    this.checkBody();
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid host sleep");
    const wakeAt = performance.now() + ms;
    do {
      const waiting = Promise.withResolvers<void>();
      const delay = Math.max(0, Math.min(wakeAt, this.deadline) - performance.now());
      const timer = setTimeout(waiting.resolve, Math.min(delay, 2_147_483_647));
      try {
        await abortable(waiting.promise, this.body.signal);
      } finally {
        clearTimeout(timer);
      }
      this.checkBody();
    } while (performance.now() < wakeAt);
  }

  private beginTeardown(): void {
    if (this.teardownUntil === undefined) {
      this.teardownStartedAt = performance.now();
      this.teardownUntil = Math.min(
        this.teardownStartedAt + (this.budgets.teardown ?? this.budgets.case),
        this.started + this.budgets.run,
      );
    }
    this.assets?.revoke(this.state);
  }
  teardownDeadline(): number {
    if (this.teardownUntil === undefined) throw new Error("Host teardown has not started");
    return this.teardownUntil;
  }
  teardownSignal(): AbortSignal {
    return AbortSignal.timeout(Math.max(1, Math.ceil(this.teardownDeadline() - performance.now())));
  }
  private async joinBodyAndAssets(): Promise<void> {
    const until = this.teardownDeadline();
    const body =
      this.bodyWork.kind === "pending"
        ? this.bodyWork.promise.then(
            () => {},
            () => {},
          )
        : Promise.resolve();
    const peerObservations = this.collector.documents.filter(
      (state) => state.owner.kind === "peer" && state.owner.coordinator === this.state,
    );
    const joined = await Promise.all(
      [
        bounded(body, Math.max(0, until - performance.now()), "host body join").then(
          () => true,
          () => false,
        ),
        this.assets?.join(this.state, until) ?? true,
        this.observation
          ? bounded(
              this.observation.stop(),
              Math.max(0, until - performance.now()),
              "browser observation detach and callback join",
            ).then(
              () => true,
              () => false,
            )
          : true,
      ].concat(
        peerObservations.map((state) =>
          bounded(
            this.collector.observation(state)?.stop() ?? Promise.resolve(),
            Math.max(0, until - performance.now()),
            "peer lifecycle drain",
          ).then(
            () => true,
            () => false,
          ),
        ),
      ),
    );
    if (joined.every(Boolean) && performance.now() <= until) return;
    this.containmentFailed = true;
    this.collector.fail(
      "host-work-unconfirmed",
      "Actual host body or asset work outlived teardown",
      this.state,
    );
  }
  revoke(): void {
    this.observation?.revokeActions();
    this.beginTeardown();
    this.active = false;
    for (const controller of this.peerSignals.values())
      controller.abort(new Error("Host case capability revoked"));
    if (!this.body.signal.aborted) this.body.abort(new Error("Host case capability revoked"));
  }
  uncontainedPageWork(): boolean {
    if (
      this.containmentFailed ||
      this.bodyWork.kind === "pending" ||
      this.assets?.pending(this.state)
    )
      return true;
    return this.uncontainedPageTasks();
  }
  private uncontainedPageTasks(): boolean {
    if (
      this.collector.transitions.some(
        (transition) =>
          transition.caseId === this.state.group.caseIds[0] &&
          transition.progress.kind !== "completed",
      )
    )
      return true;
    if (
      this.collector.documents.some(
        (state) =>
          state.owner.kind === "peer" &&
          state.owner.coordinator === this.state &&
          !["closed", "superseded"].includes(state.physical),
      )
    )
      return true;
    if (
      this.collector.documents.some(
        (state) =>
          this.collector.owns(state) &&
          !["closed", "superseded"].includes(state.physical) &&
          Array.from(state.tasks.values()).some((task) => task.status === "pending"),
      )
    )
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
    return {
      caseId: this.state.group.caseIds[0],
      body: this.bodyFailure,
      assets: this.assets?.errors(this.state),
      pendingBody: this.bodyWork.kind === "pending",
      pendingAssets: this.assets?.pending(this.state) ?? false,
      containmentFailed: this.containmentFailed,
      teardownClock:
        this.teardownUntil === undefined
          ? null
          : { startedAt: this.teardownStartedAt, deadline: this.teardownUntil },
    };
  }
  async drive(callback: (host: HostCase) => Promise<unknown>): Promise<void> {
    const caseId = this.state.group.caseIds[0];
    if (!caseId) throw new Error("Missing host case ID");
    const priorFailures = this.collector.failures.length;
    const stop = () => this.body.abort(this.signal.reason);
    this.signal.addEventListener("abort", stop, { once: true });
    const monitor = setInterval(() => {
      const overdue = this.collector.deadline(this.budgets, this.started);
      if (overdue && !this.livenessProbe) {
        const state = this.collector.overdueDocument(this.budgets) ?? this.state;
        this.collector.fail(overdue, "Host case infrastructure deadline", state);
        this.body.abort(new Error(overdue));
        this.livenessProbe = this.probe(state).then((category) => {
          if (category !== "responsive") this.collector.fail(category, overdue, state);
        });
      }
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
      this.assets?.bind(this.state, () => this.checkBody());
      this.bodyStartedAt = performance.now();
      this.deadline = Math.min(this.bodyStartedAt + this.budgets.case, this.bodyLimit());
      const host: HostCase = {
        workers: () => this.workers(),
        onWorker: (callback) => {
          this.checkBody();
          return this.workerObservation(this.state).onWorker(callback);
        },
        waitForWorkerClose: (worker) => this.waitForWorkerClose(this.state, worker),
        onRequest: (callback) => {
          this.checkBody();
          if (!this.observation)
            throw new Error("Browser observation was not declared before navigation");
          return this.observation.onRequest((url) => {
            this.checkBody();
            return callback(url);
          });
        },
        holdAsset: (path, callback) => {
          this.checkBody();
          if (!this.assets) throw new Error("Asset response owner unavailable");
          this.assets.hold(this.state, path, callback);
        },
        openPeer: () => this.openPeer(),
        signal: this.body.signal,
        remainingMs: () => Math.max(0, this.deadline - performance.now()),
        setTimeout: (timeoutMs) => this.setTimeout(timeoutMs),
        script: (source) => {
          this.checkBody();
          return abortable(this.execute(source, "body"), this.body.signal);
        },
        press: (key, ...extra: unknown[]) => {
          if (extra.length) throw new TypeError("Host press accepts only a key");
          return this.press(key);
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
      this.bodyWork = { kind: "pending", promise: returned };
      const settled = () => {
        this.bodyWork = { kind: "settled" };
      };
      void returned.then(settled, settled);
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
    const delivery = this.closeRemainingPeers().then(async () => {
      if (this.uncontainedPageTasks())
        this.collector.fail(
          "page-task-unconfirmed",
          "Page task outlived its host waiter",
          this.state,
        );
      await this.deliver(verdict);
      await this.recoverTeardown();
    });
    const completed = await Promise.allSettled([
      delivery,
      this.livenessProbe,
      delivery.then(() => this.joinBodyAndAssets()),
    ]);
    const failure = completed.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (this.uncontainedPageWork())
      this.collector.fail(
        "page-task-unconfirmed",
        "Page task or host work outlived its host waiter",
        this.state,
      );
  }

  private workerObservation(state: DocumentState): DriverObservation {
    const observation =
      this.collector.observation(state) ?? (state === this.state ? this.observation : undefined);
    if (!observation) throw new Error("Browser observation was not declared before navigation");
    return observation;
  }
  private waitForWorkerClose(state: DocumentState, worker: HostWorker): Promise<void> {
    return abortable(this.workerObservation(state).waitForWorkerClose(worker), this.body.signal);
  }
  private peerCapability(state: DocumentState): HostPeer {
    const controller = new AbortController();
    this.peerSignals.set(state, controller);
    const valid = () => {
      this.checkBody();
      controller.signal.throwIfAborted();
      this.checkTarget(state, this.operationDeadline());
    };
    return Object.freeze({
      signal: controller.signal,
      workers: async () => {
        valid();
        await this.execute("", "body", this.signal, undefined, false, state);
        return this.workerObservation(state).workers();
      },
      onWorker: (callback: HostWorkerCallback) => {
        valid();
        return this.workerObservation(state).onWorker(callback);
      },
      waitForWorkerClose: (worker: HostWorker) => this.waitForWorkerClose(state, worker),
      script: (source: string) => {
        valid();
        return abortable(
          this.execute(source, "body", this.signal, undefined, false, state),
          this.body.signal,
        );
      },
      task: (source: string) => {
        valid();
        return this.task(
          (operation) => `h.task(${JSON.stringify(operation)}, ${JSON.stringify(source)});`,
          state,
        );
      },
      reload: () => {
        valid();
        return this.reloadPeer(state);
      },
      close: () => {
        const prior = this.closes.get(state);
        if (prior) return prior;
        valid();
        return this.closePeer(state, false);
      },
    });
  }
  private probeLive(signal: AbortSignal, until: number): boolean {
    return (
      !signal.aborted &&
      performance.now() < until &&
      !this.closed &&
      !this.uncertain &&
      !this.driver.uncertain
    );
  }
  private probe(state: DocumentState): Promise<string> {
    const until = Math.min(
      performance.now() + 4000,
      this.deadline,
      this.teardownUntil ?? Infinity,
      this.started + this.budgets.run,
    );
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(until - performance.now()))),
    ]);
    const operation = this.enqueue(async () => {
      try {
        if (!this.probeLive(signal, until)) return "driver-lost";
        const handles = await this.driver.handles(signal);
        if (!this.probeLive(signal, until)) return "driver-lost";
        if (!handles.includes(state.handle)) return "page-closed";
        await this.driver.selectWindow(state.handle, signal);
        if (!this.probeLive(signal, until)) return "driver-lost";
        const handle = await this.driver.handle(signal);
        if (!this.probeLive(signal, until)) return "driver-lost";
        if (handle !== state.handle) return "page-reloaded";
        const url = await this.driver.url(signal);
        if (!this.probeLive(signal, until)) return "driver-lost";
        if (url !== state.expectedURL) return "page-reloaded";
        const value = await this.driver.script("return window.__pageRunner || null", signal);
        if (!this.probeLive(signal, until)) return "driver-lost";
        return record(value) && value.doc === state.doc ? "responsive" : "page-reloaded";
      } catch {
        return "driver-lost";
      }
    });
    return abortable(operation, signal).catch(() => "driver-lost");
  }
  private checkTransition(transition: PeerTransition, signal: AbortSignal, cleanup = false): void {
    signal.throwIfAborted();
    if (performance.now() >= transition.deadline)
      throw new Error("Peer transition operation timed out");
    this.infrastructure(cleanup);
    if (!cleanup) this.checkBody();
  }
  private async barrier(transition: PeerTransition, cleanup: boolean): Promise<number> {
    const state = transition.source;
    const signal = cleanup
      ? AbortSignal.timeout(Math.max(1, Math.ceil(transition.deadline - performance.now())))
      : this.signal;
    await this.execute(
      `h.prepareTransition(${JSON.stringify(transition.id)});`,
      cleanup ? "host" : "body",
      signal,
      undefined,
      cleanup,
      state,
      transition.deadline,
      true,
    );
    for (;;) {
      const observed = await this.execute(
        `const t=h.transition, r=window.__pageRunner;
return t && t.id === ${JSON.stringify(transition.id)} && t.acknowledgedThrough !== null &&
 r.pending === 0 && !r.failure && t.acknowledgedThrough === r.ackedThrough ? r.ackedThrough : null;`,
        cleanup ? "host" : "body",
        signal,
        undefined,
        cleanup,
        state,
        transition.deadline,
        true,
      );
      if (typeof observed === "number") return observed;
      await abortable(Bun.sleep(10), signal);
    }
  }
  private async transitionCommand<T>(
    transition: PeerTransition,
    cleanup: boolean,
    action: (signal: AbortSignal, before: readonly string[]) => Promise<T>,
  ): Promise<T> {
    const watermark = await this.barrier(transition, cleanup);
    const until = transition.deadline;
    const signal = AbortSignal.any([
      cleanup ? new AbortController().signal : this.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(until - performance.now()))),
    ]);
    return abortable(
      this.enqueue(async () => {
        this.infrastructure(cleanup);
        if (!cleanup) this.checkBody();
        this.checkTarget(transition.source, until, true);
        await this.driver.selectWindow(transition.source.handle, signal);
        this.infrastructure(cleanup);
        if (!cleanup) this.checkBody();
        this.checkTarget(transition.source, until, true);
        if ((await this.driver.handle(signal)) !== transition.source.handle)
          throw new Error("Transition source handle changed");
        this.infrastructure(cleanup);
        if (!cleanup) this.checkBody();
        const before = await this.driver.handles(signal);
        this.infrastructure(cleanup);
        if (!cleanup) this.checkBody();
        this.checkTarget(transition.source, until, true);
        if (!before.includes(transition.source.handle) || !before.includes(this.state.handle))
          throw new Error("Transition source or coordinator handle missing");
        const verified = await this.driver.script(
          this.guard(
            `const r=window.__pageRunner, t=h.transition;
return t && t.id === ${JSON.stringify(transition.id)} && t.acknowledgedThrough === ${watermark} &&
 r.ackedThrough === ${watermark} && r.pending === 0 && !r.failure;`,
            "host",
            cleanup,
            transition.source,
          ),
          signal,
        );
        this.infrastructure(cleanup);
        if (!cleanup) this.checkBody();
        this.checkTarget(transition.source, until, true);
        if (!record(verified) || verified.kind !== "value" || verified.value !== true)
          throw new Error("Transition source barrier changed");
        this.collector.executeTransition(transition, watermark);
        try {
          return await action(signal, before);
        } catch (error) {
          transition.progress = { kind: "failed", detail: String(error) };
          transition.source.physical = "unconfirmed";
          this.fault(error, transition.source);
          throw error;
        }
      }),
      signal,
    );
  }
  private configure(state: DocumentState): void {
    if (!this.configurePeer) throw new Error("Host peer configuration unavailable");
    const token = new URL(state.expectedURL).searchParams.get("token");
    if (!token) throw new Error("Missing peer lookup token");
    this.configurePeer(state, token);
  }
  private async admitPeer(state: DocumentState, transition: PeerTransition): Promise<HostPeer> {
    for (;;) {
      this.checkBody();
      this.checkTarget(state, transition.deadline);
      if (state.doc && state.ready) break;
      await this.sleep(10);
    }
    for (;;) {
      // Receipt precedes the page's ACK; only this probe may observe admission.
      const ready = await this.execute(
        "return h.phase === 'driving' && window.__pageRunner.pending === 0;",
        "peer-admission",
        this.signal,
        undefined,
        false,
        state,
        transition.deadline,
      );
      if (ready === true) break;
      await this.sleep(10);
    }
    this.collector.completeTransition(transition, state.handle, state, null);
    return this.peerCapability(state);
  }
  private async observePeer(
    state: DocumentState,
    signal: AbortSignal,
    bootstrapped = false,
  ): Promise<void> {
    if (!this.observation) return;
    const observe = this.driver.observe?.bind(this.driver);
    if (!observe) throw new Error("Peer browser observation unavailable");
    const bootstrapURL = `${new URL(state.expectedURL).origin}/_waffle_observation_bootstrap?token=${state.token}`;
    if (!bootstrapped) await this.driver.navigate(bootstrapURL, signal);
    const observation = await observe({
      window: state.handle,
      bootstrapURL,
      expectedURL: state.expectedURL,
      signal: this.signal,
      consumers: this.consumers,
    });
    this.collector.bindObservation(
      state,
      observation,
      this.consumers,
      () => this.teardownUntil ?? this.deadline,
    );
    void observation.failure.then((error) =>
      this.fault(new ObservationFailure(error.message), state),
    );
  }
  private async openPeer(): Promise<HostPeer> {
    this.checkBody();
    const transition = this.collector.prepareTransition(
      this.state,
      "create",
      this.operationDeadline(),
    );
    if (transition.action !== "create") throw new Error("Wrong peer creation action");
    const { peer, token } = transition.target;
    const url = new URL(transition.target.url);
    const state = await this.transitionCommand(transition, false, async (signal, before) => {
      this.checkBody();
      this.checkTransition(transition, signal);
      const handle = await this.driver.createWindow(signal);
      this.checkBody();
      this.checkTransition(transition, signal);
      const handles = await this.driver.handles(signal);
      this.checkBody();
      if (
        before.includes(handle) ||
        !handles.includes(handle) ||
        before.some((item) => !handles.includes(item))
      )
        throw new Error("Created handle is not a fresh owned peer");
      const state = this.collector.expectPeer(
        this.state,
        peer,
        0,
        token,
        url.href,
        handle,
        transition,
      );
      this.checkTransition(transition, signal);
      this.configure(state);
      await this.driver.selectWindow(handle, signal);
      this.checkBody();
      this.checkTransition(transition, signal);
      await this.observePeer(state, signal);
      await this.driver.navigate(url.href, signal);
      this.collector.observation(state)?.navigationComplete();
      this.checkBody();
      return state;
    });
    const capability = await this.admitPeer(state, transition);
    await this.execute("h.transition = null;", "body");
    return capability;
  }
  private async reloadPeer(state: DocumentState): Promise<HostPeer> {
    this.checkBody();
    if (state.owner.kind !== "peer") throw new Error("Not a peer");
    const transition = this.collector.prepareTransition(state, "reload", this.operationDeadline());
    if (transition.action !== "reload") throw new Error("Wrong reload action");
    this.peerSignals.get(state)?.abort(new Error("Peer generation superseded"));
    const previous = this.collector.observation(state);
    const { successor, workers } = await this.transitionCommand(
      transition,
      false,
      async (signal) => {
        const successor = this.collector.expectPeer(
          this.state,
          transition.target.peer,
          transition.target.generation,
          transition.target.token,
          transition.target.url,
          state.handle,
          transition,
        );
        this.checkTransition(transition, signal);
        this.configure(successor);
        this.checkTransition(transition, signal);
        const workers = previous?.workers() ?? [];
        if (previous) {
          const bootstrapURL = `${new URL(successor.expectedURL).origin}/_waffle_observation_bootstrap?token=${successor.token}`;
          previous.beginDocumentClose(bootstrapURL);
          await this.driver.navigate(bootstrapURL, signal);
        } else await this.driver.reloadWindow(signal);
        this.checkTransition(transition, signal);
        if ((await this.driver.handle(signal)) !== state.handle)
          throw new Error("Reload changed peer handle");
        return { successor, workers };
      },
    );
    if (previous) await this.finishObservedReload(transition, successor, previous, workers);
    const capability = await this.admitPeer(successor, transition);
    if (successor.doc === state.doc) throw new Error("Reload retained old document");
    return capability;
  }
  private async finishObservedReload(
    transition: PeerTransition,
    successor: DocumentState,
    previous: DriverObservation,
    workers: readonly HostWorker[],
  ): Promise<void> {
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(transition.deadline - performance.now()))),
    ]);
    try {
      await abortable(
        Promise.all(workers.map((worker) => previous.waitForWorkerClose(worker))).then(() =>
          previous.stop(),
        ),
        signal,
      );
      await abortable(
        this.enqueue(() => this.resumeObservedReload(transition, successor, signal)),
        signal,
      );
    } catch (error) {
      transition.progress = { kind: "failed", detail: String(error) };
      transition.source.physical = "unconfirmed";
      this.fault(error, transition.source);
      throw error;
    }
  }
  private async resumeObservedReload(
    transition: PeerTransition,
    successor: DocumentState,
    signal: AbortSignal,
  ): Promise<void> {
    this.checkTransition(transition, signal);
    this.checkTarget(successor, transition.deadline);
    if (transition.progress.kind !== "executing") throw new Error("Reload is not executing");
    await this.driver.selectWindow(successor.handle, signal);
    this.checkTransition(transition, signal);
    const handles = await this.driver.handles(signal);
    this.checkTransition(transition, signal);
    if (!handles.includes(successor.handle) || !handles.includes(this.state.handle))
      throw new Error("Reload peer or coordinator handle missing");
    const bootstrapURL = `${new URL(successor.expectedURL).origin}/_waffle_observation_bootstrap?token=${successor.token}`;
    if ((await this.driver.handle(signal)) !== successor.handle)
      throw new Error("Reload changed peer handle");
    this.checkTransition(transition, signal);
    if ((await this.driver.url(signal)) !== bootstrapURL)
      throw new Error("Reload bootstrap document changed");
    this.checkTransition(transition, signal);
    await this.observePeer(successor, signal, true);
    this.checkTransition(transition, signal);
    await this.driver.navigate(successor.expectedURL, signal);
    this.collector.observation(successor)?.navigationComplete();
    this.checkTransition(transition, signal);
  }
  private closePeer(state: DocumentState, cleanup: boolean): Promise<void> {
    const prior = this.closes.get(state);
    if (prior) return prior;
    const until = cleanup
      ? Math.min(
          performance.now() + Math.min(this.budgets.operation ?? 15_000, 15_000),
          this.teardownDeadline(),
        )
      : this.operationDeadline();
    const transition = this.collector.prepareTransition(state, "close", until);
    this.peerSignals.get(state)?.abort(new Error("Peer closed"));
    const observation = this.collector.observation(state);
    const workers = observation?.workers() ?? [];
    const closing = this.transitionCommand(transition, cleanup, async (signal, before) => {
      this.infrastructure(cleanup);
      if (!cleanup) this.checkBody();
      this.checkTransition(transition, signal, cleanup);
      this.collector.observation(state)?.beginDocumentClose();
      await this.driver.closeWindow(signal);
      this.checkTransition(transition, signal, cleanup);
      const remaining = await this.driver.handles(signal);
      if (
        remaining.includes(state.handle) ||
        before.some((handle) => handle !== state.handle && !remaining.includes(handle))
      )
        throw new Error("Exact peer close not confirmed");
      this.collector.completeTransition(transition, state.handle, null, remaining);
    });
    const completed = closing.then(async () => {
      if (!observation) return;
      await bounded(
        Promise.all(workers.map((worker) => observation.waitForWorkerClose(worker))),
        Math.max(0, until - performance.now()),
        "owned peer browser Worker close",
      );
    });
    this.closes.set(state, completed);
    return completed;
  }
  private async closeRemainingPeers(): Promise<void> {
    const peers = this.collector.documents.filter(
      (state) =>
        state.owner.kind === "peer" &&
        state.owner.coordinator === this.state &&
        state.physical === "live",
    );
    for (const state of peers) {
      try {
        await this.closePeer(state, true);
      } catch (error) {
        this.collector.fail("peer-cleanup", String(error), state);
      }
    }
  }
  private async recoverTeardown(): Promise<void> {
    const signal = this.teardownSignal();
    while (this.state.host?.kind !== "terminal") {
      const observed = await this.execute(
        "return {phase:h.phase, failure:window.__pageRunner.failure};",
        "host",
        signal,
        undefined,
        true,
        this.state,
        this.teardownDeadline(),
      );
      if (record(observed) && observed.phase === "terminal" && observed.failure)
        throw new ObservationFailure(`Teardown reporting failed: ${String(observed.failure)}`);
      await abortable(Bun.sleep(10), signal);
    }
  }
  private async deliver(verdict: HostVerdict): Promise<void> {
    if (this.delivered) throw new Error("Host verdict already delivered");
    if (this.pending) {
      this.infrastructure(true);
      await abortable(this.tail, this.teardownSignal());
    }
    await this.execute(
      `h.verdict(${JSON.stringify(verdict)}, ${performance.timeOrigin + this.teardownDeadline()});`,
      "host",
      this.teardownSignal(),
      () => {
        this.delivered = true;
      },
      true,
      this.state,
      this.teardownDeadline(),
    );
  }
}
