import { ReadRefusal, nodeMetadata, readRange } from "./workspace-protocol.js";
import {
  WORKSPACE_READ_LIMITS,
  type ByteRange,
  type FileTarget,
  type FileVersion,
  type ReadFailure,
  type ReadOutcome,
  type ReadValue,
  type VersionLease,
  type VersionStat,
  type WorkspaceVfs,
} from "./workspace-types.js";

export type WorkspaceReadStep =
  | { readonly kind: "chunk"; readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "end" }
  | ReadFailure
  | { readonly kind: "pressure"; readonly resource: "pull" };

export interface WorkspaceReadStream {
  readonly stat: VersionStat;
  readonly range: ByteRange;
  next(): Promise<WorkspaceReadStep>;
  /** Stops admission immediately, then joins the accepted pull and original lease close. */
  close(): Promise<void>;
}

export class WorkspaceReadContractError extends Error {
  override readonly name = "WorkspaceReadContractError";
  constructor(
    readonly mismatch:
      | { readonly kind: "range" }
      | { readonly kind: "stat"; readonly stat: VersionStat } = { kind: "range" },
  ) {
    super("Lease returned an invalid bounded range");
  }
}

const END: WorkspaceReadStep = Object.freeze({ kind: "end" });
const CANCELLED: WorkspaceReadStep = Object.freeze({ kind: "cancelled" });
const PULL: WorkspaceReadStep = Object.freeze({ kind: "pressure", resource: "pull" });

/** Pins one version. Each next() borrows at most one existing 64 KiB read result. */
export async function openWorkspaceRead(
  workspace: WorkspaceVfs,
  target: FileTarget,
  range?: ByteRange,
  atVersion?: FileVersion,
  signal?: AbortSignal,
): Promise<ReadOutcome<WorkspaceReadStream>> {
  if (signal?.aborted) return { kind: "cancelled" };
  let requested: ByteRange | undefined;
  try {
    requested = readRange(range);
  } catch (error) {
    if (error instanceof ReadRefusal) return error.failure;
    throw error;
  }
  const pinned = await workspace.pin(target, atVersion, signal);
  if (pinned.kind !== "ok") return pinned;
  const lease = pinned.value;
  if (signal?.aborted) {
    await lease.close();
    return { kind: "cancelled" };
  }
  let stream: LeaseStream;
  try {
    stream = new LeaseStream(lease, requested, signal);
  } catch (error) {
    try {
      await lease.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Workspace read opening cleanup failed");
    }
    throw error;
  }
  if (!signal?.aborted) return { kind: "ok", value: stream };
  await stream.close();
  return { kind: "cancelled" };
}

function snapshotStat(stat: VersionStat): VersionStat {
  const { id, version, cut, size, mtime, mode } = stat;
  return Object.freeze({
    ...nodeMetadata(stat),
    id,
    version,
    size,
    mtime,
    mode,
    cut: Object.freeze({ ...cut, watermark: Object.freeze({ ...cut.watermark }) }),
  });
}
function sameStat(first: VersionStat, second: VersionStat): boolean {
  return (
    first.id === second.id &&
    first.version === second.version &&
    first.kind === second.kind &&
    first.size === second.size &&
    first.mtime === second.mtime &&
    first.mode === second.mode &&
    first.cut.workspace === second.cut.workspace &&
    first.cut.generation === second.cut.generation &&
    first.cut.watermark.history === second.cut.watermark.history &&
    first.cut.watermark.seq === second.cut.watermark.seq
  );
}
function ownedExact(bytes: unknown, length: number): bytes is Uint8Array<ArrayBuffer> {
  if (!(bytes instanceof Uint8Array) || bytes.constructor !== Uint8Array) return false;
  const buffer = bytes.buffer;
  return (
    buffer instanceof ArrayBuffer &&
    !("resizable" in buffer && buffer.resizable) &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === length &&
    buffer.byteLength === length
  );
}
function transient(step: ReadFailure): boolean {
  return (
    step.kind === "pressure" &&
    (step.resource === "operations" ||
      step.resource === "result-bytes" ||
      step.resource === "metadata")
  );
}

