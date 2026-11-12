import { record } from "./protocol.js";

const operations = [
  "authority",
  "peer",
  "pageStop",
  "authorityDeath",
  "exclusive",
  "startGuest",
  "stopGuest",
  "guestDeath",
  "prepare",
  "armClaim",
  "releaseClaim",
  "call",
  "settle",
  "authorityInspect",
  "authorityBypass",
  "changes",
  "armDefensiveHooks",
  "defensiveResult",
  "lateAttachment",
  "latePreparation",
  "oldSettlement",
  "queuedAttachment",
  "cancelledStartup",
  "cancelStartup",
  "guardLifecycle",
  "ordinarySurvivor",
  "persistentBaseline",
  "workspaceGuest",
  "workspaceDescendant",
  "workspaceMutation",
  "persistentAbortLateOpen",
  "persistentBeginLateRequest",
  "persistentBlockNativeOpen",
  "persistentCancelEpoch",
  "persistentCancelPendingClaim",
  "persistentDeath",
  "persistentDelete",
  "persistentFailClose",
  "persistentHold",
  "persistentInspect",
  "persistentOrdinaryHold",
  "persistentOrdinaryRead",
  "persistentOrdinaryRelease",
  "persistentProbe",
  "persistentRead",
  "persistentRelease",
  "persistentSeed",
  "persistentStart",
  "persistentStop",
  "persistentUnblockNativeOpen",
  "workspaceAuthority",
  "workspaceAuthorityStop",
  "workspaceCancelledStartup",
  "workspaceChanges",
  "workspaceCut",
  "workspaceDescendantCancel",
  "workspaceDescendantCancelReserved",
  "workspaceDescendantQueue",
  "workspaceDescendantReserve",
  "workspaceGuestCall",
  "workspaceGuestDeath",
  "workspaceGuestPendingSettled",
  "workspaceGuestReady",
  "workspaceGuestSignalStop",
  "workspaceGuestStatus",
  "workspaceGuestStop",
  "workspaceGuestTerminal",
  "workspacePage",
  "workspacePageDenied",
  "workspacePeer",
  "workspaceStop",
  "other-evaluation",
] as const;
export type Operation = (typeof operations)[number];
export function evaluationOperation(value: unknown): Operation {
  const candidate = record(value) ? value.operation : undefined;
  return operations.find((operation) => operation === candidate) ?? "other-evaluation";
}
export function evaluationMode(value: unknown): "wasi" | "proc" | null {
  const candidate = record(value) && record(value.value) ? value.value.mode : undefined;
  return candidate === "wasi" || candidate === "proc" ? candidate : null;
}
export function diagnosticOrdinal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
export function evaluationCorrelation(
  value: unknown,
): Pick<Facts, "activeJobs" | "activeJobCount" | "ambiguous"> {
  if (!record(value) || !Array.isArray(value.activeJobs))
    return { activeJobs: [], ambiguous: true };
  const activeJobs = value.activeJobs
    .filter(
      (item): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
    )
    .slice(0, 64);
  const activeJobCount =
    typeof value.activeJobCount === "number" &&
    Number.isSafeInteger(value.activeJobCount) &&
    value.activeJobCount >= 0
      ? value.activeJobCount
      : undefined;
  return {
    activeJobs,
    activeJobCount,
    ambiguous: value.ambiguous !== false || activeJobCount !== 1 || activeJobs.length !== 1,
  };
}
const stages = [
  "window-select",
  "handle-check",
  "script-dispatch",
  "queued",
  "started",
  "resolved",
  "rejected",
  "answer-stored",
  "answer-consumed",
  "submitted",
  "poll-pending",
  "poll-pass",
  "poll-fail",
  "failed",
  "completed",
  "stop-requested",
  "task-joined",
  "state-checked",
  "physical-close-requested",
  "physical-close-confirmed",
  "worker-receipts-pending",
  "worker-receipts-joined",
  "listener-removal-joined",
  "bridge-invoked",
  "response-arrived",
  "page-acknowledged",
  "query-admitted",
  "wait-resolved",
  "wait-rejected",
  "response-created",
  "response-failed",
  "native-created",
  "initialization-acknowledged",
  "initialization-failed",
  "safari-worker-terminated",
  "playwright-worker-close",
  "observer-lost",
  "observer-retired",
  "body-failed",
  "cleanup-started",
  "label",
] as const;
export type Stage = (typeof stages)[number];
export type Purpose =
  | "evaluator-submit"
  | "evaluator-take"
  | "evaluator-stop"
  | "evaluator-state"
  | "peer-transition"
  | "liveness-probe"
  | "verdict"
  | "other-command";
