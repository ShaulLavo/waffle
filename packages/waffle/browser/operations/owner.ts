import {
  ACKNOWLEDGED,
  elapsedFrom,
  Field,
  MAX_VALUE,
  OPERATION_BYTES,
  OPERATION_SLOTS,
  OperationCells,
  operationClock,
  PIPE_OFFSET,
  RESOLVE_OFFSET,
  Result,
} from "./cells.js";
import type { GuestOperationBinding } from "./protocol.js";
import type {
  OperationDiagnostics,
  OperationImage,
  OperationPhase,
  OperationResult,
  OperationSummary,
} from "./types.js";

type Image = Pick<OperationImage, "pid" | "generation" | "captureId">;
interface Capture {
  readonly image: Image;
  readonly cells: OperationCells;
  readonly origin: number;
  pipeReadWait?: OperationSummary;
  fsResolve?: OperationSummary;
}

function result(code: number): OperationResult | undefined {
  switch (code) {
    case Result.completed:
      return { phase: "completed" };
    case Result.signalPending:
      return { phase: "cancelled", reason: "signal-pending" };
    case Result.processStop:
      return { phase: "cancelled", reason: "process-stop" };
    case Result.filesystemCancelled:
      return { phase: "cancelled", reason: "filesystem-cancelled" };
    case Result.pollError:
      return { phase: "failed", reason: "poll-error" };
    case Result.resolveError:
      return { phase: "failed", reason: "resolve-error" };
    case Result.transportError:
      return { phase: "failed", reason: "transport-error" };
    case Result.submissionError:
      return { phase: "failed", reason: "submission-error" };
  }
}

function readSummary(capture: Capture, offset: number, now: number): OperationSummary | undefined {
  const { cells, origin } = capture;
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = cells.read(offset + Field.sequence);
    if (first === undefined || first % 2 !== 0) continue;
    const active = cells.read(offset + Field.active);
    const started = cells.read(offset + Field.started);
    const code = cells.read(offset + Field.result);
    const duration = cells.read(offset + Field.duration);
    const timed = cells.read(offset + Field.timed);
    const completed = cells.read(offset + Field.completed);
    const cancelled = cells.read(offset + Field.cancelled);
    const failed = cells.read(offset + Field.failed);
    const accepted = offset === RESOLVE_OFFSET && cells.read(ACKNOWLEDGED) === active;
    if (cells.read(offset + Field.sequence) !== first) continue;
    if (
      active === undefined ||
      started === undefined ||
      code === undefined ||
      duration === undefined ||
      completed === undefined ||
      cancelled === undefined ||
      failed === undefined
    )
      continue;
    const phase: OperationPhase =
      offset === PIPE_OFFSET ? "waiting" : accepted ? "accepted" : "submitted";
    const latest = result(code);
    return {
      ...(active
        ? {
            active: {
              phase,
              elapsedMs: started === MAX_VALUE ? null : elapsedFrom(origin + started, now),
            },
          }
        : {}),
      ...(latest ? { latest: { ...latest, elapsedMs: timed ? duration : null } } : {}),
      completed,
      cancelled,
      failed,
    };
  }
}

function retire(summary: OperationSummary | undefined): OperationSummary | undefined {
  if (!summary?.active) return summary;
  const { active, ...confirmed } = summary;
  return {
    ...confirmed,
    retirement: { phase: "retired-unconfirmed", elapsedMs: active.elapsedMs },
  };
}

function copy(summary: OperationSummary | undefined): OperationSummary | undefined {
  if (!summary) return;
  return {
    completed: summary.completed,
    cancelled: summary.cancelled,
    failed: summary.failed,
    ...(summary.active ? { active: { ...summary.active } } : {}),
    ...(summary.latest ? { latest: { ...summary.latest } } : {}),
    ...(summary.retirement ? { retirement: { ...summary.retirement } } : {}),
  };
}

export class OperationOwner {
  private buffer?: SharedArrayBuffer;
  private unavailable = false;
  private readonly slots = new Array<Capture | undefined>(OPERATION_SLOTS).fill(undefined);
  private readonly history: OperationImage[] = [];
  private nextHistory = 0;
  private captureId = 0;
  private skippedImages = 0;
  constructor(
    private readonly allocate: (length: number) => SharedArrayBuffer,
    private readonly owned: (image: Image) => boolean,
  ) {}

  enroll(pid: number, generation: number): GuestOperationBinding | undefined {
    if (this.unavailable || this.captureId === MAX_VALUE) return;
    if (!this.buffer) {
      try {
        this.buffer = this.allocate(OPERATION_BYTES);
      } catch {
        this.unavailable = true;
        return;
      }
    }
    this.reconcile();
    const slot = this.slots.indexOf(undefined);
    if (slot < 0) {
      this.skippedImages = Math.min(MAX_VALUE, this.skippedImages + 1);
      return;
    }
    const captureId = ++this.captureId;
    const origin = operationClock();
    const binding = { buffer: this.buffer, slot, captureId, origin };
    const cells = new OperationCells(binding);
    cells.assign();
    this.slots[slot] = { image: { pid, generation, captureId }, cells, origin };
    return binding;
  }

  snapshot(): OperationDiagnostics {
    if (this.unavailable) return { status: "unavailable" };
    if (!this.buffer) return { status: "empty" };
    const owned = this.reconcile();
    const history = this.history
      .slice(this.nextHistory)
      .concat(this.history.slice(0, this.nextHistory));
    const departed = history.map(({ pipeReadWait, fsResolve, ...image }) => ({
      ...image,
      pipeReadWait: copy(pipeReadWait),
      fsResolve: copy(fsResolve),
    }));
    return { status: "recording", owned, departed, skippedImages: this.skippedImages };
  }

  private reconcile(): OperationImage[] {
    const now = operationClock();
    const rows: OperationImage[] = [];
    for (let slot = 0; slot < OPERATION_SLOTS; slot++) {
      const capture = this.slots[slot];
      if (!capture) continue;
      const pipeReadWait = readSummary(capture, PIPE_OFFSET, now);
      const fsResolve = readSummary(capture, RESOLVE_OFFSET, now);
      if (pipeReadWait) capture.pipeReadWait = pipeReadWait;
      if (fsResolve) capture.fsResolve = fsResolve;
      if (!this.owned(capture.image)) {
        this.archive(slot, capture);
        continue;
      }
      rows.push({ ...capture.image, pipeReadWait: copy(pipeReadWait), fsResolve: copy(fsResolve) });
    }
    return rows;
  }

  private archive(slot: number, capture: Capture): void {
    new OperationCells({ buffer: this.buffer!, slot, captureId: 0 }).assign();
    this.slots[slot] = undefined;
    this.history[this.nextHistory] = {
      ...capture.image,
      pipeReadWait: retire(capture.pipeReadWait),
      fsResolve: retire(capture.fsResolve),
    };
    this.nextHistory = (this.nextHistory + 1) % OPERATION_SLOTS;
  }
}
