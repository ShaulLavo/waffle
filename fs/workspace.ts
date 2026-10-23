import type { FilesystemClient } from "./client.js";
import { FilesystemError, isRevoked } from "./protocol.js";
import {
  namespacePage,
  namespaceCut,
  watermark,
  workspaceChanges,
  ReadRefusal,
  ReaderLifetime,
  readTarget,
  readRange,
  readVersion,
  readCut,
  readReply,
  readOpenReply,
  versionStat,
} from "./workspace-protocol.js";
import { ChangeBudget, NamespaceIndex, ProjectionPressure } from "./workspace-index.js";
import {
  WORKSPACE_LIMITS,
  type WorkspaceVfs,
  type NamespaceCut,
  type Watermark,
  type SnapshotOptions,
  type SnapshotCursor,
  type SnapshotPage,
  type WorkspaceChangePage,
  type ChangeBatch,
  type FileTarget,
  type ByteRange,
  type FileVersion,
  type VersionStat,
  type ReadValue,
  type ReadOutcome,
  type ReadFailure,
  type VersionLease,
  WORKSPACE_READ_LIMITS,
} from "./workspace-types.js";
export * from "./workspace-types.js";
export type { WorkspaceConfiguration } from "./workspace-protocol.js";

type TerminalPage = Exclude<SnapshotPage, { kind: "entries" }>;
type Accepted = { readonly cut: NamespaceCut; readonly index: NamespaceIndex; next: Watermark };
type CursorState =
  | { readonly kind: "scanning"; readonly index: NamespaceIndex }
  | { readonly kind: "terminal"; readonly page: TerminalPage };