export type Facts = {
  context?: "body" | "cleanup";
  workers?: number[];
  workerCount?: number;
  workersTruncated?: number;
  peer?: number;
  generation?: number;
  job?: number;
  worker?: number | null;
  operation?: Operation;
  mode?: "wasi" | "proc" | null;
  purpose?: Purpose;
  polls?: number;
  label?: number;
  query?: number;
  status?: number;
  fixture?: ReturnType<typeof fixturePath>;
  activeJobs?: number[];
  activeJobCount?: number;
  ambiguous?: boolean;
};
export type TraceEntry = { ordinal: number; facts: Facts; stages: { stage: Stage; at: number }[] };
type TraceClock = "host-monotonic-ms" | "page-monotonic-ms";
type TraceSnapshot = {
  clock: TraceClock;
  active: TraceEntry[];
  completed: TraceEntry[];
  total: number;
  elapsedMs: number;
  elapsedBeforeStartedMs: number;
  elapsedAfterStartedMs: number;
  totals: Partial<Record<Operation, number>>;
  truncated: number;
  unavailable: number;
};

function emptyTrace(clock: TraceClock, total = 0, truncated = 0, unavailable = 0): TraceSnapshot {
  return {
    clock,
    active: [],
    completed: [],
    total,
    elapsedMs: 0,
    elapsedBeforeStartedMs: 0,
    elapsedAfterStartedMs: 0,
    totals: {},
    truncated,
    unavailable,
  };
}

export function collectDiagnostic<T>(collect: () => T, unavailable: () => T): T {
  try {
    return collect();
  } catch {
    return unavailable();
  }
}

export function fixturePath(value: string) {
  try {
    const path = new URL(value, "https://fixture.invalid").pathname;
    if (
      path === "/resident-authority.js" ||
      path === "/resident-guest.js" ||
      path === "/fs-worker.js"
    )
      return path;
  } catch {
    /* Unknown metadata is deliberately not retained. */
  }
  return "other-worker";
}

/** Diagnostic bounds never govern execution or verdicts. */
export class BoundedTrace {
  private sequence = 0;
  private readonly active = new Map<number, TraceEntry>();
  private readonly completed: TraceEntry[] = [];
  private readonly totals: Partial<Record<Operation, number>> = {};
  private dropped = 0;
  private unavailable = 0;
  private elapsedMs = 0;
  private elapsedBeforeStartedMs = 0;
  private elapsedAfterStartedMs = 0;
  constructor(
    readonly clock: TraceClock,
    private readonly now = () => performance.now(),
  ) {}
  missing(): void {
    this.unavailable++;
  }
  begin(stage: Stage, facts: Facts = {}): number {
    const ordinal = ++this.sequence;
    try {
      this.beginEntry(ordinal, stage, facts);
    } catch {
      this.unavailable++;
    }
    return ordinal;
  }
  private beginEntry(ordinal: number, stage: Stage, facts: Facts): void {
    if (facts.operation) this.totals[facts.operation] = (this.totals[facts.operation] ?? 0) + 1;
    if (this.active.size >= 64) {
      this.dropped++;
      return;
    }
    this.active.set(ordinal, {
      ordinal,
      facts: structuredClone(facts),
      stages: [{ stage, at: this.now() }],
    });
  }
  mark(ordinal: number, stage: Stage, facts: Facts = {}): void {
    try {
      this.markEntry(ordinal, stage, facts);
    } catch {
      this.unavailable++;
    }
  }
  private markEntry(ordinal: number, stage: Stage, facts: Facts): void {
    const entry =
      this.active.get(ordinal) ?? this.completed.find((item) => item.ordinal === ordinal);
    if (!entry) return;
    Object.assign(entry.facts, structuredClone(facts));
    // Keep the beginning and latest stages, including repeated polls, bounded.
    if (entry.stages.length === 12) {
      entry.stages.splice(1, 1);
      this.dropped++;
    }
    if (entry.stages.at(-1)?.stage === stage) entry.stages.pop();
    entry.stages.push({ stage, at: this.now() });
  }
  end(ordinal: number, stage: Stage): void {
    try {
      this.endEntry(ordinal, stage);
    } catch {
      this.unavailable++;
    }
  }
  private endEntry(ordinal: number, stage: Stage): void {
    this.mark(ordinal, stage);
    const entry = this.active.get(ordinal);
    if (!entry) return;
    const now = this.now();
    const began = entry.stages[0]?.at ?? now;
    const started = entry.stages.find((item) => item.stage === "started")?.at;
    this.elapsedMs += now - began;
    if (started !== undefined) {
      this.elapsedBeforeStartedMs += started - began;
      this.elapsedAfterStartedMs += now - started;
    }
    this.active.delete(ordinal);
    if (this.completed.length === 32) {
      this.completed.shift();
      this.dropped++;
    }
    this.completed.push(entry);
  }
  snapshot(): TraceSnapshot {
    try {
      return structuredClone({
        clock: this.clock,
        active: Array.from(this.active.values()),
        completed: this.completed,
        total: this.sequence,
        elapsedMs: this.elapsedMs,
        elapsedBeforeStartedMs: this.elapsedBeforeStartedMs,
        elapsedAfterStartedMs: this.elapsedAfterStartedMs,
        totals: this.totals,
        truncated: this.dropped,
        unavailable: this.unavailable,
      });
    } catch {
      return emptyTrace(this.clock, this.sequence, this.dropped, ++this.unavailable);
    }
  }
}

