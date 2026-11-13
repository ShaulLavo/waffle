import { record } from "./protocol.js";

type Correlation = { jobs: number[]; count: number | null; ambiguous: boolean };
type ErrorScalars = { name: string | null; errno: number | null; type: string; textOmitted: true };
type Phase =
  | "request-invoked"
  | "callback-null"
  | "callback-granted"
  | "request-fulfilled"
  | "query-invoked"
  | "query-fulfilled";
type FailurePhase =
  | "request-threw"
  | "callback-threw"
  | "request-rejected"
  | "query-threw"
  | "query-rejected";
type Event = {
  ordinal: number;
  requests: number[];
  correlation: Correlation;
} & ({ phase: Phase } | { phase: FailurePhase; error: ErrorScalars });
type ContinuityLockDiagnostic = {
  kind: "page-continuity-locks";
  records: Event[];
  dropped: number;
  unavailable: number;
  ambiguous: number;
};

const prefix = "waffle:publication:continuity:";
const encoder = new TextEncoder();
const encode = encoder.encode.bind(encoder);
const stringify = JSON.stringify;
const apply = Reflect.apply;
const then = Promise.prototype.then;

function emptyContinuityDiagnostic(unavailable = 1): ContinuityLockDiagnostic {
  return { kind: "page-continuity-locks", records: [], dropped: 0, unavailable, ambiguous: 0 };
}

/** Page-only observer. It never reads query snapshots or retains lock names/objects. */
export function observeContinuityLocks(
  manager: Pick<LockManager, "request" | "query">,
  jobs: () => { activeJobs: number[]; activeJobCount: number },
) {
  const state = emptyContinuityDiagnostic(0);
  const awaitingQuery = new Map<number, Correlation>();
  let sequence = 0;
  let requestSequence = 0;
  function bestEffort(action: () => void): void {
    try {
      action();
    } catch {
      state.unavailable++;
    }
  }
  function correlation(): Correlation {
    const { activeJobs, activeJobCount } = jobs();
    const ids = activeJobs.slice(0, 8);
    return {
      jobs: ids,
      count: activeJobCount,
      ambiguous: activeJobCount !== 1 || ids.length !== 1,
    };
  }
  function append(event: Event): void {
    if (event.correlation.ambiguous) state.ambiguous++;
    state.records.push(event);
    if (state.records.length > 32) {
      state.records.shift();
      state.dropped++;
    }
    try {
      while (state.records.length > 32 || encode(stringify(state)).byteLength > 8192) {
        state.records.shift();
        state.dropped++;
      }
    } catch {
      state.records.pop();
      state.unavailable++;
    }
  }
  function emit(requests: number[], phase: Phase, ambiguous = false): void {
    bestEffort(() =>
      append({
        ordinal: ++sequence,
        requests,
        correlation: eventCorrelation(requests, ambiguous),
        phase,
      }),
    );
  }
  function failure(
    requests: number[],
    phase: FailurePhase,
    error: unknown,
    ambiguous = false,
  ): void {
    bestEffort(() =>
      append({
        ordinal: ++sequence,
        requests,
        correlation: eventCorrelation(requests, ambiguous),
        phase,
        error: scalars(error),
      }),
    );
  }
  function eventCorrelation(requests: number[], ambiguous: boolean): Correlation {
    const current = correlation();
    return { ...current, ambiguous: ambiguous || current.ambiguous || requests.length !== 1 };
  }
  function observe(
    value: unknown,
    fulfilled: () => void,
    rejected: (error: unknown) => void,
  ): void {
    // Two nonthrowing reactions keep the original Promise and caller settlement intact.
    // They add microtasks and mark the original rejection handled; they are not timing-neutral.
    bestEffort(() => {
      apply(then, value, [
        () => bestEffort(fulfilled),
        (error: unknown) => bestEffort(() => rejected(error)),
      ]);
    });
  }
  function wrapCallback(callback: Function, id: number) {
    let granted = false;
    return {
      callback: new Proxy(callback, {
        apply(target, receiver, args: unknown[]) {
          granted = args[0] !== null;
          emit([id], granted ? "callback-granted" : "callback-null");
          try {
            return apply(target, receiver, args);
          } catch (error) {
            failure([id], "callback-threw", error);
            throw error;
          }
        },
      }),
      granted: () => granted,
    };
  }
  function request(target: LockManager["request"], receiver: unknown, args: unknown[]): unknown {
    const name = args[0];
    const callback = args[2];
    if (
      typeof name !== "string" ||
      !name.startsWith(prefix) ||
      name.startsWith(`${prefix}bootstrap:`) ||
      typeof callback !== "function"
    )
      return apply(target, receiver, args);
    const id = ++requestSequence;
    let owner: Correlation = { jobs: [], count: null, ambiguous: true };
    bestEffort(() => {
      owner = correlation();
    });
    const wrapped = wrapCallback(callback, id);
    const forwarded = args.slice();
    forwarded[2] = wrapped.callback;
    emit([id], "request-invoked");
    let result: unknown;
    try {
      result = apply(target, receiver, forwarded);
    } catch (error) {
      failure([id], "request-threw", error);
      throw error;
    }
    observe(
      result,
      () => {
        emit([id], "request-fulfilled");
        if (!wrapped.granted()) return;
        if (awaitingQuery.size === 32) {
          awaitingQuery.delete(awaitingQuery.keys().next().value!);
          state.unavailable++;
        }
        awaitingQuery.set(id, owner);
      },
      (error) => failure([id], "request-rejected", error),
    );
    return result;
  }
  function query(target: LockManager["query"], receiver: unknown, args: unknown[]): unknown {
    const ids: number[] = [];
    let ambiguous = false;
    bestEffort(() => {
      const current = correlation();
      for (const [id, owner] of awaitingQuery) {
        if (!owner.jobs.some((job) => current.jobs.includes(job))) continue;
        ids.push(id);
        ambiguous ||= owner.ambiguous;
      }
      for (const id of ids) awaitingQuery.delete(id);
    });
    if (!ids.length) return apply(target, receiver, args);
    emit(ids, "query-invoked", ambiguous);
    let result: unknown;
    try {
      result = apply(target, receiver, args);
    } catch (error) {
      failure(ids, "query-threw", error, ambiguous);
      throw error;
    }
    observe(
      result,
      () => emit(ids, "query-fulfilled", ambiguous),
      (error) => failure(ids, "query-rejected", error, ambiguous),
    );
    return result;
  }
  bestEffort(() => {
    const nativeRequest = manager.request;
    const nativeQuery = manager.query;
    Object.defineProperties(manager, {
      request: {
        configurable: true,
        writable: true,
        value: new Proxy(nativeRequest, { apply: request }),
      },
      query: {
        configurable: true,
        writable: true,
        value: new Proxy(nativeQuery, { apply: query }),
      },
    });
  });
  return {
    snapshot(): ContinuityLockDiagnostic {
      try {
        return structuredClone(state);
      } catch {
        return emptyContinuityDiagnostic(++state.unavailable);
      }
    },
  };
}

