import type { ResolvedPath } from "../core/filesystem.js";
import { FilesystemError } from "../core/filesystem.js";
import type {
  PublicationBuffers,
  PublicationConnection,
  PublicationDiagnostics,
  PublicationLimits,
  PublicationSession,
} from "./publication-internal.js";

export interface MutationId {
  readonly session: number;
  readonly sequence: number;
}
export interface PublicationCut {
  readonly history: string;
  readonly generation: number;
}
export interface FileKey {
  readonly birthHistory: string;
  readonly ino: number;
}
export type MutationIntent =
  | { readonly kind: "write"; readonly handle: number; readonly offset: number }
  | { readonly kind: "append"; readonly handle: number }
  | { readonly kind: "resize"; readonly handle: number; readonly size: number; readonly truncate: boolean }
  | { readonly kind: "setMode"; readonly handle: number; readonly mode: number }
  | { readonly kind: "setMtime"; readonly handle: number; readonly mtime: number }
  | { readonly kind: "preopen" | "mkdirp" | "remove"; readonly path: string }
  | { readonly kind: "writeFile"; readonly path: string; readonly append: boolean; readonly exclusive: boolean }
  | { readonly kind: "move"; readonly from: string; readonly to: string }
  | { readonly kind: "create"; readonly path: ResolvedPath; readonly nodeKind: "file" | "directory"; readonly exclusive: boolean }
  | { readonly kind: "link" | "rename"; readonly from: ResolvedPath; readonly to: ResolvedPath }
  | { readonly kind: "removePath"; readonly path: ResolvedPath; readonly directory: boolean };
export type MutationResult =
  | { readonly kind: "void" }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "append"; readonly written: number; readonly offset: number }
  | { readonly kind: "error"; readonly errno: number }
  | { readonly kind: "create-error"; readonly errno: number };
export type PublicationEffect =
  | { readonly kind: "bytes"; readonly file: FileKey; readonly offset: number; readonly bytes: Uint8Array; readonly size: number; readonly version: number }
  | { readonly kind: "resize"; readonly file: FileKey; readonly size: number; readonly version: number }
  | { readonly kind: "metadata"; readonly file: FileKey; readonly mode: number; readonly mtime: number }
  | { readonly kind: "entry"; readonly parent: FileKey; readonly name: string; readonly before: FileKey | null; readonly after: FileKey | null }
  | { readonly kind: "inode"; readonly file: FileKey; readonly nodeKind: "file" | "directory"; readonly mode: number; readonly mtime: number };
export interface PublicationReceipt {
  readonly id: MutationId;
  readonly cut: PublicationCut;
  readonly result: MutationResult;
  readonly durability: { readonly kind: "untracked" };
}
export interface Publication {
  readonly receipt: PublicationReceipt;
  readonly changes: readonly PublicationEffect[];
}
export type ReceiptLookup =
  | { readonly kind: "committed"; readonly receipt: PublicationReceipt }
  | { readonly kind: "pending" }
  | { readonly kind: "retired" }
  | { readonly kind: "unknown" };
export type ChangePage =
  | { readonly kind: "changes"; readonly publications: readonly Publication[]; readonly next: PublicationCut }
  | { readonly kind: "gap"; readonly current: PublicationCut };
export interface PublicationAdmission {
  readonly slot: number;
  readonly ticket: number;
  readonly id: MutationId;
}
export type AdmissionResult =
  | { readonly kind: "admitted"; readonly admission: PublicationAdmission; readonly input: Uint8Array }
  | { readonly kind: "duplicate"; readonly receipt: PublicationReceipt };
export interface PreparedPublication {
  readonly admission: PublicationAdmission;
  readonly receipt: PublicationReceipt;
  readonly result: Uint8Array;
  readonly effects: Uint8Array;
  readonly changed: boolean;
}
export interface PublicationPin {
  readonly id: number;
  readonly cut: PublicationCut;
  readonly file: FileKey;
  readonly version: number;
  readonly bytes: Uint8Array;
}