export class StallDiagnostics {
  readonly evaluations = new BoundedTrace("host-monotonic-ms");
  readonly lifecycle = new BoundedTrace("host-monotonic-ms");
  readonly queue = new BoundedTrace("host-monotonic-ms");
  queuePending = 0;
  queueCurrent: number | null = null;
  readonly queries = new BoundedTrace("host-monotonic-ms");
  readonly labels = new BoundedTrace("host-monotonic-ms");
  private readonly pages = new Map<number, NonNullable<ReturnType<typeof pageEvidence>>>();
  private readonly observers = new Map<number, () => unknown>();
  private first: unknown = null;
  private preCleanup: unknown = null;
  private cleanupAt: number | null = null;
  private truncated = 0;
  private unavailableCount = 0;
  missing(): void {
    this.unavailableCount++;
  }
  page(peer: number, value: unknown): void {
    collectDiagnostic(
      () => this.retainPage(peer, value),
      () => this.missing(),
    );
  }
  private retainPage(peer: number, value: unknown): void {
    // Only locally generated, closed-schema JSON is accepted; never retain page payloads.
    const clean = pageEvidence(value);
    if (clean === null) return this.missing();
    if (!this.pages.has(peer) && this.pages.size >= 16) {
      this.truncated++;
      return;
    }
    this.pages.set(peer, clean);
  }
  observe(peer: number, snapshot: () => unknown): void {
    if (this.observers.size >= 16) {
      this.truncated++;
      return;
    }
    this.observers.set(peer, snapshot);
  }
  freeze(
    reason:
      | "owner-failure"
      | "native-command-failure"
      | "host-command-failure"
      | "host-body-failure"
      | "evaluation-failure"
      | "collector-failure" = "owner-failure",
  ): void {
    collectDiagnostic(
      () => {
        this.first ??= structuredClone({
          reason,
          hostAt: performance.now(),
          evidence: this.current(),
        });
      },
      () => {
        this.missing();
        this.first ??= { reason, hostAt: null, unavailable: true };
      },
    );
  }
  cleanup(): void {
    collectDiagnostic(
      () => {
        this.preCleanup ??= structuredClone(this.current());
        this.cleanupAt ??= performance.now();
      },
      () => {
        this.missing();
        this.preCleanup ??= { unavailable: true };
        this.cleanupAt ??= 0;
      },
    );
  }
  get context(): "body" | "cleanup" {
    return this.cleanupAt === null ? "body" : "cleanup";
  }
  current(): ReturnType<StallDiagnostics["project"]> {
    return collectDiagnostic(
      () => this.project(),
      () => {
        this.missing();
        return this.emptyCurrent();
      },
    );
  }
  private project() {
    return {
      queries: this.queries.snapshot(),
      evaluations: boundedEvaluations(
        this.evaluations.snapshot(),
        Array.from(this.pages, ([peer, evidence]) => ({
          peer,
          evidence: structuredClone(evidence),
        })),
      ),
      lifecycle: this.lifecycle.snapshot(),
      queue: this.queueSnapshot(),
      labels: this.labels.snapshot(),
      pageState: "unavailable-until-existing-reply;last-reply-is-not-live-state",
      observers: Array.from(this.observers, ([peer, snapshot]) => ({
        peer,
        evidence: collectDiagnostic(snapshot, () => {
          this.missing();
          return { unavailable: true };
        }),
      })),
      cleanupAt: this.cleanupAt,
      truncated: this.truncated,
      unavailable: this.unavailableCount,
    };
  }
  private emptyCurrent(): ReturnType<StallDiagnostics["project"]> {
    return {
      queries: emptyTrace("host-monotonic-ms"),
      evaluations: {
        owner: emptyTrace("host-monotonic-ms"),
        pages: [],
        truncated: 0,
        byteLimit: 65536,
      },
      lifecycle: emptyTrace("host-monotonic-ms"),
      queue: {
        ...emptyTrace("host-monotonic-ms"),
        actualPending: this.queuePending,
        currentOrdinal: this.queueCurrent,
        oldestWaiting: null,
      },
      labels: emptyTrace("host-monotonic-ms"),
      pageState: "unavailable-until-existing-reply;last-reply-is-not-live-state",
      observers: [],
      cleanupAt: this.cleanupAt,
      truncated: this.truncated,
      unavailable: this.unavailableCount,
    };
  }
  private queueSnapshot() {
    const trace = this.queue.snapshot();
    const oldestWaiting =
      trace.active.find((entry) => entry.stages.at(-1)?.stage === "queued") ?? null;
    return {
      ...trace,
      actualPending: this.queuePending,
      currentOrdinal: this.queueCurrent,
      oldestWaiting,
    };
  }
  snapshot() {
    return collectDiagnostic(
      () =>
        structuredClone({
          firstFailure: this.first,
          beforeCleanup: this.preCleanup,
          current: this.current(),
        }),
      () => {
        this.missing();
        return {
          firstFailure: this.first,
          beforeCleanup: this.preCleanup,
          current: this.emptyCurrent(),
        };
      },
    );
  }
}

