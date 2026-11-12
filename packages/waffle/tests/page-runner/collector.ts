import { bounded, type DriverObservation } from "./driver.js";
import type { HostConsumers } from "./owned-consumers.js";
import { reportingFailure, type HostReply } from "./report-control.js";
import { ReportChunks, type ReportAck } from "./report-chunks.js";
import {
  exactInventory,
  sameStorageEntry,
  parseMessage,
  record,
  resultByteLimit,
  type Body,
  type Budgets,
  type Failure,
  type Message,
  type Outcome,
} from "./protocol.js";
import { sameWorkerEntry, type WorkerAttempt } from "./service-worker-page.js";
import type { ServiceWorkerEntry, StorageEntry } from "../storage-allocation.js";
export type CollectorPolicy = {
  listIds(value: unknown): string[];
  allocation?: (entry: StorageEntry, runningCaseIds: readonly string[], run: string) => void;
  requireResult?: boolean;
  check(caseId: string, result: unknown): void;
};
export class ObservationClosed extends Error {}
export class ReportRejected extends Error {}
export type Group = {
  id: string;
  role: "list" | "case" | "finish" | "peer";
  caseIds: string[];
  execution?: "host";
};
export type HostPhase =
  | { kind: "awaiting-ready" | "ready" }
  | { kind: "driving"; startedAt: number }
  | { kind: "teardown"; enteredAt: number }
  | { kind: "terminal" };
type PageTask = { status: "pending" } | { status: "pass" } | { status: "fail"; error: string };
type DocumentOwner =
  | { kind: "coordinator" }
  | {
      kind: "peer";
      coordinator: DocumentState;
      peer: string;
      generation: number;
      admission: PeerTransition;
    };