const errorNames = [
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "InvalidStateError",
  "NotSupportedError",
  "SecurityError",
  "UnknownError",
  "FilesystemError",
  "NotFoundError",
  "QuotaExceededError",
  "DataError",
  "OperationError",
];
function scalars(error: unknown): ErrorScalars {
  // Arbitrary messages/names can contain workspace tokens. Retain only known names.
  const name = record(error) ? error.name : null;
  const errno = record(error) ? error.errno : null;
  return {
    type: error === null ? "null" : typeof error,
    name: typeof name === "string" && errorNames.includes(name) ? name : null,
    errno: typeof errno === "number" && Number.isFinite(errno) ? errno : null,
    textOmitted: true,
  };
}

export function installContinuityLockDiagnostic(
  jobs: () => { activeJobs: number[]; activeJobCount: number },
): void {
  try {
    window.__continuityLocks = observeContinuityLocks(navigator.locks, jobs);
  } catch {
    window.__continuityLocks = { snapshot: () => emptyContinuityDiagnostic() };
  }
}

export function continuityDiagnosticSnapshot(): ContinuityLockDiagnostic {
  try {
    return projectContinuityDiagnostic(window.__continuityLocks?.snapshot());
  } catch {
    return emptyContinuityDiagnostic();
  }
}

const phases: readonly Phase[] = [
  "request-invoked",
  "callback-null",
  "callback-granted",
  "request-fulfilled",
  "query-invoked",
  "query-fulfilled",
];
const failurePhases: readonly FailurePhase[] = [
  "request-threw",
  "callback-threw",
  "request-rejected",
  "query-threw",
  "query-rejected",
];
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid diagnostic count");
  return value;
}
function projectCorrelation(value: unknown): Correlation {
  if (!record(value) || !Array.isArray(value.jobs)) throw new Error("Invalid correlation");
  const jobs = value.jobs.slice(0, 8).map(count);
  const total = value.count === null ? null : count(value.count);
  return {
    jobs,
    count: total,
    ambiguous: value.ambiguous !== false || total !== 1 || jobs.length !== 1,
  };
}
function projectEvent(value: unknown): Event {
  if (!record(value) || !Array.isArray(value.requests)) throw new Error("Invalid lock diagnostic");
  const base = {
    ordinal: count(value.ordinal),
    requests: value.requests.slice(0, 32).map(count),
    correlation: projectCorrelation(value.correlation),
  };
  const phase = phases.find((phase) => phase === value.phase);
  if (phase) return { ...base, phase };
  const failed = failurePhases.find((phase) => phase === value.phase);
  if (!failed || !record(value.error)) throw new Error("Invalid lock phase");
  const error = scalars(value.error);
  const candidateType = value.error.type;
  const type = [
    "undefined",
    "object",
    "boolean",
    "number",
    "string",
    "function",
    "symbol",
    "bigint",
    "null",
  ].find((type) => type === candidateType);
  return { ...base, phase: failed, error: { ...error, type: type ?? "unknown" } };
}
export function projectContinuityDiagnostic(value: unknown): ContinuityLockDiagnostic {
  try {
    if (!record(value) || value.kind !== "page-continuity-locks" || !Array.isArray(value.records))
      return emptyContinuityDiagnostic();
    const result: ContinuityLockDiagnostic = {
      kind: "page-continuity-locks",
      records: value.records.slice(-32).map(projectEvent),
      dropped: count(value.dropped) + Math.max(0, value.records.length - 32),
      unavailable: count(value.unavailable),
      ambiguous: count(value.ambiguous),
    };
    while (encode(stringify(result)).byteLength > 8192) {
      result.records.shift();
      result.dropped++;
    }
    return result;
  } catch {
    return emptyContinuityDiagnostic();
  }
}

declare global {
  interface Window {
    __continuityLocks?: { snapshot(): ContinuityLockDiagnostic };
  }
}