function pageEvidence(value: unknown) {
  if (
    !record(value) ||
    value.clock !== "page-monotonic-ms" ||
    !Array.isArray(value.entries) ||
    typeof value.unavailable !== "number" ||
    !Number.isSafeInteger(value.unavailable) ||
    value.unavailable < 0
  )
    return null;
  const entries = value.entries.slice(0, 96).flatMap(pageEntry);
  const totals: Partial<Record<Operation, number>> = {};
  for (const operation of operations) {
    const count = record(value.totals) ? value.totals[operation] : undefined;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      totals[operation] = count;
  }
  const state: Partial<Record<"queued" | "pending" | "unread" | "active", number>> & {
    accepting?: boolean;
  } = {};
  for (const key of ["queued", "pending", "unread", "active"] as const) {
    const count = record(value.state) ? value.state[key] : undefined;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) state[key] = count;
  }
  if (record(value.state) && typeof value.state.accepting === "boolean")
    state.accepting = value.state.accepting;
  return {
    hostObservedAt: performance.now(),
    totals,
    state,
    total: diagnosticOrdinal(value.total) ?? 0,
    bridgeTotal: diagnosticOrdinal(value.bridgeTotal) ?? 0,
    clock: "page-monotonic-ms",
    entries,
    truncated: typeof value.truncated === "number" ? Math.max(0, value.truncated) : 0,
    unavailable: value.unavailable,
  };
}
function pageEntry(value: unknown): TraceEntry[] {
  if (
    !record(value) ||
    typeof value.ordinal !== "number" ||
    !Number.isSafeInteger(value.ordinal) ||
    !record(value.facts) ||
    !Array.isArray(value.stages)
  )
    return [];
  const facts: Facts = {};
  for (const key of ["job", "query", "polls", "worker", "status"] as const) {
    const number = value.facts[key];
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0)
      facts[key] = number;
  }
  facts.operation = evaluationOperation({ operation: value.facts.operation });
  facts.mode = evaluationMode({ value: value.facts });
  facts.fixture = fixturePath(typeof value.facts.fixture === "string" ? value.facts.fixture : "");
  if (Array.isArray(value.facts.activeJobs))
    Object.assign(facts, evaluationCorrelation(value.facts));
  return [
    {
      ordinal: value.ordinal,
      facts,
      stages: value.stages.slice(0, 12).flatMap((item) => {
        if (!record(item) || typeof item.at !== "number" || !Number.isFinite(item.at)) return [];
        const stage = stages.find((candidate) => candidate === item.stage);
        return stage ? [{ stage, at: item.at }] : [];
      }),
    },
  ];
}

function boundedEvaluations(
  owner: ReturnType<BoundedTrace["snapshot"]>,
  pages: { peer: number; evidence: NonNullable<ReturnType<typeof pageEvidence>> }[],
) {
  const result = { owner, pages, truncated: 0, byteLimit: 65536 };
  while (JSON.stringify(result).length > 65536) {
    const page = pages.findLast((item) => item.evidence.entries.length > 0);
    if (page) page.evidence.entries.pop();
    else if (owner.completed.length) owner.completed.shift();
    else owner.active.pop();
    result.truncated++;
  }
  return result;
}

const bindings = new WeakMap<
  object,
  { diagnostics: StallDiagnostics; peer: number; generation: number }
>();
export function bindDiagnostics(
  target: object,
  diagnostics: StallDiagnostics,
  peer: number,
  generation: number,
): void {
  bindings.set(target, { diagnostics, peer, generation });
}
export function diagnosticsFor(target: object) {
  return bindings.get(target);
}
