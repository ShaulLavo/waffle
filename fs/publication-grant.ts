import { FilesystemError, type FileStat } from "../core/filesystem.js";
import {
  atomicsLoad,
  atomicsStore,
  atomicsCompareExchange,
  Int32ArrayConstructor,
  Uint8ArrayConstructor,
  SharedArrayBufferConstructor,
  arrayFrom,
  typedArraySubarray,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  typedArraySet,
} from "../proc/intrinsics.js";
import type { MemoryBackend, LocalMutationPlan } from "./backend.js";
import type { PublicationSession } from "./publication-internal.js";
import {
  decodeEffects,
  encodeEffects,
  type ChangePage,
  type PublicationFile,
  type MutationId,
  type MutationIntent,
  type PublicationAdmission,
  type PublicationCut,
  type PublicationReceipt,
  type ReceiptLookup,
} from "./publication.js";

export type ResidentPublication = Extract<ChangePage, { kind: "changes" }>["publications"][number];
export type ResidentRequest =
  | { readonly kind: "read" | "write"; readonly offset: number; readonly maxBytes: number }
  | { readonly kind: "append"; readonly maxBytes: number };
export interface ResidentDescriptor {
  readonly kind: "file" | "workspace";
  readonly workspace: string;
  readonly instance: string;
  readonly epoch: number;
  readonly description: string;
  readonly handle: number;
}
export interface ResidentSession {
  readonly descriptor: ResidentDescriptor;
  readonly session: PublicationSession;
  readonly token: string;
}
interface GrantBase {
  readonly key: string;
  readonly handle: number;
  readonly session: ResidentSession;
  readonly file: PublicationFile;
  readonly stat: FileStat;
  readonly cut: PublicationCut;
  readonly offset: number;
  readonly maxBytes: number;
  readonly effectBytes: number;
  readonly resultBytes: number;
}
export type ResidentGrant = GrantBase &
  (
    | { readonly kind: "read"; readonly bytes: Uint8Array }
    | { readonly kind: "write" | "append"; readonly id: MutationId; readonly version: number }
  );
export type ResidentOutcome =
  | {
      [K in "ready" | "claimed" | "cancelled" | "stopped"]: {
        readonly kind: K;
        readonly grant: string;
      };
    }["ready" | "claimed" | "cancelled" | "stopped"]
  | {
      readonly kind: "read";
      readonly grant: string;
      readonly count: number;
      readonly cut: PublicationCut;
    }
  | {
      readonly kind: "committed";
      readonly grant: string;
      readonly publication: ResidentPublication;
    };
export type ResidentSettlement =
  | ReceiptLookup
  | { readonly kind: "read"; readonly cut: PublicationCut };
interface RetainedDescription {
  readonly descriptor: ResidentDescriptor;
}
interface AuthoritySession {
  readonly value: ResidentSession;
  last: { readonly outcome: ResidentOutcome; readonly result: ResidentSettlement } | undefined;
}
type OutstandingGrant =
  | { readonly kind: "idle" }
  | {
      readonly kind: "issued";
      readonly serial: number;
      readonly grant: ResidentGrant;
      readonly admission: PublicationAdmission | undefined;
    };

const clock = Date.now;
const encoder = new TextEncoder();
const enum CellState {
  Ready,
  Claimed,
  Committed,
  Cancelled,
  Stopped,
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new FilesystemError(28);
  return value;
}
function canonical(publication: ResidentPublication, bound: number): Uint8Array {
  const decoded = decodeEffects(encodeEffects(publication.receipt, publication.changes, bound));
  return encodeEffects(decoded.receipt, decoded.changes, bound);
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (typedArrayLength(a) !== typedArrayLength(b)) return false;
  for (let index = 0; index < typedArrayLength(a); index++) if (a[index] !== b[index]) return false;
  return true;
}
function ownedViews(chunks: readonly Uint8Array[]): Uint8Array[] {
  return arrayFrom(
    chunks,
    (chunk) =>
      new Uint8ArrayConstructor(
        typedArrayBuffer(chunk),
        typedArrayByteOffset(chunk),
        typedArrayLength(chunk),
      ),
  );
}
function prefix(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8ArrayConstructor(length);
  let at = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    const count = Math.min(length - at, typedArrayLength(chunk));
    typedArraySet(
      bytes,
      new Uint8ArrayConstructor(typedArrayBuffer(chunk), typedArrayByteOffset(chunk), count),
      at,
    );
    at += count;
    if (at === length) break;
  }
  return bytes;
}
function mutation(
  grant: Extract<ResidentGrant, { kind: "write" | "append" }>,
  bytes: Uint8Array,
  mtime: number,
): ResidentPublication {
  const changed = typedArrayLength(bytes) > 0;
  const receipt: PublicationReceipt = {
    id: grant.id,
    cut: { history: grant.cut.history, generation: grant.cut.generation + Number(changed) },
    result:
      grant.kind === "append"
        ? {
            kind: "append",
            written: typedArrayLength(bytes),
            offset: grant.offset + typedArrayLength(bytes),
          }
        : { kind: "number", value: typedArrayLength(bytes) },
    durability: { kind: "untracked" },
  };
  return {
    receipt,
    changes: !changed
      ? []
      : [
          {
            kind: "bytes",
            file: grant.file,
            offset: grant.offset,
            bytes,
            size: Math.max(grant.stat.size, grant.offset + typedArrayLength(bytes)),
            version: grant.version,
          },
          { kind: "metadata", file: grant.file, mode: grant.stat.mode!, mtime },
        ],
  };
}