type PhysicalDisposition = "live" | "transitioning" | "superseded" | "closed" | "unconfirmed";
type PeerTarget = {
  readonly peer: string;
  readonly generation: number;
  readonly token: string;
  readonly url: string;
};
export type PeerTransition = {
  readonly run: string;
  id: string;
  caseId: string;
  source: DocumentState;
  deadline: number;
  progress:
    | { kind: "accepted"; watermark: number | null }
    | { kind: "executing"; watermark: number }
    | {
        kind: "completed";
        handle: string;
        successor: DocumentState | null;
        remainingHandles: readonly string[] | null;
      }
    | { kind: "failed"; detail: string };
} & ({ action: "create" | "reload"; target: PeerTarget } | { action: "close"; target: null });
export type DocumentState = {
  owner: DocumentOwner;
  physical: PhysicalDisposition;
  group: Group;
  token: string;
  expectedURL: string;
  handle: string;
  startedAt: number;
  doc: string | null;
  heartbeatAt: number;
  messages: string[];
  complete: boolean;
  terminalAt: number | null;
  ready: boolean;
  retiring: boolean;
  cutoff: number | null;
  final: boolean;
  listed: boolean;
  host: HostPhase | null;
  tasks: Map<string, PageTask>;
};
export class Collector {
  private bootstrapArrivals = new WeakSet<DocumentState>();
  private readonly bootstrapClosed = new WeakSet<DocumentState>();
  private readonly bootstrapWaiters = new Map<
    DocumentState,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  private bootstrapDocument(token: string): DocumentState {
    const state = this.documents.find((item) => item.token === token);
    if (
      !state ||
      !this.owns(state) ||
      state.cutoff !== null ||
      state.physical !== "live" ||
      state.doc !== null ||
      this.bootstrapClosed.has(state) ||
      this.reply(false, state).kind !== "live"
    )
      throw new ObservationClosed("Bootstrap arrival is not the exact live document");
    return state;
  }
  bootstrapArrived(token: string): void {
    const state = this.bootstrapDocument(token);
    if (this.bootstrapArrivals.has(state))
      throw new ObservationClosed("Duplicate bootstrap arrival");
    this.bootstrapArrivals.add(state);
    this.bootstrapWaiters.get(state)?.resolve();
  }
  async waitForBootstrap(state: DocumentState, signal: AbortSignal): Promise<void> {
    if (this.bootstrapDocument(state.token) !== state)
      throw new ObservationClosed("Unrelated bootstrap document");
    if (signal.aborted) {
      this.bootstrapClosed.add(state);
      this.bootstrapArrivals.delete(state);
      signal.throwIfAborted();
    }
    if (this.bootstrapArrivals.has(state)) return;
    if (this.bootstrapWaiters.has(state))
      throw new ObservationClosed("Bootstrap arrival waiter already owned");
    const waiting = Promise.withResolvers<void>();
    const aborted = () => waiting.reject(signal.reason);
    this.bootstrapWaiters.set(state, waiting);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      await waiting.promise;
      signal.throwIfAborted();
      this.bootstrapDocument(state.token);
    } catch (error) {
      this.bootstrapClosed.add(state);
      this.bootstrapArrivals.delete(state);
      throw error;
    } finally {
      signal.removeEventListener("abort", aborted);
      this.bootstrapWaiters.delete(state);
    }
  }
  private readonly observations = new Map<
    DocumentState,
    {
      observation: DriverObservation;
      consumers: HostConsumers;
      deadline: () => number;
      pending: number;
    }
  >();
  bindObservation(
    state: DocumentState,
    observation: DriverObservation | undefined,
    consumers: HostConsumers,
    deadline: () => number,
  ): void {
    if (!observation) return;
    if (!this.owns(state) || this.observations.has(state))
      throw new Error("Observation owner already bound or unrelated");
    this.observations.set(state, { observation, consumers, deadline, pending: 0 });
  }
  observation(state: DocumentState): DriverObservation | undefined {
    return this.observations.get(state)?.observation;
  }
  async workerCloseQuery(value: unknown): Promise<void> {
    if (
      !record(value) ||
      value.run !== this.run ||
      typeof value.token !== "string" ||
      typeof value.url !== "string"
    )
      throw new ObservationClosed("Unbound Worker close query");
    const state = this.documents.find((item) => item.token === value.token);
    const owner = state && this.observations.get(state);
    if (
      !state ||
      !owner ||
      !state.doc ||
      state.doc !== value.doc ||
      state.expectedURL !== value.documentURL ||
      !this.owns(state) ||
      state.cutoff !== null ||
      state.physical !== "live" ||
      state.complete ||
      state.retiring ||
      !["driving", "teardown"].includes(this.active?.host?.kind ?? "") ||
      this.reply(false, state).kind !== "live"
    )
      throw new ObservationClosed("Worker close query is not the exact live document");
    try {
      owner.observation.check();
    } catch (error) {
      throw new ObservationClosed("Worker close query observation is not active", { cause: error });
    }
    const ms = owner.deadline() - this.now();
    if (ms <= 0 || owner.pending >= 4096)
      throw new ObservationClosed("Worker close query admission expired or full");
    const workerURL = value.url;
    owner.pending++;
    try {
      await owner.consumers.invoke(() =>
        bounded(owner.observation.waitForWorkerURLClose(workerURL), ms, "Worker close query"),
      );
    } finally {
      owner.pending--;
    }
  }
  readonly outcomes: Record<string, Outcome> = {};
  readonly results: Record<string, unknown> = {};
  readonly failures: Failure[] = [];
  readonly ledger: StorageEntry[] = [];
  readonly documents: DocumentState[] = [];
  readonly transitions: PeerTransition[] = [];
  private worker: { caseId: string; entry: ServiceWorkerEntry } | undefined;
  workerScriptScope(url: URL): string | undefined {
    const entry = this.worker?.entry;
    return entry?.scriptURL === url.href ? entry.name : undefined;
  }
  isWorkerScript(path: string): boolean {
    return this.worker !== undefined && new URL(this.worker.entry.scriptURL).pathname === path;
  }
  private workerAttempt: { state: DocumentState; attempt: WorkerAttempt } | undefined;
  declareWorker(caseId: string, entry: ServiceWorkerEntry): void {
    if (this.worker) throw new Error("Duplicate service worker declaration");
    this.worker = { caseId, entry };
  }
  get registrationAttempts(): WorkerAttempt[] {
    const saved = this.workerAttempt;
    if (!saved) return [];
    if (saved.attempt.state === "admitted" && saved.state.cutoff !== null)
      return [{ entry: saved.attempt.entry, state: "unconfirmed" }];
    return [{ ...saved.attempt }];
  }

  admitFixture(token: string, doc: string, caseId: string): DocumentState {
    const state = this.documents.find((item) => item.token === token);
    if (
      !state ||
      state !== this.active ||
      state.doc !== doc ||
      state.cutoff !== null ||
      state.complete ||
      state.group.role !== "case" ||
      state.group.caseIds[0] !== caseId ||
      state.owner.kind !== "coordinator" ||
      this.outcomes[caseId]?.status !== "running"
    )
      throw new ObservationClosed("Fixture capability is not the live exact case document");
    return state;
  }
  private reporting:
    | { kind: "live" | "cancelled" | "cleanup-failed" }
    | { kind: "cleanup"; document: DocumentState } = { kind: "live" };
  private readonly reports = new ReportChunks();
  private readonly reportingFailed = new Set<DocumentState>();
  cancel(): void {
    for (const waiting of this.bootstrapWaiters.values())
      waiting.reject(new ObservationClosed("Bootstrap arrival cancelled"));
    this.bootstrapWaiters.clear();
    this.bootstrapArrivals = new WeakSet();
    this.reports.clear();
    this.reporting = {
      kind:
        this.reporting.kind === "cleanup" || this.reporting.kind === "cleanup-failed"
          ? "cleanup-failed"
          : "cancelled",
    };
  }
  reply(retire = false, state?: DocumentState): HostReply {
    if (this.reporting.kind === "live") return { kind: "live", retire };
    if (this.reporting.kind !== "cleanup") return { kind: "cancelled" };
    const cleanup = this.reporting.document;
    return state === cleanup && this.owns(cleanup) && cleanup.cutoff === null
      ? { kind: "live", retire }
      : { kind: "cancelled" };
  }
  active: DocumentState | undefined;
  runComplete = false;
  remaining: StorageEntry[] | null = null;
  constructor(
    readonly run: string,
    readonly required: string[],
    readonly selected: string[],
    readonly policy: CollectorPolicy,
    readonly now = () => performance.now(),
  ) {
    exactInventory(required, required);
    for (const id of required) this.outcomes[id] = { status: "pending" };
  }
  fail(category: string, detail: string, state = this.active): void {
    this.cancel();
    const document =
      state?.owner.kind === "peer"
        ? {
            document: {
              doc: state.doc,
              peer: state.owner.peer,
              generation: state.owner.generation,
              handle: state.handle,
            },
          }
        : {};
    this.failures.push({ group: state?.group.id ?? "run", category, detail, ...document });
  }
  expect(
    group: Group,
    token: string,
    expectedURL: string,
    handle: string,
    cleanupOnly = false,
  ): DocumentState {
    if (!cleanupOnly && this.reporting.kind !== "live")
      throw new Error("Document admission cancelled");
    if (
      cleanupOnly &&
      (this.reporting.kind !== "cancelled" ||
        group.role !== "finish" ||
        group.caseIds.length !== 0 ||
        group.execution !== undefined)
    )
      throw new Error("Invalid fresh cleanup document admission");
    const state: DocumentState = {
      owner: { kind: "coordinator" },
      physical: "live",
      group,
      token,
      expectedURL,
      handle,
      startedAt: this.now(),
      doc: null,
      heartbeatAt: this.now(),
      messages: [],
      complete: false,
      terminalAt: null,
      ready: false,
      retiring: false,
      cutoff: null,
      final: false,
      listed: false,
      host: group.execution === "host" ? { kind: "awaiting-ready" } : null,
      tasks: new Map(),
    };
    this.documents.push(state);
    this.active = state;
    if (cleanupOnly) this.reporting = { kind: "cleanup", document: state };
    return state;
  }
  expectPeer(
    coordinator: DocumentState,
    peer: string,
    generation: number,
    token: string,
    expectedURL: string,
    handle: string,
    admission: PeerTransition,
  ): DocumentState {
    if (
      this.active !== coordinator ||
      admission.progress.kind !== "executing" ||
      admission.run !== this.run ||
      admission.caseId !== coordinator.group.caseIds[0] ||
      !admission.target ||
      admission.target.peer !== peer ||
      admission.target.generation !== generation ||
      admission.target.token !== token ||
      admission.target.url !== expectedURL ||
      (admission.action === "reload" && handle !== admission.source.handle) ||
      this.documents.some(
        (state) =>
          state.token === token ||
          (state.owner.kind === "peer" &&
            state.owner.peer === peer &&
            state.owner.generation === generation),
      )
    )
      this.violation("Unauthorized peer registration", coordinator);
    const state = this.expect({ ...coordinator.group, role: "peer" }, token, expectedURL, handle);
    this.active = coordinator;
    state.owner = { kind: "peer", coordinator, peer, generation, admission };
    state.host = null;
    return state;
  }
  owns(state: DocumentState): boolean {
    return (
      state === this.active ||
      (state.owner.kind === "peer" && state.owner.coordinator === this.active)
    );
  }
  prepareTransition(
    source: DocumentState,
    action: PeerTransition["action"],
    deadline: number,
  ): PeerTransition {
    if (
      !this.owns(source) ||
      source.cutoff !== null ||
      source.physical !== "live" ||
      this.active?.host?.kind !== "driving" ||
      (action === "create" && source !== this.active) ||
      (action !== "create" && source.owner.kind !== "peer")
    )
      this.violation("Invalid transition source", source);
    const destination =
      action === "close"
        ? { action, target: null }
        : { action, target: this.peerTarget(source, action) };
    const transition: PeerTransition = {
      id: crypto.randomUUID(),
      run: this.run,
      caseId: source.group.caseIds[0] ?? "",
      source,
      ...destination,
      deadline,
      progress: { kind: "accepted", watermark: null },
    };
    if (action !== "create") source.physical = "transitioning";
    this.transitions.push(transition);
    return transition;
  }
  private peerTarget(source: DocumentState, action: "create" | "reload"): PeerTarget {
    const token = crypto.randomUUID();
    const url = new URL(source.expectedURL);
    if (action === "create") url.searchParams.set("token", token);
    if (action === "reload" && source.owner.kind !== "peer")
      this.violation("Reload has no predecessor", source);
    return {
      peer:
        action === "reload" && source.owner.kind === "peer"
          ? source.owner.peer
          : crypto.randomUUID(),
      generation:
        action === "reload" && source.owner.kind === "peer" ? source.owner.generation + 1 : 0,
      token,
      url: url.href,
    };
  }
  executeTransition(transition: PeerTransition, watermark: number): void {
    if (
      transition.progress.kind !== "accepted" ||
      transition.progress.watermark !== watermark ||
      watermark !== transition.source.messages.length - 1 ||
      this.now() >= transition.deadline ||
      !this.owns(transition.source) ||
      this.failures.length
    )
      this.violation("Transition missing source acknowledgement", transition.source);
    transition.progress = { kind: "executing", watermark };
    if (transition.action !== "create") transition.source.cutoff = watermark;
  }
  completeTransition(
    transition: PeerTransition,
    handle: string,
    successor: DocumentState | null,
    remainingHandles: readonly string[] | null,
  ): void {
    if (transition.progress.kind !== "executing" || this.now() >= transition.deadline)
      this.violation("Transition already consumed or expired", transition.source);
    if (transition.action === "close") {
      if (
        successor !== null ||
        handle !== transition.source.handle ||
        !remainingHandles ||
        remainingHandles.includes(handle)
      )
        this.violation("Close lacks exact handle disappearance", transition.source);
    } else if (
      !successor?.doc ||
      !successor.ready ||
      successor.handle !== handle ||
      successor.token !== transition.target.token ||
      successor.expectedURL !== transition.target.url ||
      successor.owner.kind !== "peer" ||
      successor.owner.peer !== transition.target.peer ||
      successor.owner.generation !== transition.target.generation ||
      (transition.action === "reload" &&
        (handle !== transition.source.handle || successor.doc === transition.source.doc))
    )
      this.violation("Wrong successor transition observation", transition.source);
    transition.progress = { kind: "completed", handle, successor, remainingHandles };
    if (transition.action !== "create")
      transition.source.physical = transition.action === "close" ? "closed" : "superseded";
  }
  private transitionReady(state: DocumentState, id: string, seq: number): void {
    const transition = this.transitions.find((item) => item.id === id);
    if (
      !transition ||
      transition.source !== state ||
      transition.progress.kind !== "accepted" ||
      transition.progress.watermark !== null ||
      this.now() >= transition.deadline
    )
      this.violation("Unsolicited or reused transition", state);
    transition.progress.watermark = seq;
  }
  private violation(detail: string, state = this.active): never {
    this.fail("protocol", detail, state);
    throw new ReportRejected(detail);
  }
  heartbeat(value: unknown): HostReply {
    const state =
      record(value) && value.run === this.run
        ? this.documents.find((item) => item.doc !== null && item.doc === value.doc)
        : undefined;
    if (state?.cutoff !== null && state?.cutoff !== undefined) return { kind: "cancelled" };
    if (
      !record(value) ||
      value.kind !== "heartbeat" ||
      !reportingFailure(value.failure) ||
      !state ||
      !this.owns(state)
    )
      this.violation("Unbound heartbeat", state);
    state.heartbeatAt = this.now();
    if (value.failure !== null && !this.reportingFailed.has(state)) {
      this.reportingFailed.add(state);
      this.fail("page-reporting", value.failure, state);
    }
    return this.reply(false, state);
  }
  receive(value: unknown): ReportAck {
    const known =
      record(value) && value.run === this.run
        ? this.documents.find((state) => state.doc !== null && state.doc === value.doc)
        : undefined;
    if (known?.cutoff !== null && known?.cutoff !== undefined)
      throw new ObservationClosed("Report after observation cutoff");
    const pending =
      record(value) && value.kind === "hello" && value.run === this.run
        ? this.documents.find((item) => item.doc === null && item.token === value.token)
        : undefined;
    const state = known ?? pending;
    if (record(value) && value.kind === "report-chunk") {
      if (!known || !this.owns(known)) return this.violation("Unbound report chunks", known);
      try {
        return this.reports.receive(known, value, (body) => this.apply(known, parseMessage(body)));
      } catch (error) {
        if (error instanceof ReportRejected) throw error;
        return this.violation(String(error), known);
      }
    }
    let message: Message;
    try {
      message = parseMessage(value);
    } catch (error) {
      return this.violation(String(error), state);
    }
    if (!state || message.run !== this.run) {
      // A consumed token identifies the rejected binding, never an admission.
      const rejected =
        message.run === this.run && message.kind === "hello"
          ? this.documents.find((item) => item.token === message.token)
          : undefined;
      return this.violation("Wrong run or no expected document", rejected);
    }
    try {
      return this.reports.receive(state, message, () => {
        if (!this.owns(state)) return this.violation("Report sequence conflict or gap", state);
        if (!state.doc && message.kind !== "hello")
          return this.violation("Report before hello", state);
        if (state.doc && state.doc !== message.doc)
          return this.violation("Unexpected new document", state);
        this.apply(state, message);
      });
    } catch (error) {
      if (error instanceof ReportRejected) throw error;
      return this.violation(String(error), state);
    }
  }
  private apply(state: DocumentState, body: Message): void {
    if (
      state.owner.kind === "peer" &&
      !["hello", "peer-ready", "transition-ready", "allocation", "task-end", "error"].includes(
        body.kind,
      )
    )
      this.violation("Peer has no coordinator verdict authority", state);
    switch (body.kind) {
      case "hello":
        if (
          state.doc ||
          body.token !== state.token ||
          body.group !== state.group.id ||
          (state.owner.kind === "peer" && state.owner.admission.progress.kind !== "executing")
        )
          this.violation("Unauthorized hello", state);
        state.doc = body.doc;
        state.heartbeatAt = this.now();
        return;
      case "peer-ready":
        if (state.owner.kind !== "peer" || state.ready)
          this.violation("Unexpected peer readiness", state);
        state.ready = true;
        return;
      case "transition-ready":
        this.transitionReady(state, body.transitionId, body.seq);
        return;
      case "list":
        if (state.group.role !== "list" || state.listed) this.violation("Unexpected list", state);
        exactInventory(this.required, this.policy.listIds(body.cases));
        state.listed = true;
        return;
      case "allocation":
        this.allocate(state, body.entry);
        return;
      case "worker-settled":
        if (
          !this.workerAttempt ||
          this.workerAttempt.state !== state ||
          state.complete ||
          this.workerAttempt.attempt.state !== "admitted" ||
          !sameWorkerEntry(this.workerAttempt.attempt.entry, body.entry)
        )
          this.violation("Unbound or duplicate worker settlement", state);
        this.workerAttempt.attempt = { entry: body.entry, state: "settled", outcome: body.outcome };
        return;
      case "case-start":
        if (state.host) this.violation("Page start for host-driven case", state);
        this.startCase(state, body.caseId);
        return;
      case "case-ready":
        this.hostTransition(state, body.caseId, "awaiting-ready");
        state.host = { kind: "ready" };
        return;
      case "case-teardown":
        this.hostTransition(state, body.caseId, "driving");
        state.host = { kind: "teardown", enteredAt: this.now() };
        return;
      case "task-end":
        this.taskEnd(state, body);
        return;
      case "case-end":
        this.endCase(state, body);
        return;
      case "error":
        this.fail("page-error", body.message, state);
        return;
      case "doc-complete":
        if (state.complete || !this.groupTerminal(state))
          this.violation("Incomplete or duplicate document completion", state);
        state.complete = true;
        return;
      case "retire-ready":
        if (!state.complete || !state.retiring || state.ready)
          this.violation("Unexpected retirement", state);
        state.ready = true;
        return;
      case "run-complete":
        this.finish(state, body.remaining);
        return;
    }
  }
  private hostTransition(state: DocumentState, id: string, phase: HostPhase["kind"]): void {
    if (
      state !== this.active ||
      state.group.role !== "case" ||
      state.group.caseIds.length !== 1 ||
      state.group.caseIds[0] !== id ||
      state.host?.kind !== phase ||
      state.complete ||
      state.cutoff !== null
    )
      this.violation("Invalid host phase transition", state);
  }
  beginHost(state: DocumentState, id: string): void {
    this.hostTransition(state, id, "ready");
    this.startCase(state, id);
    state.host = { kind: "driving", startedAt: this.now() };
  }
  registerTask(state: DocumentState, operation: string): void {
    if (
      !this.owns(state) ||
      this.active?.host?.kind !== "driving" ||
      state.cutoff !== null ||
      state.tasks.has(operation)
    )
      this.violation("Invalid host task registration", state);
    if (Array.from(state.tasks.values()).some((task) => task.status === "pending"))
      throw new Error("Only one page task may execute at a time");
    state.tasks.set(operation, { status: "pending" });
  }
  private taskEnd(state: DocumentState, body: Extract<Body, { kind: "task-end" }>): void {
    if (
      !this.owns(state) ||
      (state.owner.kind !== "peer" && !state.host) ||
      state.group.caseIds[0] !== body.caseId ||
      state.tasks.get(body.operation)?.status !== "pending" ||
      (state.host && ["awaiting-ready", "ready"].includes(state.host.kind))
    )
      this.violation("Unexpected page task settlement", state);
    state.tasks.set(
      body.operation,
      body.status === "pass"
        ? { status: "pass" }
        : { status: "fail", error: body.error ?? "Page task failed" },
    );
  }
  private groupTerminal(state: DocumentState): boolean {
    if (state.group.role === "list") return state.listed;
    if (state.group.role === "finish") return state.final;
    return (
      state.group.caseIds.length > 0 &&
      state.group.caseIds.every((id) =>
        ["pass", "fail", "host"].includes(this.outcomes[id]?.status ?? "pending"),
      )
    );
  }
  private startCase(state: DocumentState, id: string): void {
    if (
      !state.group.caseIds.includes(id) ||
      this.outcomes[id]?.status !== "pending" ||
      state.complete
    )
      this.violation(`Unknown/cross-group/duplicate case start: ${id}`, state);
    this.outcomes[id] = { status: "running", startedAt: this.now() };
  }
  private endCase(state: DocumentState, body: Extract<Body, { kind: "case-end" }>): void {
    if (
      !state.group.caseIds.includes(body.caseId) ||
      this.outcomes[body.caseId]?.status !== "running" ||
      state.complete
    )
      this.violation(`Case end before start or duplicate terminal: ${body.caseId}`, state);
    if (state.host && state.host.kind !== "teardown")
      this.violation("Host terminal before teardown", state);
    if (body.status === "pass" && this.policy.requireResult && !("result" in body))
      this.violation("Missing required command result", state);
    if ("result" in body) {
      const snapshot = JSON.stringify(body.result);
      if (snapshot === undefined || new TextEncoder().encode(snapshot).byteLength > resultByteLimit)
        this.violation("Invalid or oversized result snapshot", state);
      this.results[body.caseId] = body.result;
    }
    if (
      state.host &&
      record(body.result) &&
      record(body.result.teardown) &&
      body.result.teardown.status === "timeout" &&
      body.result.teardown.settled === false
    )
      this.fail(
        "teardown-unconfirmed",
        "Page teardown did not settle within its original hook window",
        state,
      );
    state.terminalAt = this.now();
    if (state.host) state.host = { kind: "terminal" };
    if (body.status === "fail") {
      this.outcomes[body.caseId] = { status: "fail", detail: body.error ?? "test failure" };
      return;
    }
    try {
      this.policy.check(body.caseId, body.result);
      this.outcomes[body.caseId] = { status: "pass", provisional: true };
    } catch (error) {
      this.outcomes[body.caseId] = { status: "fail", detail: `Host assertion: ${String(error)}` };
    }
  }

  private allocate(state: DocumentState, entry: StorageEntry): void {
    if (entry.kind !== "service-worker" && !this.policy.allocation)
      this.violation("Suite declares no durable allocations", state);
    const running = state.group.caseIds.filter((id) => this.outcomes[id]?.status === "running");
    if (!["case", "peer"].includes(state.group.role) || !running.length)
      this.violation("Allocation outside running case", state);
    if (entry.kind === "service-worker") {
      this.allocateWorker(state, entry);
      return;
    }
    if (!this.policy.allocation) this.violation("Suite declares no durable allocations", state);
    this.policy.allocation(entry, running, this.run);
    if (!this.ledger.some((saved) => saved.kind === entry.kind && saved.name === entry.name))
      this.ledger.push(entry);
  }
  private allocateWorker(state: DocumentState, entry: ServiceWorkerEntry): void {
    if (
      !this.worker ||
      state !== this.active ||
      state.complete ||
      state.owner.kind !== "coordinator" ||
      state.group.role !== "case" ||
      state.group.caseIds[0] !== this.worker.caseId ||
      state.expectedURL !== entry.clientURL ||
      !sameWorkerEntry(entry, this.worker.entry)
    )
      this.violation("Service worker allocation differs from host declaration", state);
    if (this.workerAttempt) this.violation("Service worker attempt already admitted", state);
    this.ledger.push(entry);
    this.workerAttempt = { state, attempt: { entry, state: "admitted" } };
  }
  private finish(state: DocumentState, remaining: StorageEntry[]): void {
    const casesSettled = this.selected.every((id) =>
      ["pass", "fail", "host"].includes(this.outcomes[id]?.status ?? "pending"),
    );
    const retired = this.documents
      .filter((item) => item !== state)
      .every(
        (item) =>
          item.cutoff !== null &&
          (item.owner.kind !== "peer" || ["closed", "superseded"].includes(item.physical)),
      );
    if (
      state.group.role !== "finish" ||
      state.final ||
      !casesSettled ||
      !retired ||
      this.transitions.some((item) => item.progress.kind !== "completed")
    )
      this.violation("Premature run-complete", state);
    if (remaining.some((entry) => !this.ledger.some((saved) => sameStorageEntry(saved, entry))))
      this.violation("Unknown or changed remaining allocation", state);
    const unresolved = this.registrationAttempts.filter((attempt) => attempt.state !== "settled");
    if (
      unresolved.some(
        (attempt) => !remaining.some((entry) => sameStorageEntry(entry, attempt.entry)),
      )
    )
      this.violation("Finish omitted unjoined registration operation", state);
    if (remaining.length) this.fail("storage-cleanup", JSON.stringify(remaining), state);
    this.remaining = remaining;
    state.final = true;
    this.runComplete = true;
  }
  abandon(detail: string): void {
    if (this.active && this.active.cutoff === null)
      this.active.cutoff = this.active.messages.length - 1;
    for (const id of this.selected) {
      const outcome = this.outcomes[id];
      if (outcome?.status === "pending" || outcome?.status === "running")
        this.outcomes[id] = { status: "host", detail };
    }
  }
  retire(state: DocumentState, watermark: number): void {
    if (!state.ready || watermark !== state.messages.length - 1 || state !== this.active)
      this.violation("Retirement without final acknowledgement", state);
    const contained = this.documents
      .filter((item) => item.owner.kind === "peer" && item.owner.coordinator === state)
      .every((item) => ["closed", "superseded"].includes(item.physical));
    if (
      !contained ||
      this.transitions.some(
        (item) => item.caseId === state.group.caseIds[0] && item.progress.kind !== "completed",
      )
    )
      this.violation("Case peers not physically contained", state);
    state.cutoff = watermark;
    for (const id of state.group.caseIds) {
      const outcome = this.outcomes[id];
      if (outcome?.status === "pass") outcome.provisional = false;
    }
  }
  deadline(budgets: Budgets, runStartedAt: number): string | null {
    const now = this.now();
    if (now - runStartedAt >= budgets.run) return "run-timeout";
    const live = this.documents.filter((item) => this.owns(item) && item.cutoff === null);
    for (const item of live) {
      const failure = this.documentDeadline(item, budgets, now);
      if (failure) return failure;
    }
    return null;
  }
  overdueDocument(budgets: Budgets): DocumentState | undefined {
    return this.documents.find(
      (item) =>
        this.owns(item) && item.cutoff === null && this.documentDeadline(item, budgets, this.now()),
    );
  }
  private documentDeadline(state: DocumentState, budgets: Budgets, now: number): string | null {
    if (!state.doc && now - state.startedAt >= budgets.hello) return "no-hello";
    if (
      (state.host?.kind === "awaiting-ready" || state.host?.kind === "ready") &&
      now - state.startedAt >= budgets.hello
    )
      return "no-case-ready";
    const documentMs = state.host ? (budgets.caseDocument ?? budgets.group) : budgets.group;
    if (now - state.startedAt >= documentMs) return "group-timeout";
    if (
      state.host?.kind === "teardown" &&
      now - state.host.enteredAt >= (budgets.teardown ?? budgets.case) + 10_000
    )
      return "teardown-report-timeout";
    const running = state.group.caseIds
      .map((id) => this.outcomes[id])
      .find((item) => item?.status === "running");
    if (!state.host && running?.status === "running" && now - running.startedAt >= budgets.case)
      return "case-hang";
    if (state.doc && now - state.heartbeatAt >= budgets.heartbeat) return "heartbeat-lost";
    return null;
  }
}