const CONTROL_WORDS = 10;
const SESSION_WORDS = 4;
const OP_WORDS = 9;
const LOG_WORDS = 3;
const PIN_WORDS = 3;
const enum Control { Stopped, ArenaLock, Serial, GenerationLow, GenerationHigh, LogNext, LogCount, PinSerial, OperationSerial }
const enum Session { Serial, Next, Retired, Open }
const enum Op { State, Session, Sequence, Arguments, Input, Result, GenerationLow, GenerationHigh, Reserved }
const enum Status { Free, Pending, Committing, Committed, Cancelling }
const MAX_COUNTER = 0x7ffffffe;
const STATUS_MASK = 7;
const MAX_OPERATION = Math.floor(MAX_COUNTER / 8);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bounded(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COUNTER)
    throw new RangeError("publication limits must be positive bounded integers");
  return value;
}
function validateLimits(limits: PublicationLimits): PublicationLimits {
  for (const value of Object.values(limits)) bounded(value);
  if (limits.effectBytes > Math.floor(limits.logBytes / limits.logRecords))
    throw new RangeError("publication log record cannot hold the effect bound");
  const allocation = limits.operations * (limits.inputBytes + limits.argumentBytes + limits.resultBytes + OP_WORDS * 4) + limits.sessions * SESSION_WORDS * 4 + limits.logRecords * LOG_WORDS * 4 + limits.logBytes + limits.pins * PIN_WORDS * 4 + limits.pinBytes + CONTROL_WORDS * 4;
  if (!Number.isSafeInteger(allocation) || allocation > MAX_COUNTER)
    throw new RangeError("publication arena is too large");
  return Object.freeze({ ...limits });
}
export function createPublicationBuffers(limits: PublicationLimits): PublicationBuffers {
  limits = validateLimits(limits);
  return {
    history: crypto.randomUUID(), limits,
    control: new SharedArrayBuffer(CONTROL_WORDS * 4),
    sessions: new SharedArrayBuffer(limits.sessions * SESSION_WORDS * 4),
    operations: new SharedArrayBuffer(limits.operations * OP_WORDS * 4),
    inputs: new SharedArrayBuffer(limits.operations * (limits.argumentBytes + limits.inputBytes)),
    results: new SharedArrayBuffer(limits.operations * limits.resultBytes),
    log: new SharedArrayBuffer(limits.logRecords * LOG_WORDS * 4),
    logData: new SharedArrayBuffer(limits.logBytes),
    pins: new SharedArrayBuffer(limits.pins * PIN_WORDS * 4),
    pinData: new SharedArrayBuffer(limits.pinBytes),
  };
}
function same(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
function words(value: number): readonly [number, number] {
  return [value >>> 0, Math.floor(value / 0x100000000)];
}
function number(low: number, high: number): number {
  return (low >>> 0) + high * 0x100000000;
}
function json(value: unknown, bound: number): Uint8Array {
  const result = encoder.encode(JSON.stringify(value));
  if (result.length > bound) throw new FilesystemError(6, "publication record bound exceeded");
  return result;
}
function parseResult(bytes: Uint8Array): MutationResult {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== "object" || !("kind" in value)) throw new FilesystemError(29);
  if (value.kind === "void") return { kind: "void" };
  if (value.kind === "number" && "value" in value && typeof value.value === "number")
    return { kind: "number", value: value.value };
  if (value.kind === "boolean" && "value" in value && typeof value.value === "boolean")
    return { kind: "boolean", value: value.value };
  if ((value.kind === "error" || value.kind === "create-error") && "errno" in value && typeof value.errno === "number")
    return { kind: value.kind, errno: value.errno };
  if (value.kind === "append" && "written" in value && typeof value.written === "number" && "offset" in value && typeof value.offset === "number")
    return { kind: "append", written: value.written, offset: value.offset };
  throw new FilesystemError(29, "invalid publication result");
}

/** Fixed arenas shared by the service and actual direct clients. The filesystem global lock
 * protects prepare/commit/cut/log/pin calls. Admission uses a separate immediate arena CAS,
 * never held across a filesystem lock, await, or guest call. */