/** A copied leaf executes only under the authority's outstanding operation exclusion.
 * This cell is shared within one page's execution island, never between independent pages. */
export class ResidentGrantCell {
  readonly state: Int32Array;
  readonly payload: Uint8Array;
  constructor(
    readonly grant: ResidentGrant,
    storage?: { state: SharedArrayBuffer; payload: SharedArrayBuffer },
    private claimAllowed: () => boolean = () => true,
  ) {
    this.state = new Int32ArrayConstructor(storage?.state ?? new SharedArrayBufferConstructor(12));
    this.payload = new Uint8ArrayConstructor(
      storage?.payload ?? new SharedArrayBufferConstructor(grant.effectBytes),
    );
  }
  cancel(): boolean {
    return (
      atomicsCompareExchange(this.state, 0, CellState.Ready, CellState.Cancelled) ===
      CellState.Ready
    );
  }
  stop(): void {
    this.cancel();
  }
  private execute(
    handle: number,
    chunks: readonly Uint8Array[],
    offset: number,
    kind: ResidentRequest["kind"],
  ): number | { written: number; offset: number } {
    if (atomicsLoad(this.state, 0) !== CellState.Ready) return -6;
    const grant = this.grant;
    if (handle !== grant.handle) return -8;
    if (grant.kind !== kind || (kind !== "append" && offset !== grant.offset)) return -6;
    let views: Uint8Array[];
    try {
      views = ownedViews(chunks);
    } catch {
      return -28;
    }
    let size = 0;
    for (let index = 0; index < views.length; index++) size += views[index]!.length;
    const length = Math.min(grant.maxBytes, size);
    if (!this.claimAllowed()) {
      this.cancel();
      return -11;
    }
    if (
      atomicsCompareExchange(this.state, 0, CellState.Ready, CellState.Claimed) !== CellState.Ready
    )
      return -6;
    try {
      if (grant.kind === "read") return this.readClaimed(grant, views, length);
      return this.writeClaimed(grant, views, length);
    } catch (error) {
      atomicsStore(this.state, 0, CellState.Stopped);
      throw error;
    }
  }
  private readClaimed(
    grant: Extract<ResidentGrant, { kind: "read" }>,
    views: readonly Uint8Array[],
    length: number,
  ): number {
    const count = Math.min(length, typedArrayLength(grant.bytes));
    this.state[1] = count;
    let at = 0;
    for (let index = 0; index < views.length; index++) {
      const view = views[index]!;
      const n = Math.min(count - at, typedArrayLength(view));
      typedArraySet(view, typedArraySubarray(grant.bytes, at, at + n));
      at += n;
      if (at === count) break;
    }
    atomicsStore(this.state, 0, CellState.Committed);
    return count;
  }
  private writeClaimed(
    grant: Extract<ResidentGrant, { kind: "write" | "append" }>,
    views: readonly Uint8Array[],
    length: number,
  ): number | { written: number; offset: number } {
    const publication = mutation(grant, prefix(views, length), clock());
    const encoded = encodeEffects(publication.receipt, publication.changes, grant.effectBytes);
    typedArraySet(this.payload, encoded);
    this.state[1] = typedArrayLength(encoded);
    atomicsStore(this.state, 0, CellState.Committed);
    const result = publication.receipt.result;
    return result.kind === "append" ? { written: result.written, offset: result.offset } : length;
  }
  tryRead(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    const result = this.execute(handle, chunks, offset, "read");
    return typeof result === "number" ? result : -29;
  }
  tryWrite(handle: number, chunks: readonly Uint8Array[], offset: number): number {
    const result = this.execute(handle, chunks, offset, "write");
    return typeof result === "number" ? result : -29;
  }
  tryAppend(
    handle: number,
    chunks: readonly Uint8Array[],
  ): number | { written: number; offset: number } {
    return this.execute(handle, chunks, 0, "append");
  }
  snapshot(): ResidentOutcome {
    const grant = this.grant.key;
    switch (atomicsLoad(this.state, 0)) {
      case CellState.Ready:
        return { kind: "ready", grant };
      case CellState.Claimed:
        return { kind: "claimed", grant };
      case CellState.Cancelled:
        return { kind: "cancelled", grant };
      case CellState.Stopped:
        return { kind: "stopped", grant };
      case CellState.Committed:
        if (this.grant.kind === "read")
          return { kind: "read", grant, count: this.state[1]!, cut: this.grant.cut };
        try {
          const bytes = new Uint8ArrayConstructor(this.state[1]!);
          typedArraySet(bytes, typedArraySubarray(this.payload, 0, this.state[1]!));
          return { kind: "committed", grant, publication: decodeEffects(bytes) };
        } catch {
          atomicsStore(this.state, 0, CellState.Stopped);
          return { kind: "stopped", grant };
        }
      default:
        throw new FilesystemError(29);
    }
  }
}

