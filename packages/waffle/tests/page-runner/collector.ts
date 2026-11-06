import {
  exactInventory,
  parseMessage,
  record,
  resultByteLimit,
  type Body,
  type Budgets,
  type Failure,
  type Message,
  type Outcome,
} from "./protocol.js";
import type { StorageEntry } from "../storage-allocation.js";
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
  role: "list" | "case" | "finish";
  caseIds: string[];
  execution?: "host";
};
export type HostPhase =
  | { kind: "awaiting-ready" | "ready" }
  | { kind: "driving"; startedAt: number }
  | { kind: "teardown"; enteredAt: number }
  | { kind: "terminal" };
type PageTask = { status: "pending" } | { status: "pass" } | { status: "fail"; error: string };
export type DocumentState = {
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
  readonly outcomes: Record<string, Outcome> = {};
  readonly results: Record<string, unknown> = {};
  readonly failures: Failure[] = [];
  readonly ledger: StorageEntry[] = [];
  readonly documents: DocumentState[] = [];
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
    this.failures.push({ group: state?.group.id ?? "run", category, detail });
  }
  expect(group: Group, token: string, expectedURL: string, handle: string): DocumentState {
    const state: DocumentState = {
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
    return state;
  }
  private violation(detail: string, state = this.active): never {
    this.fail("protocol", detail, state);
    throw new ReportRejected(detail);
  }
  heartbeat(value: unknown): void {
    const state = this.active;
    if (
      record(value) &&
      value.run === this.run &&
      this.documents.some((old) => old.doc === value.doc && old.cutoff !== null)
    )
      return;
    if (
      !record(value) ||
      value.kind !== "heartbeat" ||
      value.run !== this.run ||
      !state?.doc ||
      value.doc !== state.doc ||
      state.cutoff !== null
    )
      this.violation("Unbound heartbeat");
    state.heartbeatAt = this.now();
  }
  receive(value: unknown): { ackedThrough: number } {
    const known =
      record(value) && value.run === this.run
        ? this.documents.find((state) => state.doc !== null && state.doc === value.doc)
        : undefined;
    if (known?.cutoff !== null && known?.cutoff !== undefined)
      throw new ObservationClosed("Report after observation cutoff");
    const state = known ?? this.active;
    let message: Message;
    try {
      message = parseMessage(value);
    } catch (error) {
      return this.violation(String(error), state);
    }
    if (!state || message.run !== this.run)
      return this.violation("Wrong run or no expected document", state);
    const encoded = JSON.stringify(message);
    if (state.messages[message.seq] === encoded) return { ackedThrough: message.seq };
    if (state.cutoff !== null) throw new ObservationClosed("Report after observation cutoff");
    if (state !== this.active || message.seq !== state.messages.length)
      return this.violation("Report sequence conflict or gap", state);
    if (!state.doc && message.kind !== "hello") return this.violation("Report before hello", state);
    if (state.doc && state.doc !== message.doc)
      return this.violation("Unexpected new document", state);
    try {
      this.apply(state, message);
    } catch (error) {
      if (error instanceof ReportRejected) throw error;
      return this.violation(String(error), state);
    }
    state.messages.push(encoded);
    return { ackedThrough: message.seq };
  }
  private apply(state: DocumentState, body: Message): void {
    switch (body.kind) {
      case "hello":
        if (state.doc || body.token !== state.token || body.group !== state.group.id)
          this.violation("Unauthorized hello", state);
        state.doc = body.doc;
        state.heartbeatAt = this.now();
        return;
      case "list":
        if (state.group.role !== "list" || state.listed) this.violation("Unexpected list", state);
        exactInventory(this.required, this.policy.listIds(body.cases));
        state.listed = true;
        return;
      case "allocation":
        this.allocate(state, body.entry);
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
    if (state !== this.active || state.host?.kind !== "driving" || state.tasks.has(operation))
      this.violation("Invalid host task registration", state);
    if (Array.from(state.tasks.values()).some((task) => task.status === "pending"))
      throw new Error("Only one page task may execute at a time");
    state.tasks.set(operation, { status: "pending" });
  }
  private taskEnd(state: DocumentState, body: Extract<Body, { kind: "task-end" }>): void {
    if (
      state !== this.active ||
      !state.host ||
      state.group.caseIds[0] !== body.caseId ||
      state.tasks.get(body.operation)?.status !== "pending" ||
      ["awaiting-ready", "ready"].includes(state.host.kind)
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
    if (!this.policy.allocation) this.violation("Suite declares no durable allocations", state);
    const running = state.group.caseIds.filter((id) => this.outcomes[id]?.status === "running");
    if (state.group.role !== "case" || !running.length)
      this.violation("Allocation outside running case", state);
    this.policy.allocation(entry, running, this.run);
    if (!this.ledger.some((saved) => saved.kind === entry.kind && saved.name === entry.name))
      this.ledger.push(entry);
  }
  private finish(state: DocumentState, remaining: StorageEntry[]): void {
    const casesSettled = this.selected.every((id) =>
      ["pass", "fail", "host"].includes(this.outcomes[id]?.status ?? "pending"),
    );
    const retired = this.documents
      .filter((item) => item !== state)
      .every((item) => item.cutoff !== null);
    if (state.group.role !== "finish" || state.final || !casesSettled || !retired)
      this.violation("Premature run-complete", state);
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
    state.cutoff = watermark;
    for (const id of state.group.caseIds) {
      const outcome = this.outcomes[id];
      if (outcome?.status === "pass") outcome.provisional = false;
    }
  }
  deadline(budgets: Budgets, runStartedAt: number): string | null {
    const now = this.now(),
      state = this.active;
    if (now - runStartedAt >= budgets.run) return "run-timeout";
    if (!state || state.cutoff !== null) return null;
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