export class PublicationDomain {
  private readonly control: Int32Array;
  private readonly sessions: Int32Array;
  private readonly operations: Int32Array;
  private readonly inputs: Uint8Array;
  private readonly results: Uint8Array;
  private readonly log: Int32Array;
  private readonly logData: Uint8Array;
  private readonly pins: Int32Array;
  private readonly pinData: Uint8Array;
  readonly limits: PublicationLimits;
  constructor(readonly buffers: PublicationBuffers) {
    this.limits = buffers.limits;
    this.control = new Int32Array(buffers.control);
    this.sessions = new Int32Array(buffers.sessions);
    this.operations = new Int32Array(buffers.operations);
    this.inputs = new Uint8Array(buffers.inputs);
    this.results = new Uint8Array(buffers.results);
    this.log = new Int32Array(buffers.log);
    this.logData = new Uint8Array(buffers.logData);
    this.pins = new Int32Array(buffers.pins);
    this.pinData = new Uint8Array(buffers.pinData);
  }
  get stopped(): boolean { return Atomics.load(this.control, Control.Stopped) !== 0; }
  assertLive(): void { if (this.stopped) throw new FilesystemError(11); }
  private arena<T>(action: () => T): T {
    this.assertLive();
    if (Atomics.compareExchange(this.control, Control.ArenaLock, 0, 1) !== 0)
      throw new FilesystemError(6, "publication admission is contended");
    try { this.assertLive(); return action(); }
    finally { Atomics.store(this.control, Control.ArenaLock, 0); }
  }
  private session(session: PublicationSession): number {
    this.assertLive();
    const base = session.slot * SESSION_WORDS;
    if (this.sessions[base + Session.Serial] !== session.serial || !this.sessions[base + Session.Open])
      throw new FilesystemError(11, "publication session is closed");
    return base;
  }
  openSession(): PublicationSession {
    return this.arena(() => {
      const serial = this.control[Control.Serial]! + 1;
      if (serial > MAX_COUNTER) throw new FilesystemError(33);
      const slot = this.findSession();
      this.control[Control.Serial] = serial;
      const base = slot * SESSION_WORDS;
      this.sessions[base + Session.Serial] = serial;
      this.sessions[base + Session.Next] = 0;
      this.sessions[base + Session.Retired] = 0;
      this.sessions[base + Session.Open] = 1;
      return { slot, serial };
    });
  }
  private findSession(): number {
    for (let slot = 0; slot < this.limits.sessions; slot++)
      if (!this.sessions[slot * SESSION_WORDS + Session.Open]) return slot;
    throw new FilesystemError(6, "publication session bound exceeded");
  }
  next(session: PublicationSession): MutationId {
    this.session(session);
    const sequence = Atomics.add(this.sessions, session.slot * SESSION_WORDS + Session.Next, 1) + 1;
    if (sequence > MAX_COUNTER) { this.stop(); throw new FilesystemError(33); }
    return { session: session.serial, sequence };
  }
  private operation(id: MutationId): number {
    for (let slot = 0; slot < this.limits.operations; slot++) {
      const base = slot * OP_WORDS;
      if (this.operations[base + Op.State] && this.operations[base + Op.Session] === id.session && this.operations[base + Op.Sequence] === id.sequence) return slot;
    }
    return -1;
  }
  private inputAt(slot: number): number { return slot * (this.limits.argumentBytes + this.limits.inputBytes); }
  private receiptAt(slot: number): PublicationReceipt {
    const base = slot * OP_WORDS;
    return {
      id: { session: this.operations[base + Op.Session]!, sequence: this.operations[base + Op.Sequence]! },
      cut: { history: this.buffers.history, generation: number(this.operations[base + Op.GenerationLow]!, this.operations[base + Op.GenerationHigh]!) },
      result: parseResult(this.results.slice(slot * this.limits.resultBytes, slot * this.limits.resultBytes + this.operations[base + Op.Result]!)),
      durability: { kind: "untracked" },
    };
  }
  admit(session: PublicationSession, id: MutationId, intent: MutationIntent, input: Uint8Array): AdmissionResult {
    if (input.length > this.limits.inputBytes) throw new FilesystemError(6, "publication input bound exceeded");
    const argumentsBytes = json(intent, this.limits.argumentBytes);
    return this.arena(() => this.admitLocked(session, id, argumentsBytes, input));
  }
  private admitLocked(session: PublicationSession, id: MutationId, args: Uint8Array, input: Uint8Array): AdmissionResult {
    const sessionBase = this.session(session);
    if (id.session !== session.serial || !Number.isInteger(id.sequence) || id.sequence <= 0 || id.sequence > this.sessions[sessionBase + Session.Next]!) throw new FilesystemError(28);
    if (id.sequence <= this.sessions[sessionBase + Session.Retired]!) throw new FilesystemError(11, "publication identity retired");
    const previous = this.operation(id);
    if (previous >= 0) return this.duplicate(previous, args, input);
    const serial = this.control[Control.OperationSerial]! + 1;
    if (serial > MAX_OPERATION) { this.stop(); throw new FilesystemError(33); }
    const slot = this.available(session);
    this.control[Control.OperationSerial] = serial;
    const ticket = serial * 8;
    const base = slot * OP_WORDS;
    const at = this.inputAt(slot);
    this.inputs.set(args, at);
    this.inputs.set(input, at + this.limits.argumentBytes);
    this.operations[base + Op.Session] = id.session;
    this.operations[base + Op.Sequence] = id.sequence;
    this.operations[base + Op.Arguments] = args.length;
    this.operations[base + Op.Input] = input.length;
    this.operations[base + Op.Reserved] = 0;
    Atomics.store(this.operations, base + Op.State, ticket + Status.Pending);
    return { kind: "admitted", admission: { slot, ticket, id }, input: this.inputs.slice(at + this.limits.argumentBytes, at + this.limits.argumentBytes + input.length) };
  }
  private duplicate(slot: number, args: Uint8Array, input: Uint8Array): AdmissionResult {
    const base = slot * OP_WORDS, at = this.inputAt(slot);
    if (this.operations[base + Op.Reserved]) throw new FilesystemError(11, "publication identity retired");
    if (!same(this.inputs.subarray(at, at + this.operations[base + Op.Arguments]!), args) || !same(this.inputs.subarray(at + this.limits.argumentBytes, at + this.limits.argumentBytes + this.operations[base + Op.Input]!), input))
      throw new FilesystemError(28, "conflicting publication identity");
    if ((this.operations[base + Op.State]! & STATUS_MASK) !== Status.Committed) throw new FilesystemError(6, "publication identity is pending");
    return { kind: "duplicate", receipt: this.receiptAt(slot) };
  }
  verify(session: PublicationSession, admission: PublicationAdmission, intent: MutationIntent, input: Uint8Array): void {
    this.session(session);
    if (admission.id.session !== session.serial) throw new FilesystemError(11);
    this.verifyAdmission(admission, intent, input);
  }
  verifyAdmission(admission: PublicationAdmission, intent: MutationIntent, input: Uint8Array): void {
    const base = this.checkAdmission(admission), at = this.inputAt(admission.slot);
    if (!same(json(intent, this.limits.argumentBytes), this.inputs.subarray(at, at + this.operations[base + Op.Arguments]!)) || !same(input, this.inputs.subarray(at + this.limits.argumentBytes, at + this.limits.argumentBytes + this.operations[base + Op.Input]!))) throw new FilesystemError(28, "conflicting publication intent");
  }
  lookupAny(id: MutationId): ReceiptLookup {
    for (let slot = 0; slot < this.limits.sessions; slot++)
      if (this.sessions[slot * SESSION_WORDS + Session.Serial] === id.session && this.sessions[slot * SESSION_WORDS + Session.Open]) return this.lookup({ slot, serial: id.session }, id);
    return { kind: "unknown" };
  }
  private available(session: PublicationSession): number {
    let oldest = -1;
    let sequence = MAX_COUNTER + 1;
    for (let slot = 0; slot < this.limits.operations; slot++) {
      const base = slot * OP_WORDS;
      if (!this.operations[base + Op.State]) return slot;
      if (this.operations[base + Op.Session] !== session.serial) continue;
      if (this.operations[base + Op.Sequence]! >= sequence) continue;
      sequence = this.operations[base + Op.Sequence]!;
      oldest = slot;
    }
    if (oldest < 0 || (this.operations[oldest * OP_WORDS + Op.State]! & STATUS_MASK) !== Status.Committed) throw new FilesystemError(6, "publication operation bound exceeded");
    this.sessions[session.slot * SESSION_WORDS + Session.Retired] = sequence;
    this.clearOperation(oldest);
    return oldest;
  }
  private clearOperation(slot: number): void {
    const at = this.inputAt(slot);
    this.inputs.fill(0, at, at + this.limits.argumentBytes + this.limits.inputBytes);
    this.results.fill(0, slot * this.limits.resultBytes, (slot + 1) * this.limits.resultBytes);
    this.operations.fill(0, slot * OP_WORDS, (slot + 1) * OP_WORDS);
  }
  cut(): PublicationCut {
    this.assertLive();
    return { history: this.buffers.history, generation: number(this.control[Control.GenerationLow]!, this.control[Control.GenerationHigh]!) };
  }
  private checkAdmission(admission: PublicationAdmission, state = Status.Pending): number {
    this.assertLive();
    if (!Number.isInteger(admission.slot) || admission.slot < 0 || admission.slot >= this.limits.operations) throw new FilesystemError(28);
    const base = admission.slot * OP_WORDS;
    if (this.operations[base + Op.State] !== admission.ticket + state || this.operations[base + Op.Session] !== admission.id.session || this.operations[base + Op.Sequence] !== admission.id.sequence) throw new FilesystemError(11);
    return base;
  }
  prepare(admission: PublicationAdmission, result: MutationResult, changes: readonly PublicationEffect[]): PreparedPublication {
    this.checkAdmission(admission);
    if (changes.length > this.limits.effects) throw new FilesystemError(6, "publication effect count exceeded");
    const cut = this.cut();
    const generation = cut.generation + (changes.length ? 1 : 0);
    if (!Number.isSafeInteger(generation)) { this.stop(); throw new FilesystemError(33); }
    const receipt: PublicationReceipt = { id: admission.id, cut: { ...cut, generation }, result, durability: { kind: "untracked" } };
    const prepared = { admission, receipt, result: json(result, this.limits.resultBytes), effects: encodeEffects(receipt, changes, this.limits.effectBytes), changed: changes.length > 0 };
    const base = this.checkAdmission(admission);
    if (Atomics.compareExchange(this.operations, base + Op.State, admission.ticket + Status.Pending, admission.ticket + Status.Committing) !== admission.ticket + Status.Pending) throw new FilesystemError(11);
    return prepared;
  }
  /** All potentially failing work is in prepare. Invoke immediately after synchronous effects,
   * before releasing the same filesystem global lock. No callbacks or encoding occur here. */
  commit(prepared: PreparedPublication): PublicationReceipt {
    const base = this.checkAdmission(prepared.admission, Status.Committing);
    const generation = prepared.receipt.cut.generation;
    const current = this.cut().generation;
    if (generation !== current + (prepared.changed ? 1 : 0)) { this.stop(); throw new FilesystemError(29); }
    const [low, high] = words(generation);
    this.results.set(prepared.result, prepared.admission.slot * this.limits.resultBytes);
    this.operations[base + Op.Result] = prepared.result.length;
    this.operations[base + Op.GenerationLow] = low;
    this.operations[base + Op.GenerationHigh] = high;
    if (prepared.changed) this.appendLog(prepared.effects, low, high);
    this.control[Control.GenerationLow] = low;
    this.control[Control.GenerationHigh] = high;
    Atomics.store(this.operations, base + Op.State, prepared.admission.ticket + Status.Committed);
    return prepared.receipt;
  }
  private appendLog(effects: Uint8Array, low: number, high: number): void {
    const slot = this.control[Control.LogNext]!;
    const stride = Math.floor(this.limits.logBytes / this.limits.logRecords);
    this.logData.set(effects, slot * stride);
    this.log[slot * LOG_WORDS] = effects.length;
    this.log[slot * LOG_WORDS + 1] = low;
    this.log[slot * LOG_WORDS + 2] = high;
    this.control[Control.LogNext] = (slot + 1) % this.limits.logRecords;
    this.control[Control.LogCount] = Math.min(this.limits.logRecords, this.control[Control.LogCount]! + 1);
  }
  cancel(session: PublicationSession, admission: PublicationAdmission): void {
    const base = admission.slot * OP_WORDS;
    if (admission.id.session !== session.serial || this.operations[base + Op.Session] !== session.serial || this.operations[base + Op.Sequence] !== admission.id.sequence) return;
    if (Atomics.compareExchange(this.operations, base + Op.State, admission.ticket + Status.Pending, admission.ticket + Status.Cancelling) !== admission.ticket + Status.Pending) return;
    const at = this.inputAt(admission.slot);
    this.inputs.fill(0, at, at + this.limits.argumentBytes + this.limits.inputBytes);
    this.operations[base + Op.Input] = 0;
    this.operations[base + Op.Arguments] = 0;
    this.operations[base + Op.Result] = 0;
    this.operations[base + Op.Reserved] = 1;
    Atomics.store(this.operations, base + Op.State, admission.ticket + Status.Committed);
  }
  lookup(session: PublicationSession, id: MutationId): ReceiptLookup {
    return this.arena(() => {
      const base = this.session(session);
      if (id.session !== session.serial) return { kind: "unknown" };
      if (id.sequence <= this.sessions[base + Session.Retired]!) return { kind: "retired" };
      const slot = this.operation(id);
      if (slot < 0) return { kind: "unknown" };
      if (this.operations[slot * OP_WORDS + Op.Reserved]) return { kind: "retired" };
      return (this.operations[slot * OP_WORDS + Op.State]! & STATUS_MASK) === Status.Committed ? { kind: "committed", receipt: this.receiptAt(slot) } : { kind: "pending" };
    });
  }
  changes(after: PublicationCut, limitBytes: number): ChangePage {
    const current = this.cut();
    bounded(limitBytes);
    const count = this.control[Control.LogCount]!;
    const first = (this.control[Control.LogNext]! + this.limits.logRecords - count) % this.limits.logRecords;
    const oldest = count ? number(this.log[first * LOG_WORDS + 1]!, this.log[first * LOG_WORDS + 2]!) : current.generation + 1;
    if (after.history !== current.history || after.generation < oldest - 1 || after.generation > current.generation) return { kind: "gap", current };
    return this.readChanges(after, limitBytes, first, count);
  }
  private readChanges(after: PublicationCut, limit: number, first: number, count: number): ChangePage {
    const publications: Publication[] = [];
    const stride = Math.floor(this.limits.logBytes / this.limits.logRecords);
    let used = 0, next = after;
    for (let index = 0; index < count; index++) {
      const slot = (first + index) % this.limits.logRecords;
      const generation = number(this.log[slot * LOG_WORDS + 1]!, this.log[slot * LOG_WORDS + 2]!);
      if (generation <= after.generation) continue;
      const length = this.log[slot * LOG_WORDS]!;
      if (used + length > limit) break;
      const publication = decodeEffects(this.logData.slice(slot * stride, slot * stride + length));
      publications.push(publication);
      next = publication.receipt.cut;
      used += length;
    }
    return { kind: "changes", publications, next };
  }
  closeSession(session: PublicationSession): void {
    this.arena(() => {
      this.session(session);
      this.sessions[session.slot * SESSION_WORDS + Session.Open] = 0;
      for (let slot = 0; slot < this.limits.operations; slot++)
        if (this.operations[slot * OP_WORDS + Op.Session] === session.serial) this.clearOperation(slot);
    });
  }
  pin(file: FileKey, version: number, bytes: Uint8Array): PublicationPin {
    const cut = this.cut();
    const stride = Math.floor(this.limits.pinBytes / this.limits.pins);
    if (bytes.length > stride) throw new FilesystemError(6, "publication pin byte bound exceeded");
    const slot = this.freePin();
    const id = this.control[Control.PinSerial]! + 1;
    if (id > MAX_COUNTER) { this.stop(); throw new FilesystemError(33); }
    const owned = bytes.slice();
    this.pinData.set(owned, slot * stride);
    this.pins[slot * PIN_WORDS] = id;
    this.pins[slot * PIN_WORDS + 2] = bytes.length;
    this.control[Control.PinSerial] = id;
    return { id, cut, file: { ...file }, version, bytes: owned };
  }
  private freePin(): number {
    for (let slot = 0; slot < this.limits.pins; slot++)
      if (!this.pins[slot * PIN_WORDS]) return slot;
    throw new FilesystemError(6, "publication pin count exceeded");
  }
  releasePin(id: number): void {
    const stride = Math.floor(this.limits.pinBytes / this.limits.pins);
    for (let slot = 0; slot < this.limits.pins; slot++) {
      if (this.pins[slot * PIN_WORDS] !== id) continue;
      this.pinData.fill(0, slot * stride, (slot + 1) * stride);
      this.pins.fill(0, slot * PIN_WORDS, (slot + 1) * PIN_WORDS);
      return;
    }
  }
  stop(): void { Atomics.store(this.control, Control.Stopped, 1); }
  /** Authority calls only after every real filesystem section has quiesced. */
  releaseStopped(): void {
    if (!this.stopped) throw new FilesystemError(28);
    this.sessions.fill(0);
    this.operations.fill(0);
    this.inputs.fill(0);
    this.results.fill(0);
    this.pins.fill(0);
    this.pinData.fill(0);
  }
  diagnostics(): PublicationDiagnostics {
    let sessions = 0, pending = 0, receipts = 0, inputBytes = 0, pins = 0, pinBytes = 0;
    for (let slot = 0; slot < this.limits.sessions; slot++) if (this.sessions[slot * SESSION_WORDS + Session.Open]) sessions++;
    for (let slot = 0; slot < this.limits.operations; slot++) {
      const state = this.operations[slot * OP_WORDS + Op.State]! & STATUS_MASK;
      if (state === Status.Pending || state === Status.Committing) pending++;
      if (state === Status.Committed && !this.operations[slot * OP_WORDS + Op.Reserved]) receipts++;
      if (state) inputBytes += this.operations[slot * OP_WORDS + Op.Input]!;
    }
    for (let slot = 0; slot < this.limits.pins; slot++) {
      if (!this.pins[slot * PIN_WORDS]) continue;
      pins++;
      pinBytes += this.pins[slot * PIN_WORDS + 2]!;
    }
    const allocatedBytes = Object.values(this.buffers).reduce<number>((sum, value) => sum + (value instanceof SharedArrayBuffer ? value.byteLength : 0), 0);
    return { stopped: this.stopped, sessions, pending, receipts, inputBytes, pins, pinBytes, allocatedBytes };
  }
}