/** Owns real retained descriptions and the sole publication order, not a second tree. */
export class ResidentGrantAuthority {
  readonly instance = crypto.randomUUID();
  workspaceHost: import("./publication-workspace.js").WorkspaceHost | undefined;
  private descriptions = new Map<string, RetainedDescription>();
  private sessions = new Map<string, AuthoritySession>();
  private outstanding: OutstandingGrant = { kind: "idle" };
  private serial = 0;
  private stopped = false;
  private disposed = false;
  constructor(
    readonly backend: MemoryBackend,
    readonly epoch: Int32Array,
    readonly workspace: string,
  ) {
    if (!backend.shared.publication) throw new FilesystemError(58);
  }
  private get domain() {
    return this.backend.shared.publication!;
  }
  private boundary<T>(grant: number, action: () => T): T {
    if (this.stopped) throw new FilesystemError(11);
    if (this.backend.shared.ownsServiceMutation) return action();
    this.backend.shared.beginServiceMutation(this.epoch, grant);
    try {
      return action();
    } finally {
      this.backend.shared.endServiceMutation(this.epoch);
    }
  }
  retain(handle: number, kind: ResidentDescriptor["kind"] = "file"): ResidentDescriptor {
    return this.boundary(0, () => {
      if (this.descriptions.size >= this.domain.limits.sessions) throw new FilesystemError(6);
      const stat = this.backend.shared.stat(handle);
      if (!stat || stat.kind !== (kind === "file" ? "file" : "directory"))
        throw new FilesystemError(8);
      this.backend.retain(handle);
      const descriptor: ResidentDescriptor = {
        kind,
        workspace: this.workspace,
        instance: this.instance,
        epoch: 1,
        description: crypto.randomUUID(),
        handle,
      };
      this.descriptions.set(descriptor.description, { descriptor });
      return { ...descriptor };
    });
  }
  activate(): void {
    if (this.stopped) throw new FilesystemError(11);
    this.backend.shared.activateResidentAuthority();
  }
  open(descriptor: ResidentDescriptor): ResidentSession {
    const { kind, workspace, instance, epoch, description, handle } = descriptor;
    const retained = this.descriptions.get(description)?.descriptor;
    if (
      !retained ||
      retained.kind !== kind ||
      retained.workspace !== workspace ||
      retained.instance !== instance ||
      retained.epoch !== epoch ||
      retained.handle !== handle
    )
      throw new FilesystemError(11);
    return this.boundary(0, () => {
      const value = {
        descriptor: { ...retained },
        session: this.domain.openSession(),
        token: crypto.randomUUID(),
      };
      this.sessions.set(value.token, { value, last: undefined });
      return structuredClone(value);
    });
  }
  private session(value: ResidentSession): AuthoritySession {
    const owner = this.sessions.get(value.token);
    if (
      !owner ||
      owner.value.session.slot !== value.session.slot ||
      owner.value.session.serial !== value.session.serial
    )
      throw new FilesystemError(11);
    const expected = owner.value.descriptor,
      actual = value.descriptor;
    if (
      expected.kind !== actual.kind ||
      expected.workspace !== actual.workspace ||
      expected.instance !== actual.instance ||
      expected.epoch !== actual.epoch ||
      expected.description !== actual.description ||
      expected.handle !== actual.handle
    )
      throw new FilesystemError(11);
    return owner;
  }
  prepare(
    session: ResidentSession,
    request: ResidentRequest,
    handle = session.descriptor.handle,
  ): ResidentGrant {
    const kind = request.kind,
      maxBytes = bounded(request.maxBytes, this.domain.limits.inputBytes);
    const offset = kind === "append" ? 0 : bounded(request.offset, Number.MAX_SAFE_INTEGER);
    const owner = this.session(session);
    return this.boundary(0, () =>
      structuredClone(this.issue(owner, { kind, maxBytes, offset }, handle)),
    );
  }
  private issue(
    owner: AuthoritySession,
    request: { kind: ResidentRequest["kind"]; maxBytes: number; offset: number },
    handle: number,
  ): ResidentGrant {
    if (this.outstanding.kind !== "idle") throw new FilesystemError(6);
    const stat = this.backend.shared.info(handle);
    if (!stat || !this.backend.shared.isResident(handle)) throw new FilesystemError(6);
    if (stat.mode === undefined) throw new FilesystemError(58);
    const access = request.kind === "read" ? 4 : 2;
    if (((stat.mode >>> 6) & access) !== access) throw new FilesystemError(2);
    const offset = request.kind === "append" ? stat.size : request.offset;
    if (offset + request.maxBytes > stat.capacity || stat.size > this.domain.limits.inputBytes)
      throw new FilesystemError(6);
    if (++this.serial > 0x7ffffffe) throw new FilesystemError(33);
    const base: GrantBase = {
      handle,
      key: crypto.randomUUID(),
      session: owner.value,
      file: {
        birthHistory: this.domain.buffers.history,
        ino: stat.ino,
        ...this.backend.identity(handle),
      },
      stat,
      cut: this.domain.cut(),
      offset,
      maxBytes: request.maxBytes,
      effectBytes: this.domain.limits.effectBytes,
      resultBytes: this.domain.limits.resultBytes,
    };
    if (request.kind === "read") return this.issueRead(base, this.serial);
    return this.issueMutation(base, request.kind, this.serial);
  }
  private issueRead(base: GrantBase, serial: number): ResidentGrant {
    const bytes = new Uint8ArrayConstructor(base.maxBytes);
    const count = this.backend.shared.read(base.handle, [bytes], base.offset);
    const grant: ResidentGrant = {
      ...base,
      kind: "read",
      bytes: typedArraySubarray(bytes, 0, count),
    };
    this.domain.reserveResidentGrant(serial);
    this.outstanding = { kind: "issued", serial, grant, admission: undefined };
    return grant;
  }
  private issueMutation(base: GrantBase, kind: "write" | "append", serial: number): ResidentGrant {
    const id = this.domain.next(base.session.session);
    const intent: MutationIntent =
      kind === "append"
        ? { kind, handle: base.handle }
        : { kind, handle: base.handle, offset: base.offset };
    const result = this.domain.admit(
      base.session.session,
      id,
      intent,
      new Uint8ArrayConstructor(base.maxBytes),
    );
    if (result.kind !== "admitted") throw new FilesystemError(29);
    try {
      const grant: Extract<ResidentGrant, { kind: "write" | "append" }> = {
        ...base,
        file: {
          ...base.file,
          version: base.maxBytes
            ? this.backend.shared.identities.stage().versions(1)[0]!
            : base.file.version,
        },
        kind,
        id,
        version: this.domain.nextContentVersion(base.file.ino),
      };
      const worst = mutation(
        grant,
        new Uint8ArrayConstructor(base.maxBytes),
        Number.MAX_SAFE_INTEGER,
      );
      this.domain.reserveResidentCapacity(result.admission, worst.receipt.result, worst.changes);
      if (encoder.encode(JSON.stringify(worst.receipt.result)).length > base.resultBytes)
        throw new FilesystemError(6);
      this.domain.reserveResidentGrant(serial);
      this.outstanding = { kind: "issued", serial, grant, admission: result.admission };
      return grant;
    } catch (error) {
      this.domain.cancel(base.session.session, result.admission);
      throw error;
    }
  }
  settle(session: ResidentSession, outcome: ResidentOutcome): ResidentSettlement {
    const owner = this.session(session);
    if (owner.last?.outcome.grant === outcome.grant) {
      const previous = owner.last.outcome;
      const unchanged =
        previous.kind === "committed" && outcome.kind === "committed"
          ? sameBytes(
              canonical(previous.publication, this.domain.limits.effectBytes),
              canonical(outcome.publication, this.domain.limits.effectBytes),
            )
          : JSON.stringify(previous) === JSON.stringify(outcome);
      if (!unchanged) throw new FilesystemError(28);
      return structuredClone(owner.last.result);
    }
    const issued = this.outstanding;
    if (
      issued.kind !== "issued" ||
      issued.grant.key !== outcome.grant ||
      issued.grant.session.token !== session.token
    )
      throw new FilesystemError(11);
    if (outcome.kind === "ready" || outcome.kind === "claimed") return { kind: "pending" };
    if (outcome.kind === "stopped") {
      this.domain.stop();
      throw new FilesystemError(29);
    }
    return this.boundary(issued.serial, () => this.importOutcome(owner, issued, outcome));
  }
  private importOutcome(
    owner: AuthoritySession,
    issued: Extract<OutstandingGrant, { kind: "issued" }>,
    outcome: Extract<ResidentOutcome, { kind: "cancelled" | "committed" | "read" }>,
  ): ResidentSettlement {
    const grant = issued.grant;
    let result: ResidentSettlement;
    if (outcome.kind === "cancelled") {
      if (issued.admission) this.domain.cancel(owner.value.session, issued.admission);
      result = { kind: "retired" };
    } else if (outcome.kind === "read" && grant.kind === "read") {
      bounded(outcome.count, typedArrayLength(grant.bytes));
      if (
        outcome.cut.history !== grant.cut.history ||
        outcome.cut.generation !== grant.cut.generation
      )
        throw new FilesystemError(29);
      result = { kind: "read", cut: grant.cut };
    } else if (outcome.kind === "committed" && grant.kind !== "read" && issued.admission) {
      result = this.importMutation(grant, issued.admission, outcome.publication);
    } else {
      this.domain.stop();
      throw new FilesystemError(29);
    }
    this.domain.releaseResidentGrant(issued.serial);
    this.outstanding = { kind: "idle" };
    owner.last = structuredClone({ outcome, result });
    return result;
  }
  private importMutation(
    grant: Extract<ResidentGrant, { kind: "write" | "append" }>,
    admission: PublicationAdmission,
    publication: ResidentPublication,
  ): ResidentSettlement {
    const content = publication.changes.find((change) => change.kind === "bytes");
    const metadata = publication.changes.find((change) => change.kind === "metadata");
    const bytes = content?.kind === "bytes" ? content.bytes : new Uint8ArrayConstructor();
    bounded(typedArrayLength(bytes), grant.maxBytes);
    const mtime =
      metadata?.kind === "metadata"
        ? bounded(metadata.mtime, Number.MAX_SAFE_INTEGER)
        : grant.stat.mtime;
    const expected = mutation(grant, bytes, mtime);
    if (
      !sameBytes(canonical(expected, grant.effectBytes), canonical(publication, grant.effectBytes))
    ) {
      this.domain.stop();
      throw new FilesystemError(29);
    }
    this.domain.finishResidentInput(admission, bytes);
    const staged = this.backend.planPublication(
      grant.kind === "append"
        ? { kind: "append", handle: grant.handle }
        : { kind: "write", handle: grant.handle, offset: grant.offset },
      bytes,
    );
    const plan: LocalMutationPlan = {
      ...staged,
      action: staged.action.kind === "write" ? { ...staged.action, mtime } : staged.action,
      changes: staged.changes.map((effect) =>
        effect.kind === "metadata" ? { ...effect, mtime } : effect,
      ),
    };
    if (
      !sameBytes(
        canonical({ receipt: expected.receipt, changes: plan.changes }, grant.effectBytes),
        canonical(expected, grant.effectBytes),
      )
    )
      throw new FilesystemError(29, "resident identity changed before import");
    const prepared = this.domain.prepare(admission, plan.result, plan.changes);
    try {
      this.backend.applyPublication(plan);
      return { kind: "committed", receipt: this.domain.commit(prepared) };
    } catch (error) {
      this.domain.stop();
      throw error;
    }
  }
  close(session: ResidentSession): void {
    const owner = this.session(session);
    if (
      this.outstanding.kind === "issued" &&
      this.outstanding.grant.session.token === session.token
    )
      throw new FilesystemError(6);
    this.domain.closeSession(owner.value.session);
    this.sessions.delete(session.token);
  }
  dispose(): void {
    if (this.disposed) return;
    this.stopped = true;
    this.domain.stop();
    for (const owner of this.sessions.values()) this.domain.retireSession(owner.value.session);
    this.sessions.clear();
    for (const [key, { descriptor }] of this.descriptions) {
      this.backend.release(descriptor.handle);
      this.descriptions.delete(key);
    }
    this.disposed = true;
  }
}