const owners = new WeakMap<FilesystemClient, WorkspaceVfs>();
function options(value: SnapshotOptions = {}): Required<SnapshotOptions> {
  const prefix = value.prefix ?? "/",
    includeDirs = value.includeDirs ?? true;
  if (
    typeof prefix !== "string" ||
    !prefix.startsWith("/") ||
    prefix.includes("\0") ||
    typeof includeDirs !== "boolean"
  )
    throw new FilesystemError(28, "invalid snapshot options");
  return { prefix, includeDirs };
}
function chunkRefusal(value: unknown): ReadFailure {
  const refusal = readReply(value);
  if (refusal.kind === "ok") throw new FilesystemError(29);
  return refusal;
}
function same(a: Watermark, b: Watermark): boolean {
  return a.history === b.history && a.seq === b.seq;
}
/** Trusted root observer. Guests never inherit the observer grant. */
export function createWorkspaceVfs(client: FilesystemClient): WorkspaceVfs {
  if (!client.connection.publication?.observer)
    throw new FilesystemError(2, "workspace access requires the root observer grant");
  const previous = owners.get(client);
  if (previous) return previous;
  const owner = new WorkspaceOwner(client);
  const workspace: WorkspaceVfs = Object.freeze({
    read: owner.read.bind(owner),
    stat: owner.stat.bind(owner),
    pin: owner.pin.bind(owner),
    snapshot: owner.snapshot.bind(owner),
    changes: owner.changes.bind(owner),
    close: owner.close.bind(owner),
  });
  owners.set(client, workspace);
  return workspace;
}
class WorkspaceOwner implements WorkspaceVfs {
  private cursors = new Set<RemoteSnapshot>();
  private serial = 0;
  private readSerial = 0;
  private closed = false;
  private pulling = false;
  private accepted: Accepted | undefined;
  private closing: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private readonly leases = new Set<RemoteVersionLease>();
  private activeReads = 0;
  private readControl: Promise<void> = Promise.resolve();
  constructor(readonly client: FilesystemClient) {}
  get stopped(): boolean {
    return this.closed || isRevoked(this.client.connection);
  }
  snapshot(value?: SnapshotOptions, signal?: AbortSignal): SnapshotCursor {
    const settings = options(value);
    const terminal: TerminalPage | undefined = this.stopped
      ? { kind: "stopped" }
      : signal?.aborted
        ? { kind: "cancelled" }
        : this.cursors.size >= WORKSPACE_LIMITS.cursors
          ? { kind: "pressure", resource: "cursor" }
          : undefined;
    const cursor = new RemoteSnapshot(this, settings, signal, terminal);
    if (!terminal) this.cursors.add(cursor);
    return cursor;
  }
  nextSerial(): number {
    const serial = ++this.serial;
    if (!Number.isSafeInteger(serial)) throw new FilesystemError(33);
    return serial;
  }
  release(cursor: RemoteSnapshot): void {
    this.cursors.delete(cursor);
  }
  accept(cut: NamespaceCut, index: NamespaceIndex): void {
    if (!this.stopped) this.accepted = { cut, index, next: cut.watermark };
  }
  async request(
    operation: string,
    args: unknown[] = [],
    signal?: AbortSignal,
    capacity?: number,
  ): Promise<unknown> {
    if (signal?.aborted) throw new FilesystemError(11);
    const grant: unknown[] = [this.client.connection.publication!.observer];
    const completion = this.client.submit(operation, grant.concat(args), undefined, capacity);
    const cancel = () => completion.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await completion.value();
    } finally {
      signal?.removeEventListener("abort", cancel);
      completion.release();
    }
  }
  private nextReadSerial(): number {
    const id = ++this.readSerial;
    if (!Number.isSafeInteger(id)) throw new FilesystemError(33);
    return id;
  }
  private admitRead(): boolean {
    if (this.activeReads >= WORKSPACE_READ_LIMITS.operations) return false;
    this.activeReads++;
    return true;
  }
  private readSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }
  private readFailure(error: unknown, signal?: AbortSignal): ReadOutcome<never> {
    if (this.stopped) return { kind: "stopped" };
    if (signal?.aborted) return { kind: "cancelled" };
    if (error instanceof ReadRefusal) return error.failure;
    if (error instanceof FilesystemError && error.errno === 6)
      return { kind: "pressure", resource: "operations" };
    return {
      kind: "io",
      message: error instanceof Error ? error.message : "Filesystem read failed",
    };
  }
  async stat(
    target: FileTarget,
    at?: NamespaceCut,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<VersionStat>> {
    if (this.stopped) return { kind: "stopped" };
    if (signal?.aborted) return { kind: "cancelled" };
    if (!this.admitRead()) return { kind: "pressure", resource: "operations" };
    try {
      const result = readReply(
        await this.request(
          "publicationReadStat",
          [this.nextReadSerial(), readTarget(target), undefined, undefined, readCut(at)],
          this.readSignal(signal),
        ),
      );
      return result.kind === "ok" ? { kind: "ok", value: versionStat(result.value) } : result;
    } catch (error) {
      return this.readFailure(error, signal);
    } finally {
      this.activeReads--;
    }
  }
  async pin(
    target: FileTarget,
    atVersion?: FileVersion,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<VersionLease>> {
    if (this.stopped) return { kind: "stopped" };
    if (signal?.aborted) return { kind: "cancelled" };
    if (!this.admitRead()) return { kind: "pressure", resource: "operations" };
    const id = this.nextReadSerial();
    let adopted = false;
    try {
      const result = readReply(
        await this.request(
          "publicationReadPin",
          [id, readTarget(target), undefined, readVersion(atVersion)],
          this.readSignal(signal),
        ),
      );
      if (result.kind !== "ok") return result;
      const opened = readOpenReply(result.value);
      if (opened.serial !== id) throw new FilesystemError(29);
      if (this.stopped || signal?.aborted)
        return this.stopped ? { kind: "stopped" } : { kind: "cancelled" };
      const lease = new RemoteVersionLease(this, id, opened.stat);
      this.leases.add(lease);
      adopted = true;
      return { kind: "ok", value: lease };
    } catch (error) {
      return this.readFailure(error, signal);
    } finally {
      try {
        if (!adopted) await this.closeRead(id);
      } finally {
        this.activeReads--;
      }
    }
  }
  read(
    target: FileTarget,
    range?: ByteRange,
    atVersion?: FileVersion,
    signal?: AbortSignal,
  ): Promise<ReadOutcome<ReadValue>> {
    return this.copyRead(
      "publicationReadOpen",
      () => [readTarget(target), readRange(range), readVersion(atVersion)],
      signal,
    );
  }
  readLease(id: number, range?: ByteRange, signal?: AbortSignal): Promise<ReadOutcome<ReadValue>> {
    return this.copyRead("publicationReadLeaseOpen", () => [id, readRange(range)], signal);
  }
  private async copyRead(
    operation: string,
    args: () => unknown[],
    signal?: AbortSignal,
  ): Promise<ReadOutcome<ReadValue>> {
    if (this.stopped) return { kind: "stopped" };
    if (signal?.aborted) return { kind: "cancelled" };
    if (!this.admitRead()) return { kind: "pressure", resource: "operations" };
    const id = this.nextReadSerial(),
      lifetime = this.readSignal(signal);
    try {
      const parameters: unknown[] = [id];
      const result = readReply(await this.request(operation, parameters.concat(args()), lifetime));
      if (result.kind !== "ok") return result;
      const opened = readOpenReply(result.value);
      if (opened.serial !== id || opened.range.length > WORKSPACE_READ_LIMITS.result)
        throw new FilesystemError(29);
      const bytes = new Uint8Array(opened.range.length);
      for (let offset = 0; offset < bytes.length; offset += WORKSPACE_READ_LIMITS.chunk) {
        const part = await this.request(
          "publicationReadChunk",
          [id, offset],
          lifetime,
          Math.min(WORKSPACE_READ_LIMITS.chunk, bytes.length - offset),
        );
        if (!(part instanceof Uint8Array)) return chunkRefusal(part);
        if (part.length !== Math.min(WORKSPACE_READ_LIMITS.chunk, bytes.length - offset))
          throw new FilesystemError(29);
        bytes.set(part, offset);
      }
      if (this.stopped || signal?.aborted)
        return this.stopped ? { kind: "stopped" } : { kind: "cancelled" };
      return {
        kind: "ok",
        value: { stat: opened.stat, range: Object.freeze(opened.range), bytes },
      };
    } catch (error) {
      return this.readFailure(error, signal);
    } finally {
      try {
        await this.closeRead(id);
      } finally {
        this.activeReads--;
      }
    }
  }
  closeRead(id?: number): Promise<void> {
    const close = async () => {
      try {
        if (!isRevoked(this.client.connection)) {
          await this.request("publicationReadClose", [id]);
          return;
        }
      } catch (error) {
        if (!isRevoked(this.client.connection)) throw error;
      }
      this.client.sweep();
      await new ReaderLifetime(this.client.connection.publication!).join();
    };
    const closing = this.readControl.then(close, close);
    this.readControl = closing.catch(() => {});
    return closing;
  }
  forgetLease(lease: RemoteVersionLease): void {
    this.leases.delete(lease);
  }
  async closeCursor(serial?: number): Promise<void> {
    if (isRevoked(this.client.connection)) return;
    try {
      await this.request("publicationNamespaceClose", [serial]);
    } catch (error) {
      if (!this.stopped) throw error;
    }
  }
  async changes(after: Watermark, signal?: AbortSignal): Promise<WorkspaceChangePage> {
    const position = watermark(after);
    if (this.stopped) return { kind: "stopped" };
    if (signal?.aborted) return { kind: "cancelled" };
    if (this.pulling) return { kind: "pressure", resource: "pull" };
    this.pulling = true;
    const accepted = this.accepted;
    try {
      const reply = workspaceChanges(
        await this.request(
          "publicationNamespaceChanges",
          [position],
          signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
        ),
      );
      if (this.stopped) return { kind: "stopped" };
      if (signal?.aborted) return { kind: "cancelled" };
      if (
        reply.kind === "gap" ||
        !accepted ||
        this.accepted !== accepted ||
        !same(after, accepted.next)
      ) {
        this.accepted = undefined;
        return {
          kind: "gap",
          current: reply.current,
          oldestAvailable: reply.oldestAvailable,
          resync: "snapshot",
        };
      }
      const batches = this.project(reply, accepted);
      accepted.next = reply.next;
      return { kind: "changes", batches, next: reply.next };
    } catch (error) {
      this.accepted = undefined;
      if (this.stopped) return { kind: "stopped" };
      if (signal?.aborted) return { kind: "cancelled" };
      if (error instanceof ProjectionPressure)
        return { kind: "pressure", resource: error.resource };
      throw error;
    } finally {
      this.pulling = false;
    }
  }
  private project(
    reply: ReturnType<typeof workspaceChanges>,
    accepted: Accepted,
  ): readonly ChangeBatch[] {
    const budget = new ChangeBudget();
    return reply.publications.map((publication) => {
      const cut = namespaceCut(accepted.cut.workspace, publication.receipt.cut);
      const actor = `${cut.watermark.history}/${publication.receipt.id.session}`;
      budget.take(256);
      return {
        seq: cut.watermark.seq,
        generation: cut.generation,
        actor,
        transaction: { actor, sequence: publication.receipt.id.sequence },
        durability: publication.receipt.durability,
        changes: accepted.index.project(publication.changes, budget),
      };
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.accepted = undefined;
    this.lifetime.abort();
    const closing = Array.from(this.cursors, (cursor) => cursor.stop());
    this.closing = Promise.allSettled(
      closing.concat(
        Array.from(this.leases, (lease) => lease.close()),
        [this.closeCursor(), this.closeRead()],
      ),
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Workspace close failed");
    });
    return this.closing;
  }
}
class RemoteSnapshot implements SnapshotCursor {
  private state: CursorState;
  private pulling = false;
  private closing: Promise<void> | undefined;
  private serial: number | undefined;
  private readonly lifetime = new AbortController();
  private readonly abort = () => {
    void this.finish({ kind: "cancelled" }).catch(() => {});
  };
  constructor(
    private readonly owner: WorkspaceOwner,
    private readonly settings: Required<SnapshotOptions>,
    private readonly signal?: AbortSignal,
    terminal?: TerminalPage,
  ) {
    this.state = terminal
      ? { kind: "terminal", page: terminal }
      : { kind: "scanning", index: new NamespaceIndex() };
    if (!terminal) signal?.addEventListener("abort", this.abort, { once: true });
  }
  async next(): Promise<SnapshotPage> {
    if (this.state.kind === "terminal") return this.state.page;
    if (this.owner.stopped) {
      await this.stop();
      return { kind: "stopped" };
    }
    if (this.pulling) return { kind: "pressure", resource: "pull" };
    this.pulling = true;
    const scanning = this.state;
    try {
      this.serial ??= this.owner.nextSerial();
      const reply = namespacePage(
        await this.owner.request(
          "publicationNamespaceNext",
          [this.serial, this.settings],
          this.lifetime.signal,
        ),
      );
      if (this.owner.stopped) {
        await this.stop();
        return { kind: "stopped" };
      }
      if (this.terminalPage) return this.terminalPage;
      if (reply.kind !== "entries") return await this.terminal(reply, scanning.index);
      for (const record of reply.entries) scanning.index.add(record);
      return {
        kind: "entries",
        entries: reply.entries
          .filter((record) => record.selected)
          .map(({ id, version, path, kind, size, mtime, mode }) => ({
            id,
            version,
            path,
            kind,
            size,
            mtime,
            mode,
          })),
      };
    } catch (error) {
      if (this.owner.stopped) {
        await this.stop();
        return { kind: "stopped" };
      }
      if (this.terminalPage) return this.terminalPage;
      if (error instanceof ProjectionPressure) {
        const page = { kind: "pressure", resource: error.resource } as const;
        await this.finish(page);
        return page;
      }
      await this.finish({ kind: "cancelled" });
      throw error;
    } finally {
      this.pulling = false;
    }
  }
  private get terminalPage(): TerminalPage | undefined {
    return this.state.kind === "terminal" ? this.state.page : undefined;
  }
  private async terminal(page: TerminalPage, index: NamespaceIndex): Promise<SnapshotPage> {
    if (page.kind === "complete") this.owner.accept(page.cut, index);
    await this.finish(page);
    return this.state.kind === "terminal" ? this.state.page : page;
  }
  private finish(page: TerminalPage): Promise<void> {
    if (this.state.kind === "terminal") return this.closing ?? Promise.resolve();
    this.state = { kind: "terminal", page };
    this.lifetime.abort();
    this.signal?.removeEventListener("abort", this.abort);
    this.owner.release(this);
    this.closing =
      this.serial === undefined ? Promise.resolve() : this.owner.closeCursor(this.serial);
    return this.closing;
  }
  stop(): Promise<void> {
    return this.finish({ kind: "stopped" });
  }
  close(): Promise<void> {
    return this.finish({ kind: "cancelled" });
  }
}

class RemoteVersionLease implements VersionLease {
  private closed = false;
  private closing?: Promise<void>;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly owner: WorkspaceOwner,
    private readonly id: number,
    readonly stat: VersionStat,
  ) {}
  read(range?: ByteRange, signal?: AbortSignal): Promise<ReadOutcome<ReadValue>> {
    if (this.owner.stopped) return Promise.resolve({ kind: "stopped" });
    if (this.closed) return Promise.resolve({ kind: "lease-closed" });
    return this.owner.readLease(
      this.id,
      range,
      signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort();
    this.owner.forgetLease(this);
    return (this.closing = this.owner.closeRead(this.id));
  }
}
