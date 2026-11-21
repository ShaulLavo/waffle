import { startStatus, type OutcomeWord } from "../proc/outcome.js";
import { readStartProgress, type StartProgressStep } from "./worker-memory.js";
import type { ProcessLifecycle } from "../proc/types.js";

/**
 * Steps of one process start, in order. See docs/process-observation.md, "Start states".
 * The worker's bootstrap steps (`runtime-loaded`, `group-joined`, `modules-loaded`) share one
 * cell, so the page sees only the latest when it looks, stamped with the worker's own time.
 * `memory-bound` and `running` are stamped when the page first saw them.
 */
export type ProcessStartStep =
  | "launching"
  | "worker-constructed"
  | "start-posted"
  | "worker-started"
  | StartProgressStep
  | "memory-bound"
  | "instantiated"
  | "running";

const steps: readonly ProcessStartStep[] = [
  "launching",
  "worker-constructed",
  "start-posted",
  "worker-started",
  "runtime-loaded",
  "group-joined",
  "modules-loaded",
  "memory-bound",
  "instantiated",
  "running",
];

/** An authority-free snapshot of one live process start. */
export interface ProcessStartState {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly generation: number;
  readonly executable: string;
  /** The latest step reached, in start order. */
  readonly step: ProcessStartStep;
  /** `performance.now()` milliseconds for each step the page saw. */
  readonly at: Readonly<Partial<Record<ProcessStartStep, number>>>;
}

/** One small record per launch. The broker stamps it at points it already passes. */
export interface ProcessStartRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly generation: number;
  readonly executable: string;
  readonly at: Partial<Record<ProcessStartStep, number>>;
}

export function processStartRecord(context: ProcessLifecycle): ProcessStartRecord {
  return {
    pid: context.pid,
    parentPid: context.parentPid,
    job: context.job,
    generation: context.generation,
    executable: context.request.executable,
    at: { launching: performance.now() },
  };
}

export function markStart(record: ProcessStartRecord, step: ProcessStartStep): void {
  record.at[step] ??= performance.now();
}

function entered(outcome: OutcomeWord): boolean {
  try {
    return startStatus(outcome) === 0;
  } catch {
    // A collected row has no start left to observe.
    return false;
  }
}

/**
 * Stamps the steps visible in shared state: the worker's memory sample cell (negative until
 * linear memory is bound) and the committed-entry bit of the outcome word. Stops once running.
 */
export function observeStart(
  record: ProcessStartRecord,
  memory: BigInt64Array,
  outcome: OutcomeWord,
  instantiated = false,
): void {
  if (record.at.running !== undefined) return;
  if (record.at["memory-bound"] === undefined) {
    const sample = Atomics.load(memory, 0);
    const progress = readStartProgress(sample);
    if (progress) record.at[progress.step] ??= progress.at;
    if (sample >= 0n) markStart(record, "memory-bound");
  }
  // Stamp in start order, so one message that shows several steps keeps their times ordered.
  if (instantiated) markStart(record, "instantiated");
  if (entered(outcome)) markStart(record, "running");
}

/**
 * Called for each worker message until the guest runs. Bootstrap posts its `worker-start`
 * phase first and an `instantiate` phase before entry, so no message is added for this.
 */
export function startMessage(
  record: ProcessStartRecord,
  data: { readonly type?: unknown; readonly name?: unknown } | undefined,
  memory: BigInt64Array,
  outcome: OutcomeWord,
): void {
  if (record.at.running !== undefined) return;
  markStart(record, "worker-started");
  observeStart(record, memory, outcome, data?.type === "phase" && data.name === "instantiate");
}

export function startSnapshot(record: ProcessStartRecord): ProcessStartState {
  let step: ProcessStartStep = "launching";
  for (const candidate of steps) if (record.at[candidate] !== undefined) step = candidate;
  return {
    pid: record.pid,
    parentPid: record.parentPid,
    job: record.job,
    generation: record.generation,
    executable: record.executable,
    step,
    at: { ...record.at },
  };
}