class LeaseStream implements WorkspaceReadStream {
  readonly stat: VersionStat;
  readonly range: ByteRange;
  private position: number;
  private readonly end: number;
  private terminal: Promise<WorkspaceReadStep> | undefined;
  private inflight: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private readonly abort = () => {
    void this.close().catch(() => {});
  };

  constructor(
    private readonly lease: VersionLease,
    requested?: ByteRange,
    private readonly signal?: AbortSignal,
  ) {
    this.stat = snapshotStat(lease.stat);
    const offset = requested?.offset ?? 0;
    this.range = Object.freeze({
      offset,
      length: Math.min(requested?.length ?? this.stat.size, Math.max(0, this.stat.size - offset)),
    });
    this.position = offset;
    this.end = offset + this.range.length;
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  next(): Promise<WorkspaceReadStep> {
    if (this.terminal) return this.terminal;
    if (this.inflight) return Promise.resolve(PULL);
    if (this.position === this.end) return this.finish(Promise.resolve(END));
    // Reserve before a provider's read getter, synchronous read body, or result getter can reenter.
    // The drain is separate from next's result so release never joins its own terminal promise.
    const drained = Promise.withResolvers<void>();
    const result = Promise.withResolvers<WorkspaceReadStep>();
    this.inflight = drained.promise;
    const work = this.pull(
      this.position,
      Math.min(WORKSPACE_READ_LIMITS.chunk, this.end - this.position),
      result.promise,
    );
    const settled = () => {
      this.inflight = undefined;
      drained.resolve();
    };
    void work.then(
      (step) => {
        settled();
        result.resolve(step);
      },
      (error) => {
        settled();
        result.reject(error);
      },
    );
    return result.promise;
  }

  private async pull(
    offset: number,
    length: number,
    pending: Promise<WorkspaceReadStep>,
  ): Promise<WorkspaceReadStep> {
    try {
      const read = this.lease.read;
      if (this.terminal) return this.terminal;
      const result = await read.call(this.lease, { offset, length }, this.lifetime.signal);
      if (this.terminal) return this.terminal;
      const kind = result.kind;
      if (this.terminal) return this.terminal;
      if (kind === "ok") return this.accept(result.value, offset, length);
      const retry = transient(result);
      if (this.terminal) return this.terminal;
      if (retry) return result;
      return this.finish(Promise.resolve(result));
    } catch (error) {
      if (this.terminal) return this.terminal;
      this.terminal = pending;
      void this.terminal.catch(() => {});
      void this.release();
      throw error;
    }
  }

  private accept(
    value: ReadValue,
    offset: number,
    length: number,
  ): WorkspaceReadStep | Promise<WorkspaceReadStep> {
    if (this.terminal) return this.terminal;
    const stat = snapshotStat(value.stat);
    if (!sameStat(stat, this.stat)) throw new WorkspaceReadContractError({ kind: "stat", stat });
    const { range, bytes } = value;
    if (range.offset !== offset || range.length !== length || !ownedExact(bytes, length))
      throw new WorkspaceReadContractError();
    if (this.terminal) return this.terminal;
    this.position = offset + length;
    return { kind: "chunk", offset, bytes };
  }

  private finish(step: Promise<WorkspaceReadStep>): Promise<WorkspaceReadStep> {
    this.terminal ??= step;
    void this.release();
    return this.terminal;
  }

  private release(): Promise<void> {
    if (this.releasing) return this.releasing;
    const released = Promise.withResolvers<void>();
    this.releasing = released.promise;
    void this.releasing.catch(() => {});
    this.signal?.removeEventListener("abort", this.abort);
    this.lifetime.abort();
    void Promise.resolve(this.inflight)
      .then(() => this.lease.close())
      .then(released.resolve, released.reject);
    return this.releasing;
  }

  close(): Promise<void> {
    this.terminal ??= Promise.resolve(CANCELLED);
    return this.release();
  }
}
