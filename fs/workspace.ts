import type { FilesystemClient } from "./client.js";
import { FilesystemError, isRevoked } from "./protocol.js";
import { namespacePage, namespaceCut, watermark, workspaceChanges } from "./workspace-protocol.js";
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
  private closed = false;
  private pulling = false;
  private accepted: Accepted | undefined;
  private closing: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
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
  async request(operation: string, args: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new FilesystemError(11);
    const grant: unknown[] = [this.client.connection.publication!.observer];
    const completion = this.client.submit(operation, grant.concat(args));
    const cancel = () => completion.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await completion.value();
    } finally {
      signal?.removeEventListener("abort", cancel);
      completion.release();
    }
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
    this.closing = Promise.all(closing.concat([this.closeCursor()])).then(() => undefined);
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