// Effects use one bounded JSON header and raw byte tails. Encoding finishes before the first
// visible effect. The log stores owned copies; decoded byte ranges never alias shared storage.
function encodeEffects(receipt: PublicationReceipt, changes: readonly PublicationEffect[], bound: number): Uint8Array {
  const tails: Uint8Array[] = [];
  let length = 0;
  const metadata = changes.map((change) => {
    if (change.kind !== "bytes") return change;
    const at = length;
    tails.push(change.bytes);
    length += change.bytes.length;
    return { ...change, bytes: { at, length: change.bytes.length } };
  });
  const header = json({ receipt, changes: metadata }, bound);
  if (4 + header.length + length > bound) throw new FilesystemError(6, "publication effect bytes exceeded");
  const bytes = new Uint8Array(4 + header.length + length);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  let at = 4 + header.length;
  for (const tail of tails) { bytes.set(tail, at); at += tail.length; }
  return bytes;
}
function decodeEffects(bytes: Uint8Array): Publication {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  // This is the private paired codec, not a guest RPC argument. Validate before narrowing.
  const value: unknown = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length)));
  if (!value || typeof value !== "object" || !("receipt" in value) || !("changes" in value) || !Array.isArray(value.changes)) throw new FilesystemError(29);
  const receipt = decodeReceipt(value.receipt);
  const changes = value.changes.map((entry: unknown) => decodeEffect(entry, bytes.subarray(4 + length)));
  return { receipt, changes };
}
function decodeReceipt(value: unknown): PublicationReceipt {
  if (!value || typeof value !== "object" || !("id" in value) || !("cut" in value) || !("result" in value)) throw new FilesystemError(29);
  const id = value.id, cut = value.cut;
  if (!id || typeof id !== "object" || !("session" in id) || typeof id.session !== "number" || !("sequence" in id) || typeof id.sequence !== "number") throw new FilesystemError(29);
  if (!cut || typeof cut !== "object" || !("history" in cut) || typeof cut.history !== "string" || !("generation" in cut) || typeof cut.generation !== "number") throw new FilesystemError(29);
  return { id: { session: id.session, sequence: id.sequence }, cut: { history: cut.history, generation: cut.generation }, result: parseResult(encoder.encode(JSON.stringify(value.result))), durability: { kind: "untracked" } };
}
function fileKey(value: unknown): FileKey {
  if (!value || typeof value !== "object" || !("birthHistory" in value) || typeof value.birthHistory !== "string" || !("ino" in value) || typeof value.ino !== "number") throw new FilesystemError(29);
  return { birthHistory: value.birthHistory, ino: value.ino };
}
function decodeEffect(value: unknown, tail: Uint8Array): PublicationEffect {
  if (!value || typeof value !== "object" || !("kind" in value)) throw new FilesystemError(29);
  if (value.kind === "entry" && "parent" in value && "name" in value && typeof value.name === "string" && "before" in value && "after" in value)
    return { kind: "entry", parent: fileKey(value.parent), name: value.name, before: value.before === null ? null : fileKey(value.before), after: value.after === null ? null : fileKey(value.after) };
  if (!("file" in value)) throw new FilesystemError(29);
  const file = fileKey(value.file);
  if ((value.kind === "metadata" || value.kind === "inode") && "mode" in value && typeof value.mode === "number" && "mtime" in value && typeof value.mtime === "number") {
    if (value.kind === "metadata") return { kind: "metadata", file, mode: value.mode, mtime: value.mtime };
    if ("nodeKind" in value && (value.nodeKind === "file" || value.nodeKind === "directory")) return { kind: "inode", file, mode: value.mode, mtime: value.mtime, nodeKind: value.nodeKind };
  }
  if (!("size" in value) || typeof value.size !== "number" || !("version" in value) || typeof value.version !== "number") throw new FilesystemError(29);
  if (value.kind === "resize") return { kind: "resize", file, size: value.size, version: value.version };
  if (value.kind !== "bytes" || !("offset" in value) || typeof value.offset !== "number" || !("bytes" in value)) throw new FilesystemError(29);
  const range = value.bytes;
  if (!range || typeof range !== "object" || !("at" in range) || typeof range.at !== "number" || !("length" in range) || typeof range.length !== "number" || range.at < 0 || range.length < 0 || range.at + range.length > tail.length) throw new FilesystemError(29);
  return { kind: "bytes", file, size: value.size, version: value.version, offset: value.offset, bytes: tail.slice(range.at, range.at + range.length) };
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new FilesystemError(28);
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new FilesystemError(28);
  return value;
}
function path(value: unknown): ResolvedPath {
  if (!value || typeof value !== "object" || !("name" in value) || !("parent" in value) || !("node" in value)) throw new FilesystemError(28);
  return { parent: value.parent === undefined ? undefined : integer(value.parent), node: value.node === undefined ? undefined : integer(value.node), name: text(value.name), trailingSlash: "trailingSlash" in value && value.trailingSlash === true, terminalDot: "terminalDot" in value && value.terminalDot === true };
}
/** Normalize the legacy string boundary once, before admission or asynchronous preparation. */
export function mutationIntent(operation: string, args: readonly unknown[]): MutationIntent | undefined {
  const [a, b, c] = args;
  switch (operation) {
    case "write": return { kind: "write", handle: integer(a), offset: integer(b) };
    case "append": return { kind: "append", handle: integer(a) };
    case "resize": return { kind: "resize", handle: integer(a), size: integer(b), truncate: c === true };
    case "setMode": return { kind: "setMode", handle: integer(a), mode: integer(b) };
    case "setMtime": return { kind: "setMtime", handle: integer(a), mtime: integer(b) };
    case "preopen": case "mkdirp": case "remove": return { kind: operation, path: text(a) };
    case "writeFile": return { kind: "writeFile", path: text(a), append: b === true, exclusive: c === true };
    case "move": return { kind: "move", from: text(a), to: text(b) };
    case "create":
      if (b !== "file" && b !== "directory") throw new FilesystemError(28);
      return { kind: "create", path: path(a), nodeKind: b, exclusive: c !== false };
    case "link": case "rename": return { kind: operation, from: path(a), to: path(b) };
    case "removePath": return { kind: "removePath", path: path(a), directory: b === true };
    default: return undefined;
  }
}
export function mutationResult(value: unknown): MutationResult {
  if (value === undefined) return { kind: "void" };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (value && typeof value === "object" && "error" in value && typeof value.error === "number") return { kind: "error", errno: value.error };
  if (value && typeof value === "object" && "written" in value && typeof value.written === "number" && "offset" in value && typeof value.offset === "number") return { kind: "append", written: value.written, offset: value.offset };
  throw new FilesystemError(29, "invalid publication mutation result");
}
export function forkPublication(connection: PublicationConnection): PublicationConnection {
  const domain = new PublicationDomain(connection.buffers);
  return { buffers: connection.buffers, session: domain.openSession() };
}

export function publicationAdmission(value: unknown): PublicationAdmission {
  if (!value || typeof value !== "object" || !("slot" in value) || !("ticket" in value) || !("id" in value)) throw new FilesystemError(28);
  const id = value.id;
  if (!id || typeof id !== "object" || !("session" in id) || !("sequence" in id)) throw new FilesystemError(28);
  return { slot: integer(value.slot), ticket: integer(value.ticket), id: { session: integer(id.session), sequence: integer(id.sequence) } };
}
export function publicationCut(value: unknown): PublicationCut {
  if (!value || typeof value !== "object" || !("history" in value) || !("generation" in value)) throw new FilesystemError(28);
  return { history: text(value.history), generation: integer(value.generation) };
}
export function mutationValue(result: MutationResult): number | boolean | { written: number; offset: number } | { error: number } | undefined {
  switch (result.kind) {
    case "void": return;
    case "number": return result.value;
    case "boolean": return result.value;
    case "append": return { written: result.written, offset: result.offset };
    case "error": throw new FilesystemError(result.errno);
    case "create-error": return { error: result.errno };
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
