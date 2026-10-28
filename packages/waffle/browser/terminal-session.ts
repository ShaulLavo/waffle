import {
  assertTerminalWaitAllowed,
  terminalTurnActive,
  terminalPolicyActive,
  withTerminalControl,
  withTerminalPolicy,
} from "../proc/terminal-turn.js";
import type { Readiness, Resource, Stream } from "../core/descriptors.js";

const identityBrand = Symbol();
const contextBrand = Symbol();
const groupBrand = Symbol();
const memberBrand = Symbol();
const planBrand = Symbol();
const leaseBrand = Symbol();
const stampBrand = Symbol();
const turnBrand = Symbol();

export interface TerminalIdentity {
  readonly [identityBrand]: true;
}

export interface TerminalContext {
  readonly [contextBrand]: true;
}

export interface TerminalGroup {
  readonly [groupBrand]: true;
}
export interface TerminalMember {
  readonly [memberBrand]: true;
}
export interface TerminalMemberPlan {
  readonly [planBrand]: true;
}

export interface TerminalLease {
  readonly [leaseBrand]: true;
}

export type TerminalSelection = number & { readonly [stampBrand]: true };
export type TerminalMode = "raw" | "cooked";
export type TerminalTarget = 0 | 1 | 2;
export type TerminalReason = "completed" | "start-failed" | "cancelled" | "disposed" | "failed";
export type TerminalFailure =
  | "AGAIN"
  | "CLOSED"
  | "STALE"
  | "DENIED"
  | "CAPACITY"
  | "INVALID"
  | "PROCESS_GONE"
  | "CANCELED"
  | "EXHAUSTED";
export type TerminalResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly code: TerminalFailure };

export interface TerminalGeometry {
  readonly columns: number;
  readonly rows: number;
}
export interface TerminalGeometrySnapshot extends TerminalGeometry {
  readonly revision: number;
}
export interface TerminalSnapshot {
  readonly mode: TerminalMode;
  readonly modeRevision: number;
  readonly geometry: TerminalGeometrySnapshot;
  readonly selection: TerminalSelection | null;
}

export interface TerminalTurn extends TerminalSnapshot {
  readonly [turnBrand]: true;
}
export type TerminalChange =
  | { readonly kind: "mode"; readonly previous: TerminalMode; readonly next: TerminalMode }
  | {
      readonly kind: "selection";
      readonly previous: TerminalSelection | null;
      readonly next: TerminalSelection | null;
    }
  | {
      readonly kind: "membership";
      readonly previous: TerminalSelection;
      readonly next: TerminalSelection;
    };

export interface TerminalPolicy {
  tryRead(turn: TerminalTurn, chunks: readonly Uint8Array[]): number;
  inputReadiness(turn: TerminalTurn): Pick<Readiness, "readable" | "nbytes">;

  transition(turn: TerminalTurn, change: TerminalChange): TerminalResult<void>;
  tryWrite(target: 1 | 2, chunks: readonly Uint8Array[]): number;
  outputReadiness(target: 1 | 2): Pick<Readiness, "writable">;
}

export interface TerminalDisplay {
  readonly identity: TerminalIdentity;
  inherit(): TerminalContext;
  snapshot(): TerminalResult<TerminalSnapshot>;
  input(accept: (turn: TerminalTurn) => number): TerminalResult<number>;

  resize(geometry: TerminalGeometry): TerminalResult<TerminalGeometrySnapshot>;

  outputDrained(): void;

  close(reason: TerminalReason): void;
}

export interface TerminalPlannedMember {
  readonly member: TerminalMemberPlan;

  readonly context: TerminalContext;
}
export interface TerminalAdmittedMember {
  readonly member: TerminalMember;

  readonly context: TerminalContext;

  readonly lease: TerminalLease | null;
}
export interface TerminalMemberUpdate {
  readonly lease: TerminalLease | null;
}

export interface TerminalControlTurn {
  /** Publish local bookkeeping only after the terminal metadata commits. No terminal calls. */
  publish(operation: () => void): void;
}
export interface TerminalControlOptions {
  readonly signal?: AbortSignal;
}
export interface TerminalAuthority {
  /** Wait for the page control lane, then execute synchronous work exactly once. */
  control<T>(
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    options?: TerminalControlOptions,
  ): Promise<TerminalResult<T>>;
  createGroup(options: { readonly initialMode: TerminalMode }): TerminalResult<TerminalGroup>;
  planMember(options: {
    readonly group: TerminalGroup;
    readonly parent: TerminalMember;
  }): TerminalResult<TerminalPlannedMember>;

  bindMember(options: {
    readonly planned: TerminalMemberPlan;
    readonly pid: number;
  }): TerminalResult<TerminalAdmittedMember>;

  admitExisting(options: {
    readonly group: TerminalGroup;
    readonly pid: number;
  }): TerminalResult<TerminalAdmittedMember>;

  cancelPlan(planned: TerminalMemberPlan): TerminalResult<void>;

  removeMember(member: TerminalMember): TerminalResult<TerminalMemberUpdate>;

  acquire(options: {
    readonly group: TerminalGroup;
    readonly expected: null;
  }): TerminalResult<TerminalLease>;

  transfer(options: {
    readonly from: TerminalLease;
    readonly to: TerminalGroup;
  }): TerminalResult<TerminalLease>;

  startBackground(group: TerminalGroup): TerminalResult<void>;

  release(options: {
    readonly lease: TerminalLease;
    readonly restore: TerminalGroup | null;
  }): TerminalResult<TerminalLease | null>;

  retireGroup(options: {
    readonly group: TerminalGroup;
    readonly reason: TerminalReason;
  }): TerminalResult<void>;
}

export interface TerminalGeometrySubscription {
  poll(): TerminalResult<TerminalGeometrySnapshot | null>;

  wait(): Promise<TerminalResult<TerminalGeometrySnapshot>>;
  dispose(): void;
}
export interface TerminalControls {
  snapshot(): TerminalResult<TerminalSnapshot>;

  setMode(options: {
    readonly expected: TerminalSelection | null;
    readonly mode: TerminalMode;
  }): TerminalResult<void>;
  subscribeGeometry(): TerminalResult<TerminalGeometrySubscription>;
}

export interface TerminalAttachment {
  readonly identity: TerminalIdentity;
  resolve(target: TerminalTarget): Stream;

  inherit(): TerminalContext;

  ready(): TerminalResult<void>;
  dispose(): void;
}

import {
  atomicsLoad,
  atomicsStore,
  atomicsCompareExchange,
  atomicsExchange,
  atomicsAdd,
  atomicsNotify,
  atomicsWait,
  atomicsWaitAsync,
  BigInt64ArrayConstructor,
  BigIntConstructor,
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  Uint32ArrayConstructor,
  cryptoGetRandomValues,
  isSharedArrayBuffer,
  sharedArrayBufferByteLength,
  objectFreeze,
  isInstance,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  scheduleTimeout,
  reflectGet,
  reflectApply,
  MapConstructor,
  mapSet,
  mapDelete,
  mapSize,
  mapForEach,
  WeakMapConstructor,
  weakMapGet,
  weakMapSet,
  objectCreate,
  PromiseConstructor,
  abortSignalAborted,
  listenAbort,
  unlistenAbort,
  observeRejectedPromise,
  mapGet,
} from "../proc/intrinsics.ts";
import { enterTerminalSection, leaveTerminalSection } from "../proc/terminal-lifetime.js";
import {
  directoryControls,
  directoryProcesses,
  directoryState,
  isCollectedProcess,
} from "../proc/directory.js";
import {
  workerProcessDirectoryId,
  workerProcessState,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { readOutcome } from "../proc/outcome.js";
import { controlLoad } from "../proc/control.js";
import { requestSignal, signalPending } from "../proc/signals.js";
import { ProcessError, ProcessErrno, Signal } from "../proc/types.js";

export const TERMINAL_SESSION_LIMITS = objectFreeze({
  controlBytes: 20736,
  groups: 64,
  memberships: 256,
  wrappersPerAttachment: 256,
  geometrySubscriptionsPerAttachment: 64,
  inputBytesPerTurn: 4096,
  maximumDimension: 65535,
  maximumGeneration: 2147483647,
} as const);
const integer = Number.isInteger;
const generatorNext = (function* () {})().next;
const controlKey = Symbol("terminal controls");
const H = objectFreeze({
  closed: 0,
  claimed: 1,
  rootSlot: 2,
  rootPid: 3,
  nonce0: 4,
  nonce1: 5,
  contended: 6,
  selected: 8,
  selection: 9,
  mode: 10,
  modeRevision: 11,
  columns: 12,
  rows: 13,
  geometry: 14,
  wake: 15,
  gate: 16,
  inputNonce: 18,
  inputToken: 20,
  pageWaiting: 22,
  nextSelection: 23,
});
const GROUPS = 64,
  MEMBERS = GROUPS + 64 * 16;
const FREE = 0,
  PREPARING = 1,
  RUNNING = 2,
  RETIRED = 3;
const PENDING = 1,
  BOUND = 2,
  REMOVED = 3;
const pageOwner = -9223372036854775808n;
const turns = new WeakMapConstructor<TerminalTurn, Session>();
const timedWaitAsync = atomicsWaitAsync as
  | ((
      a: Int32Array,
      i: number,
      v: number,
      ms: number,
    ) => {
      async: boolean;
      value: string | Promise<string>;
    })
  | undefined;

type ProcessState = ReturnType<typeof workerProcessState>;
interface IdentityRecord extends TerminalIdentity {
  readonly kind: "waffle-terminal";
  readonly buffer: SharedArrayBuffer;
  readonly directory: SharedArrayBuffer;
  readonly directoryId: string;
  readonly nonce0: number;
  readonly nonce1: number;
  readonly rootSlot: number;
  readonly rootPid: number;
}
interface ContextRecord extends TerminalContext {
  readonly identity: IdentityRecord;
  readonly memberSlot: number;
  readonly memberGeneration: number;
}
function ok<T>(value: T): TerminalResult<T> {
  const result = { __proto__: null, kind: "ok" as const, value };
  return result;
}
function error(code: TerminalFailure): { kind: "error"; code: TerminalFailure } {
  const result = { __proto__: null, kind: "error" as const, code };
  return result;
}
function captureGeometry(geometry: TerminalGeometry): TerminalGeometry {
  return { columns: geometry.columns, rows: geometry.rows };
}
function validGeometry(size: TerminalGeometry): boolean {
  return (
    integer(size.columns) &&
    integer(size.rows) &&
    size.columns > 0 &&
    size.rows > 0 &&
    size.columns <= TERMINAL_SESSION_LIMITS.maximumDimension &&
    size.rows <= TERMINAL_SESSION_LIMITS.maximumDimension
  );
}
function isIdentity(value: unknown): value is IdentityRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || value.kind !== "waffle-terminal") return false;
  if (!("buffer" in value) || !isSharedArrayBuffer(value.buffer)) return false;
  if (!("directory" in value) || !isSharedArrayBuffer(value.directory)) return false;
  if (!("directoryId" in value) || typeof value.directoryId !== "string") return false;
  if (!("nonce0" in value) || typeof value.nonce0 !== "number") return false;
  if (!("nonce1" in value) || typeof value.nonce1 !== "number") return false;
  if (!("rootSlot" in value) || typeof value.rootSlot !== "number" || !integer(value.rootSlot))
    return false;
  return (
    "rootPid" in value &&
    typeof value.rootPid === "number" &&
    integer(value.rootPid) &&
    value.rootPid > 0
  );
}
function parseIdentity(value: unknown): IdentityRecord {
  if (
    !isIdentity(value) ||
    sharedArrayBufferByteLength(value.buffer) !== TERMINAL_SESSION_LIMITS.controlBytes
  )
    throw new TypeError("invalid terminal identity");
  const words = new Int32ArrayConstructor(value.buffer);
  if (
    atomicsLoad(words, H.rootSlot) !== value.rootSlot ||
    atomicsLoad(words, H.rootPid) !== value.rootPid ||
    atomicsLoad(words, H.nonce0) !== value.nonce0 ||
    atomicsLoad(words, H.nonce1) !== value.nonce1
  )
    throw new TypeError("terminal identity does not match control block");
  const directoryHeader = new Uint32ArrayConstructor(value.directory, 0, 8);
  if (`${directoryHeader[2]}:${directoryHeader[3]}` !== value.directoryId)
    throw new TypeError("terminal directory identity does not match");
  return value;
}
function parseContext(value: unknown): ContextRecord {
  if (typeof value !== "object" || value === null || !("identity" in value))
    throw new TypeError("invalid terminal context");
  parseIdentity(value.identity);
  if (
    !("memberSlot" in value) ||
    typeof value.memberSlot !== "number" ||
    !integer(value.memberSlot) ||
    value.memberSlot < -1 ||
    value.memberSlot >= TERMINAL_SESSION_LIMITS.memberships
  )
    throw new TypeError("invalid terminal membership slot");
  if (
    !("memberGeneration" in value) ||
    typeof value.memberGeneration !== "number" ||
    !integer(value.memberGeneration) ||
    value.memberGeneration < 0 ||
    value.memberGeneration > TERMINAL_SESSION_LIMITS.maximumGeneration ||
    (value.memberSlot === -1) !== (value.memberGeneration === 0)
  )
    throw new TypeError("invalid terminal membership generation");
  return value as ContextRecord;
}
function context(identity: IdentityRecord, memberSlot = -1, memberGeneration = 0): ContextRecord {
  return objectFreeze({ [contextBrand]: true as const, identity, memberSlot, memberGeneration });
}
function live(state: ProcessState): boolean {
  return readOutcome(state.signals.outcome) === null;
}
function findProcess(identity: IdentityRecord, pid: number): ProcessState | undefined {
  const processes = directoryProcesses(identity.directory);
  for (;;) {
    const step: IteratorResult<ProcessState> = reflectApply(generatorNext, processes, []);
    if (step.done) return undefined;
    if (step.value.pid === pid) return step.value;
  }
}
function alive(identity: IdentityRecord, slot: number, pid: number): ProcessState | undefined {
  try {
    const state = directoryState({ directory: identity.directory, slot, pid });
    return live(state) ? state : undefined;
  } catch (cause) {
    if (!isCollectedProcess(cause)) throw cause;
    return undefined;
  }
}
function mode(value: number): TerminalMode {
  return value === 1 ? "raw" : "cooked";
}
function modeWord(value: TerminalMode): number {
  return value === "raw" ? 1 : 0;
}

interface Allocation {
  readonly row: number;
  readonly generation: number;
  readonly group: boolean;
  next?: Allocation;
}
interface Publication {
  readonly operation: () => void;
  next?: Publication;
}
interface ControlFrame {
  readonly session: Session;
  readonly owner: ProcessState;
  readonly writes: Map<number, number>;
  state: "executing" | "committed" | "aborted";
  allocations?: Allocation;
  firstPublication?: Publication;
  lastPublication?: Publication;
  signalSelected?: boolean;
}
let activeControl: ControlFrame | undefined;
interface ControlRequest {
  previous?: ControlRequest;
  next?: ControlRequest;
  done: boolean;
  execute(): Promise<void>;
}
type ControlAttempt<T> = { kind: "busy" } | { kind: "done"; result: TerminalResult<T> };

function trackAllocation(session: Session, row: number, group: boolean): void {
  const frame = activeControl;
  if (!frame || frame.session.identity.buffer !== session.identity.buffer) return;
  frame.allocations = { row, generation: session.get(row), group, next: frame.allocations };
}
function rollbackControl(frame: ControlFrame): void {
  frame.state = "aborted";
  const s = frame.session;
  // Burn only newly reserved incarnations; reused metadata was never published.
  for (let allocation = frame.allocations; allocation; allocation = allocation.next) {
    if (atomicsLoad(s.words, allocation.row) > allocation.generation) continue;
    atomicsStore(s.words, allocation.row, allocation.generation);
    atomicsStore(s.words, allocation.row + 1, allocation.group ? RETIRED : REMOVED);
  }
}
function commitControl(frame: ControlFrame): void {
  mapForEach(frame.writes, (value, index) => atomicsStore(frame.session.words, index, value));
  frame.state = "committed";
  if (frame.signalSelected) frame.session.signalSelected();
  for (let publication = frame.firstPublication; publication; publication = publication.next)
    publication.operation();
}
function controlTurn(frame: ControlFrame): TerminalControlTurn {
  return objectFreeze({
    publish(operation: () => void) {
      if (activeControl !== frame || frame.state !== "executing")
        throw new TypeError("terminal control turn expired");
      const publication: Publication = { operation };
      if (frame.lastPublication) frame.lastPublication.next = publication;
      else frame.firstPublication = publication;
      frame.lastPublication = publication;
    },
  });
}
function syncControlResult<T>(result: TerminalResult<T>): TerminalResult<T> {
  if (typeof result !== "object" || result === null)
    throw new TypeError("terminal control must return a synchronous TerminalResult");
  if ("then" in result && typeof result.then === "function") {
    if (isInstance(result, PromiseConstructor)) observeRejectedPromise(result);
    throw new TypeError("terminal control must return a synchronous TerminalResult");
  }
  if (result.kind === "ok") return ok(result.value);
  if (result.kind === "error") return error(result.code);
  throw new TypeError("terminal control must return a synchronous TerminalResult");
}

class Session {
  private dirty = false;
  readonly words: Int32Array;
  readonly gate: BigInt64Array;
  readonly wake: Int32Array;
  readonly commonWake: Int32Array;
  constructor(readonly identity: IdentityRecord) {
    this.words = new Int32ArrayConstructor(identity.buffer);
    this.gate = new BigInt64ArrayConstructor(identity.buffer, H.gate * 4, 1);
    this.wake = new Int32ArrayConstructor(identity.buffer, H.wake * 4, 1);
    this.commonWake = new Int32ArrayConstructor(identity.directory, 4, 1);
  }
  get(index: number): number {
    const frame = activeControl;
    if (frame?.session.identity.buffer === this.identity.buffer && frame.state === "executing") {
      const staged = mapGet(frame.writes, index);
      if (staged !== undefined) return staged;
    }
    return atomicsLoad(this.words, index);
  }
  put(index: number, value: number): void {
    if (this.get(index) !== value) this.dirty = true;
    const frame = activeControl;
    if (frame?.session.identity.buffer === this.identity.buffer && frame.state === "executing") {
      mapSet(frame.writes, index, value);
      return;
    }
    atomicsStore(this.words, index, value);
  }
  closed(): boolean {
    return this.get(H.closed) !== 0;
  }
  close(): void {
    atomicsCompareExchange(this.words, H.closed, 0, 1);
    this.notify();
  }
  notify(): void {
    atomicsAdd(this.wake, 0, 1);
    atomicsNotify(this.wake, 0);
    atomicsAdd(this.commonWake, 0, 1);
    atomicsNotify(this.commonWake, 0);
  }
  rootLive(): boolean {
    return alive(this.identity, this.identity.rootSlot, this.identity.rootPid) !== undefined;
  }
  transact<T>(
    owner: ProcessState | typeof pageOwner,
    operation: () => TerminalResult<T>,
  ): TerminalResult<T> {
    if (this.closed()) return error("CLOSED");
    if (!this.rootLive()) {
      this.close();
      return error("PROCESS_GONE");
    }
    if (activeControl) {
      if (
        terminalPolicyActive() ||
        activeControl.state !== "executing" ||
        activeControl.session.identity.buffer !== this.identity.buffer
      )
        return error("INVALID");
      if (
        typeof owner !== "bigint" &&
        (owner.pid !== activeControl.owner.pid || owner.slot !== activeControl.owner.slot)
      )
        return error("DENIED");
      return operation();
    }
    if (typeof owner === "bigint") return this.lock(owner, operation);
    if (!enterTerminalSection(owner)) return error("CANCELED");
    try {
      return this.lock(BigIntConstructor(owner.pid), operation);
    } finally {
      leaveTerminalSection(owner, this.identity.directory);
    }
  }
  private lock<T>(owner: bigint, operation: () => TerminalResult<T>): TerminalResult<T> {
    if (this.get(H.pageWaiting) !== 0) return this.contend(true);
    if (atomicsCompareExchange(this.gate, 0, 0n, owner) !== 0n) return this.contend();
    this.dirty = false;
    try {
      if (this.closed()) return error("CLOSED");
      return operation();
    } finally {
      atomicsStore(this.gate, 0, 0n);
      const contended = atomicsExchange(this.words, H.contended, 0);
      if (this.dirty || contended !== 0) this.notify();
    }
  }
  private contend(reserved = false): TerminalResult<never> {
    atomicsStore(this.words, H.contended, 1);
    // Either the holder sees our hint after unlocking, or it already released and we wake
    // the scan ourselves. A fully notified poll observed its sequence before losing this CAS.
    if (!reserved && atomicsLoad(this.gate, 0) === 0n) this.notify();
    return error("AGAIN");
  }
  control<T>(
    state: ProcessState,
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    signal?: AbortSignal,
    check?: () => TerminalFailure | undefined,
  ): ControlAttempt<T> {
    if (signal && abortSignalAborted(signal)) return { kind: "done", result: error("CANCELED") };
    if (this.closed()) return { kind: "done", result: error("CLOSED") };
    if (!this.rootLive()) return { kind: "done", result: error("PROCESS_GONE") };
    if (!enterTerminalSection(state)) return { kind: "done", result: error("CANCELED") };
    try {
      return this.controlLock(state, work, signal, check);
    } finally {
      leaveTerminalSection(state, this.identity.directory);
    }
  }
  private controlLock<T>(
    state: ProcessState,
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    signal?: AbortSignal,
    check?: () => TerminalFailure | undefined,
  ): ControlAttempt<T> {
    if (atomicsCompareExchange(this.gate, 0, 0n, BigIntConstructor(state.pid)) !== 0n)
      return { kind: "busy" };
    this.dirty = false;
    try {
      return { kind: "done", result: this.runControl(state, work, signal, check) };
    } finally {
      atomicsStore(this.gate, 0, 0n);
      atomicsExchange(this.words, H.contended, 0);
      this.notify();
    }
  }
  private runControl<T>(
    state: ProcessState,
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    signal?: AbortSignal,
    check?: () => TerminalFailure | undefined,
  ): TerminalResult<T> {
    const frame: ControlFrame = {
      session: this,
      owner: state,
      writes: new MapConstructor(),
      state: "executing",
    };
    activeControl = frame;
    try {
      return withTerminalControl(() => this.completeControl(frame, work, signal, check));
    } finally {
      activeControl = undefined;
    }
  }
  private completeControl<T>(
    frame: ControlFrame,
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    signal?: AbortSignal,
    check?: () => TerminalFailure | undefined,
  ): TerminalResult<T> {
    try {
      const denied = check?.();
      if (denied) return error(denied);
      const result = syncControlResult(work(controlTurn(frame)));
      const failure = (signal && abortSignalAborted(signal) ? "CANCELED" : undefined) ?? check?.();
      if (result.kind === "error" || failure || !this.rootLive() || this.closed())
        rollbackControl(frame);
      if (failure) return error(failure);
      if (!this.rootLive()) return error("PROCESS_GONE");
      if (this.closed() && result.kind === "ok") return error("CLOSED");
      if (result.kind === "ok") commitControl(frame);
      return result;
    } catch (cause) {
      if (frame.state === "committed") this.close();
      else rollbackControl(frame);
      throw cause;
    }
  }
  next(index: number): TerminalResult<number> {
    let previous = this.get(index);
    const reserved = index === H.selection ? atomicsLoad(this.words, H.nextSelection) : previous;
    if (reserved > previous) previous = reserved;
    if (previous >= TERMINAL_SESSION_LIMITS.maximumGeneration) {
      this.close();
      return error("EXHAUSTED");
    }
    if (index === H.selection) atomicsStore(this.words, H.nextSelection, previous + 1);
    return ok(previous + 1);
  }
  selection(): TerminalSelection | null {
    return this.get(H.selected) === 0 ? null : (this.get(H.selection) as TerminalSelection);
  }
  geometry(): TerminalGeometrySnapshot {
    return { columns: this.get(H.columns), rows: this.get(H.rows), revision: this.get(H.geometry) };
  }
  snapshot(): TerminalSnapshot {
    return {
      mode: mode(this.get(H.mode)),
      modeRevision: this.get(H.modeRevision),
      geometry: this.geometry(),
      selection: this.selection(),
    };
  }
  turn<T>(callback: (turn: TerminalTurn) => T): T {
    let valid = true;
    const snapshot = this.snapshot();
    const read = <K extends keyof TerminalSnapshot>(key: K): TerminalSnapshot[K] => {
      if (!valid) throw new TypeError("terminal turn expired");
      return snapshot[key];
    };
    const turn: TerminalTurn = objectFreeze({
      [turnBrand]: true as const,
      get mode() {
        return read("mode");
      },
      get modeRevision() {
        return read("modeRevision");
      },
      get geometry() {
        return read("geometry");
      },
      get selection() {
        return read("selection");
      },
    });
    weakMapSet(turns, turn, this);
    try {
      return withTerminalPolicy(() => callback(turn));
    } catch (cause) {
      this.close();
      throw cause;
    } finally {
      valid = false;
    }
  }
  transition(policy: TerminalPolicy, change: TerminalChange): TerminalResult<void> {
    const accepted = this.turn((turn) => policy.transition(turn, change).kind === "ok");
    if (accepted && !this.closed() && this.rootLive()) return ok(undefined);
    this.close();
    return error("CLOSED");
  }
  signalSelected(): void {
    const frame = activeControl;
    if (frame?.session.identity.buffer === this.identity.buffer && frame.state === "executing") {
      frame.signalSelected = true;
      return;
    }
    const selected = this.get(H.selected) - 1;
    if (selected < 0) return;
    for (let slot = 0; slot < TERMINAL_SESSION_LIMITS.memberships; slot++)
      this.signalMember(slot, selected);
  }
  private signalMember(slot: number, selected: number): void {
    const row = MEMBERS + slot * 16;
    if (this.get(row + 1) !== BOUND || this.get(row + 2) !== selected) return;
    const state = alive(this.identity, this.get(row + 4), this.get(row + 5));
    if (state) requestSignal(state.signals, Signal.SIGWINCH);
  }
}

/** Internal lock publication precedes the input CAS, while this turn owns the Session gate. */
export function terminalInputSection<T>(
  turn: TerminalTurn,
  nonce: bigint,
  token: bigint,
  operation: () => T,
): T {
  const session = weakMapGet(turns, turn);
  if (!session) return operation(); // Direct policy calls have no Session lifetime to fence.
  void turn.mode; // The frozen turn getter rejects a retained, expired turn before publication.
  const record = new BigInt64ArrayConstructor(session.identity.buffer, H.inputNonce * 4, 2);
  atomicsStore(record, 0, nonce);
  atomicsStore(record, 1, token);
  try {
    return operation();
  } finally {
    atomicsStore(record, 1, 0n);
    atomicsStore(record, 0, 0n);
  }
}

/** Trusted stop capture. Physical death closes an interrupted session without unlocking it. */
export function terminalStopCapture(identity: TerminalIdentity, process: WorkerProcessTransport) {
  const parsed = parseIdentity(identity);
  const state = workerProcessState(process);
  if (workerProcessDirectoryId(process) !== parsed.directoryId || state.rootPid !== parsed.rootPid)
    throw new TypeError("terminal stop capture belongs to another process root");
  const root = directoryState({
    directory: parsed.directory,
    slot: parsed.rootSlot,
    pid: parsed.rootPid,
  });
  if (root.pid !== state.rootPid) throw new TypeError("terminal root incarnation does not match");
  const session = new Session(parsed);
  const record = new BigInt64ArrayConstructor(parsed.buffer, H.inputNonce * 4, 2);
  return (poisonInput: (nonce: bigint, token: bigint) => void): void => {
    if (atomicsLoad(session.gate, 0) !== BigIntConstructor(state.pid)) return;
    session.close();
    const nonce = atomicsLoad(record, 0),
      token = atomicsLoad(record, 1);
    if (nonce !== 0n && token !== 0n) poisonInput(nonce, token);
  };
}

export function createTerminalSession(options: {
  readonly controller: WorkerProcessTransport;
  readonly geometry: TerminalGeometry;
}): TerminalDisplay {
  const controller = options.controller,
    geometry = captureGeometry(options.geometry);
  if (!validGeometry(geometry)) throw new RangeError("invalid terminal geometry");
  const state = workerProcessState(controller);
  if (!live(state) || state.rootPid !== state.pid)
    throw new ProcessError(ProcessErrno.SRCH, "terminal root is not live");
  const buffer = new SharedArrayBufferConstructor(TERMINAL_SESSION_LIMITS.controlBytes);
  const random = cryptoGetRandomValues(new Uint32ArrayConstructor(2));
  const identity: IdentityRecord = objectFreeze({
    [identityBrand]: true as const,
    kind: "waffle-terminal",
    buffer,
    directory: controller.directory,
    directoryId: workerProcessDirectoryId(controller),
    nonce0: random[0]! | 0,
    nonce1: random[1]! | 0,
    rootSlot: state.slot,
    rootPid: state.pid,
  });
  const session = new Session(identity);
  session.put(H.rootSlot, state.slot);
  session.put(H.rootPid, state.pid);
  session.put(H.nonce0, identity.nonce0);
  session.put(H.nonce1, identity.nonce1);
  session.put(H.columns, geometry.columns);
  session.put(H.rows, geometry.rows);
  session.put(H.geometry, 1);
  session.put(H.modeRevision, 1);
  return new Display(session);
}
class Display implements TerminalDisplay {
  readonly identity: TerminalIdentity;
  constructor(private readonly session: Session) {
    this.identity = session.identity;
  }
  inherit(): TerminalContext {
    return context(this.session.identity);
  }
  snapshot(): TerminalResult<TerminalSnapshot> {
    return this.session.transact(pageOwner, () => ok(this.session.snapshot()));
  }
  input(accept: (turn: TerminalTurn) => number): TerminalResult<number> {
    return this.session.transact(pageOwner, () => this.accept(accept));
  }
  private accept(callback: (turn: TerminalTurn) => number): TerminalResult<number> {
    const count = this.session.turn(callback);
    if (count === -ProcessErrno.AGAIN) return error("AGAIN");
    if (!integer(count) || count < 0 || count > TERMINAL_SESSION_LIMITS.inputBytesPerTurn) {
      this.session.close();
      return error("INVALID");
    }
    if (!this.session.rootLive()) this.session.close();
    if (count >= 0) this.session.notify();
    return this.session.closed() ? error("CLOSED") : ok(count);
  }
  resize(geometry: TerminalGeometry): TerminalResult<TerminalGeometrySnapshot> {
    const captured = captureGeometry(geometry);
    if (!validGeometry(captured)) return error("INVALID");
    return this.session.transact(pageOwner, () => this.publishGeometry(captured));
  }
  private publishGeometry(geometry: TerminalGeometry): TerminalResult<TerminalGeometrySnapshot> {
    const s = this.session;
    if (s.get(H.columns) === geometry.columns && s.get(H.rows) === geometry.rows)
      return ok(s.geometry());
    const next = s.next(H.geometry);
    if (next.kind === "error") return next;
    s.put(H.columns, geometry.columns);
    s.put(H.rows, geometry.rows);
    s.put(H.geometry, next.value);
    s.signalSelected();
    return ok(s.geometry());
  }
  outputDrained(): void {
    this.session.notify();
  }
  close(_reason: TerminalReason): void {
    this.session.close();
  }
}

class Group implements TerminalGroup {
  readonly controlFrame = activeControl;
  readonly [groupBrand] = true;
  readonly local = () => {};
  constructor(
    readonly owner: Authority,
    readonly row: number,
    readonly generation: number,
  ) {}
}
class Member implements TerminalMember {
  readonly controlFrame = activeControl;
  readonly [memberBrand] = true;
  readonly local = () => {};
  constructor(
    readonly owner: Authority,
    readonly row: number,
    readonly generation: number,
  ) {}
}
class Plan implements TerminalMemberPlan {
  readonly controlFrame = activeControl;
  readonly [planBrand] = true;
  readonly local = () => {};
  constructor(
    readonly owner: Authority,
    readonly row: number,
    readonly generation: number,
  ) {}
}
class Lease implements TerminalLease {
  readonly controlFrame = activeControl;
  readonly [leaseBrand] = true;
  readonly local = () => {};
  constructor(
    readonly owner: Authority,
    readonly group: Group,
    readonly generation: number,
  ) {}
}

export function claimTerminalAuthority(options: {
  readonly identity: TerminalIdentity;
  readonly process: WorkerProcessTransport;
  readonly checkActive: () => void;
  readonly policy: TerminalPolicy;
}): TerminalResult<TerminalAuthority> {
  const { identity: input, process, checkActive, policy } = options;
  const identity = parseIdentity(input);
  checkActive();
  if (
    workerProcessDirectoryId(process) !== identity.directoryId ||
    process.slot !== identity.rootSlot ||
    process.pid !== identity.rootPid
  )
    return error("DENIED");
  const session = new Session(identity);
  const state = workerProcessState(process);
  return session.transact(state, () => {
    checkActive();
    if (atomicsCompareExchange(session.words, H.claimed, 0, 1) !== 0) return error("DENIED");
    return ok(new Authority(session, state, checkActive, policy));
  });
}
class Authority implements TerminalAuthority {
  private first?: ControlRequest;
  private last?: ControlRequest;
  private pumping = false;
  readonly local = () => {};
  constructor(
    readonly session: Session,
    private readonly state: ProcessState,
    private readonly checkActive: () => void,
    private readonly policy: TerminalPolicy,
  ) {}
  control<T>(
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    options: TerminalControlOptions = {},
  ): Promise<TerminalResult<T>> {
    assertTerminalWaitAllowed();
    return this.submit(work, options, (result) => result);
  }
  prepare<T>(
    work: (turn: TerminalControlTurn) => TerminalResult<void>,
    options: TerminalControlOptions,
    finish: (result: TerminalResult<void>) => T,
    check: () => TerminalFailure | undefined,
  ): Promise<TerminalResult<T>> {
    return this.submit(work, options, (result) => ok(finish(result)), check);
  }
  matches(process: WorkerProcessTransport): boolean {
    const state = workerProcessState(process);
    return (
      workerProcessDirectoryId(process) === this.session.identity.directoryId &&
      state.pid === this.session.identity.rootPid &&
      state.slot === this.session.identity.rootSlot
    );
  }
  private submit<T, U>(
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    options: TerminalControlOptions,
    finish: (result: TerminalResult<T>) => TerminalResult<U>,
    check?: () => TerminalFailure | undefined,
  ): Promise<TerminalResult<U>> {
    return new PromiseConstructor((resolve, reject) => {
      if (terminalTurnActive()) {
        reject(new ProcessError(ProcessErrno.NOTSUP, "recursive terminal control wait"));
        return;
      }
      const signal = options.signal;
      let request: ControlRequest;
      const settle = (result: TerminalResult<U> | undefined, cause?: unknown) => {
        if (request.done) return;
        request.done = true;
        this.unlink(request);
        atomicsAdd(this.session.words, H.pageWaiting, -1);
        if (signal) unlistenAbort(signal, cancel);
        this.session.notify();
        if (result) resolve(result);
        else reject(cause);
      };
      const cancel = () => settle(error("CANCELED"));
      request = {
        done: false,
        execute: async () => {
          try {
            const result = await this.executeControl(work, signal, request, finish, check);
            settle(result);
          } catch (cause) {
            settle(undefined, cause);
          }
        },
      };
      request.previous = this.last;
      if (this.last) this.last.next = request;
      else this.first = request;
      this.last = request;
      atomicsAdd(this.session.words, H.pageWaiting, 1);
      if (signal) listenAbort(signal, cancel);
      if (signal && abortSignalAborted(signal)) cancel();
      this.session.notify();
      if (!this.pumping) void this.pump();
    });
  }
  private unlink(request: ControlRequest): void {
    if (request.previous) request.previous.next = request.next;
    else this.first = request.next;
    if (request.next) request.next.previous = request.previous;
    else this.last = request.previous;
    request.previous = undefined;
    request.next = undefined;
  }
  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.first) await this.first.execute();
    } finally {
      this.pumping = false;
    }
  }
  private async executeControl<T, U>(
    work: (turn: TerminalControlTurn) => TerminalResult<T>,
    signal: AbortSignal | undefined,
    request: ControlRequest,
    finish: (result: TerminalResult<T>) => TerminalResult<U>,
    check?: () => TerminalFailure | undefined,
  ): Promise<TerminalResult<U>> {
    for (;;) {
      const seen = atomicsLoad(this.session.commonWake, 0);
      if (request.done) return error("CANCELED");
      this.checkActive();
      const result = this.session.control(this.state, work, signal, check);
      if (result.kind === "done") return finish(result.result);
      const waiting = atomicsWaitAsync(this.session.commonWake, 0, seen);
      if (waiting.async) await waiting.value;
    }
  }
  private run<T>(operation: () => TerminalResult<T>): TerminalResult<T> {
    this.checkActive();
    return this.session.transact(this.state, () => {
      this.checkActive();
      return operation();
    });
  }
  private confirm(check: () => boolean): TerminalResult<void> {
    try {
      this.checkActive();
      if (!this.session.closed() && this.session.rootLive() && check()) return ok(undefined);
    } catch (cause) {
      this.session.close();
      throw cause;
    }
    this.session.close();
    return error("CLOSED");
  }
  private group(value: TerminalGroup): Group | undefined {
    if (
      !isInstance(value, Group) ||
      value.owner !== this ||
      value.controlFrame?.state === "aborted"
    )
      return undefined;
    return this.session.get(value.row) === value.generation ? value : undefined;
  }
  private activeGroup(value: TerminalGroup): Group | undefined {
    const group = this.group(value);
    return group && this.session.get(group.row + 1) !== RETIRED ? group : undefined;
  }
  private member(value: TerminalMember): Member | undefined {
    if (
      !isInstance(value, Member) ||
      value.owner !== this ||
      value.controlFrame?.state === "aborted"
    )
      return undefined;
    return this.session.get(value.row) === value.generation ? value : undefined;
  }
  private plan(value: TerminalMemberPlan): Plan | undefined {
    if (!isInstance(value, Plan) || value.owner !== this || value.controlFrame?.state === "aborted")
      return undefined;
    return this.session.get(value.row) === value.generation ? value : undefined;
  }
  private lease(value: TerminalLease): Lease | undefined {
    if (
      !isInstance(value, Lease) ||
      value.owner !== this ||
      value.controlFrame?.state === "aborted"
    )
      return undefined;
    if (
      !this.activeGroup(value.group) ||
      this.session.get(H.selected) !== (value.group.row - GROUPS) / 16 + 1
    )
      return undefined;
    return this.session.get(H.selection) === value.generation ? value : undefined;
  }
  private allocate(start: number, count: number): TerminalResult<number> {
    for (let slot = 0; slot < count; slot++) {
      const row = start + slot * 16,
        state = this.session.get(row + 1);
      if (state !== FREE && state !== RETIRED) continue;
      const next = this.session.next(row);
      if (next.kind === "error") return next;
      return ok(row);
    }
    return error("CAPACITY");
  }
  createGroup(options: { readonly initialMode: TerminalMode }): TerminalResult<TerminalGroup> {
    const { initialMode } = options;
    return this.run(() => {
      if (initialMode !== "raw" && initialMode !== "cooked") return error("INVALID");
      const allocated = this.allocate(GROUPS, TERMINAL_SESSION_LIMITS.groups);
      if (allocated.kind === "error") return allocated;
      const row = allocated.value,
        generation = this.session.get(row) + 1;
      this.session.put(row, generation);
      this.session.put(row + 1, PREPARING);
      this.session.put(row + 2, modeWord(initialMode));
      this.session.put(row + 3, 0);
      trackAllocation(this.session, row, true);
      return ok(new Group(this, row, generation));
    });
  }
  planMember(options: {
    readonly group: TerminalGroup;
    readonly parent: TerminalMember;
  }): TerminalResult<TerminalPlannedMember> {
    const { group, parent } = options;
    return this.run(() => this.planInGroup({ group, parent }));
  }
  private planInGroup(options: {
    readonly group: TerminalGroup;
    readonly parent: TerminalMember;
  }): TerminalResult<TerminalPlannedMember> {
    const group = this.activeGroup(options.group),
      parent = this.member(options.parent),
      s = this.session;
    if (!group || !parent || s.get(parent.row + 1) !== BOUND) return error("STALE");
    if (!alive(s.identity, s.get(parent.row + 4), s.get(parent.row + 5)))
      return error("PROCESS_GONE");
    const allocation = this.allocate(MEMBERS, TERMINAL_SESSION_LIMITS.memberships);
    if (allocation.kind === "error") return allocation;
    const row = allocation.value,
      generation = s.get(row) + 1;
    s.put(row, generation);
    s.put(row + 1, PENDING);
    s.put(row + 2, (group.row - GROUPS) / 16);
    s.put(row + 3, group.generation);
    s.put(row + 4, -1);
    s.put(row + 5, 0);
    s.put(row + 6, s.get(parent.row + 4));
    s.put(row + 7, s.get(parent.row + 5));
    trackAllocation(s, row, false);
    return ok({
      member: new Plan(this, row, generation),
      context: context(s.identity, (row - MEMBERS) / 16, generation),
    });
  }
  bindMember(options: {
    readonly planned: TerminalMemberPlan;
    readonly pid: number;
  }): TerminalResult<TerminalAdmittedMember> {
    const { planned, pid } = options;
    const state = findProcess(this.session.identity, pid);
    return this.run(() => this.bind(planned, state));
  }
  private bind(
    value: TerminalMemberPlan,
    state: ProcessState | undefined,
  ): TerminalResult<TerminalAdmittedMember> {
    const plan = this.plan(value),
      s = this.session;
    if (!plan || s.get(plan.row + 1) === REMOVED) return error("CANCELED");
    if (!state || !alive(s.identity, state.slot, state.pid)) return error("PROCESS_GONE");
    if (s.get(plan.row + 1) === BOUND)
      return s.get(plan.row + 5) === state.pid ? ok(this.admitted(plan.row)) : error("INVALID");
    if (
      !this.authorized(state) ||
      state.parentPid !== s.get(plan.row + 7) ||
      !alive(s.identity, s.get(plan.row + 6), state.parentPid)
    )
      return error("DENIED");
    const group = this.rowGroup(plan.row);
    if (!group) return error("STALE");
    if (this.existingMember(group, state.pid) !== undefined) return error("INVALID");
    const changed = this.membershipChange(
      group,
      () =>
        !!alive(s.identity, state.slot, state.pid) &&
        this.authorized(state) &&
        !!alive(s.identity, s.get(plan.row + 6), state.parentPid),
    );
    if (changed.kind === "error") return changed;
    s.put(plan.row + 4, state.slot);
    s.put(plan.row + 5, state.pid);
    s.put(plan.row + 1, BOUND);
    s.signalSelected();
    return ok(this.admitted(plan.row));
  }
  private rowGroup(row: number): Group | undefined {
    const s = this.session,
      groupRow = GROUPS + s.get(row + 2) * 16;
    const group = new Group(this, groupRow, s.get(row + 3));
    return this.activeGroup(group);
  }
  private authorized(state: ProcessState): boolean {
    return (
      state.rootPid === this.session.identity.rootPid &&
      directoryControls(
        this.session.identity.directory,
        () => controlLoad(state.controlParent),
        this.session.identity.rootPid,
      )
    );
  }
  admitExisting(options: {
    readonly group: TerminalGroup;
    readonly pid: number;
  }): TerminalResult<TerminalAdmittedMember> {
    const { group, pid } = options;
    const state = findProcess(this.session.identity, pid);
    return this.run(() => this.admit(group, state));
  }
  private admit(
    value: TerminalGroup,
    state: ProcessState | undefined,
  ): TerminalResult<TerminalAdmittedMember> {
    const group = this.activeGroup(value),
      s = this.session;
    if (!group) return error("STALE");
    if (!state || !alive(s.identity, state.slot, state.pid)) return error("PROCESS_GONE");
    if (state.pid !== s.identity.rootPid && !this.authorized(state)) return error("DENIED");
    const duplicate = this.existingMember(group, state.pid);
    if (duplicate !== undefined) return ok(this.admitted(duplicate));
    const allocation = this.allocate(MEMBERS, TERMINAL_SESSION_LIMITS.memberships);
    if (allocation.kind === "error") return allocation;
    const changed = this.membershipChange(
      group,
      () =>
        !!alive(s.identity, state.slot, state.pid) &&
        (state.pid === s.identity.rootPid || this.authorized(state)),
    );
    if (changed.kind === "error") return changed;
    const row = allocation.value;
    s.put(row, s.get(row) + 1);
    s.put(row + 1, BOUND);
    s.put(row + 2, (group.row - GROUPS) / 16);
    s.put(row + 3, group.generation);
    s.put(row + 4, state.slot);
    s.put(row + 5, state.pid);
    trackAllocation(s, row, false);
    return ok(this.admitted(row));
  }
  private existingMember(group: Group, pid: number): number | undefined {
    for (let slot = 0; slot < TERMINAL_SESSION_LIMITS.memberships; slot++) {
      const row = MEMBERS + slot * 16;
      if (
        this.session.get(row + 1) === BOUND &&
        this.session.get(row + 5) === pid &&
        this.session.get(row + 2) === (group.row - GROUPS) / 16 &&
        this.session.get(row + 3) === group.generation
      )
        return row;
    }
    return undefined;
  }
  private currentLease(group: Group): TerminalLease | null {
    if (this.session.get(H.selected) !== (group.row - GROUPS) / 16 + 1) return null;
    return new Lease(this, group, this.session.get(H.selection));
  }
  private admitted(row: number): TerminalAdmittedMember {
    const group = this.rowGroup(row)!;
    return {
      member: new Member(this, row, this.session.get(row)),
      context: context(this.session.identity, (row - MEMBERS) / 16, this.session.get(row)),
      lease: this.currentLease(group),
    };
  }
  private membershipChange(group: Group, check = () => true): TerminalResult<void> {
    const s = this.session,
      roster = s.next(group.row + 3);
    if (roster.kind === "error") return roster;
    const selection = this.currentLease(group) === null ? ok(null) : s.next(H.selection);
    if (selection.kind === "error") return selection;
    if (selection.value !== null) {
      const changed = s.transition(this.policy, {
        kind: "membership",
        previous: s.selection()!,
        next: selection.value as TerminalSelection,
      });
      if (changed.kind === "error") return changed;
    }
    const confirmed = this.confirm(check);
    if (confirmed.kind === "error") return confirmed;
    s.put(group.row + 3, roster.value);
    if (selection.value !== null) s.put(H.selection, selection.value);
    return ok(undefined);
  }
  cancelPlan(value: TerminalMemberPlan): TerminalResult<void> {
    return this.run(() => {
      const plan = this.plan(value);
      if (!plan) return error("STALE");
      if (this.session.get(plan.row + 1) === BOUND) return error("DENIED");
      this.session.put(plan.row + 1, REMOVED);
      return ok(undefined);
    });
  }
  removeMember(value: TerminalMember): TerminalResult<TerminalMemberUpdate> {
    return this.run(() => {
      const member = this.member(value);
      if (!member) return error("STALE");
      const group = this.rowGroup(member.row);
      if (!group) return error("STALE");
      if (this.session.get(member.row + 1) === REMOVED)
        return ok({ lease: this.currentLease(group) });
      const changed = this.membershipChange(group);
      if (changed.kind === "error") return changed;
      this.session.put(member.row + 1, REMOVED);
      return ok({ lease: this.currentLease(group) });
    });
  }
  private membersLive(group: Group): boolean {
    for (let slot = 0; slot < TERMINAL_SESSION_LIMITS.memberships; slot++) {
      const row = MEMBERS + slot * 16;
      if (
        this.session.get(row + 1) !== BOUND ||
        this.session.get(row + 2) !== (group.row - GROUPS) / 16
      )
        continue;
      if (!alive(this.session.identity, this.session.get(row + 4), this.session.get(row + 5)))
        return false;
    }
    return true;
  }
  acquire(options: {
    readonly group: TerminalGroup;
    readonly expected: null;
  }): TerminalResult<TerminalLease> {
    const { group } = options;
    return this.run(() => {
      if (this.session.get(H.selected) !== 0) return error("STALE");
      return this.select(group);
    });
  }
  transfer(options: {
    readonly from: TerminalLease;
    readonly to: TerminalGroup;
  }): TerminalResult<TerminalLease> {
    const { from, to } = options;
    return this.run(() => {
      if (!this.lease(from)) return error("STALE");
      return this.select(to);
    });
  }
  private select(value: TerminalGroup): TerminalResult<Lease> {
    const group = this.activeGroup(value),
      s = this.session;
    if (!group) return error("STALE");
    if (!this.membersLive(group)) return error("PROCESS_GONE");
    const next = s.next(H.selection),
      revision = s.next(H.modeRevision);
    if (next.kind === "error") return next;
    if (revision.kind === "error") return revision;
    const changed = s.transition(this.policy, {
      kind: "selection",
      previous: s.selection(),
      next: next.value as TerminalSelection,
    });
    if (changed.kind === "error") return changed;
    const confirmed = this.confirm(() => this.membersLive(group));
    if (confirmed.kind === "error") return confirmed;
    this.saveMode();
    s.put(group.row + 1, RUNNING);
    s.put(H.selected, (group.row - GROUPS) / 16 + 1);
    s.put(H.selection, next.value);
    s.put(H.mode, s.get(group.row + 2));
    s.put(H.modeRevision, revision.value);
    s.signalSelected();
    return ok(new Lease(this, group, next.value));
  }
  private saveMode(): void {
    const selected = this.session.get(H.selected) - 1;
    if (selected >= 0) this.session.put(GROUPS + selected * 16 + 2, this.session.get(H.mode));
  }
  startBackground(value: TerminalGroup): TerminalResult<void> {
    return this.run(() => {
      const group = this.activeGroup(value);
      if (!group) return error("STALE");
      if (this.currentLease(group)) return error("DENIED");
      if (!this.membersLive(group)) return error("PROCESS_GONE");
      this.session.put(group.row + 1, RUNNING);
      return ok(undefined);
    });
  }
  release(options: {
    readonly lease: TerminalLease;
    readonly restore: TerminalGroup | null;
  }): TerminalResult<TerminalLease | null> {
    const { lease, restore } = options;
    return this.run(() => {
      if (!this.lease(lease)) return error("STALE");
      if (restore !== null) return this.select(restore);
      const next = this.session.next(H.selection);
      if (next.kind === "error") return next;
      const changed = this.session.transition(this.policy, {
        kind: "selection",
        previous: this.session.selection(),
        next: null,
      });
      if (changed.kind === "error") return changed;
      const confirmed = this.confirm(() => true);
      if (confirmed.kind === "error") return confirmed;
      this.saveMode();
      this.session.put(H.selected, 0);
      this.session.put(H.selection, next.value);
      return ok(null);
    });
  }
  retireGroup(options: {
    readonly group: TerminalGroup;
    readonly reason: TerminalReason;
  }): TerminalResult<void> {
    const { group } = options;
    return this.run(() => this.retire(group));
  }
  private retire(value: TerminalGroup): TerminalResult<void> {
    const group = this.group(value),
      s = this.session;
    if (!group) return error("STALE");
    if (this.currentLease(group)) return error("DENIED");
    s.put(group.row + 1, RETIRED);
    for (let slot = 0; slot < TERMINAL_SESSION_LIMITS.memberships; slot++) {
      const row = MEMBERS + slot * 16;
      if (s.get(row + 2) === (group.row - GROUPS) / 16 && s.get(row + 3) === group.generation)
        s.put(row + 1, REMOVED);
    }
    return ok(undefined);
  }
}

export function attachTerminal(options: {
  readonly context: unknown;
  readonly process: WorkerProcessTransport;
  readonly checkActive: () => void;
  readonly policy: TerminalPolicy;
}): TerminalAttachment {
  const parsed = parseContext(options.context),
    identity = parsed.identity;
  if (workerProcessDirectoryId(options.process) !== identity.directoryId)
    throw new ProcessError(ProcessErrno.NOTSUP, "terminal belongs to another process directory");
  const state = workerProcessState(options.process);
  if (!live(state)) throw new ProcessError(ProcessErrno.SRCH, "terminal process has exited");
  if (state.rootPid !== identity.rootPid)
    throw new ProcessError(ProcessErrno.NOTSUP, "terminal belongs to another root");
  return new Attachment(new Session(identity), parsed, state, options.checkActive, options.policy);
}

async function waitForChange(session: Session, seen: number): Promise<void> {
  if (!timedWaitAsync) {
    await new PromiseConstructor<void>((resolve) => scheduleTimeout(resolve, 10));
    return;
  }
  const waiting = timedWaitAsync(session.wake, 0, seen, 10);
  if (waiting.async) await waiting.value;
}
function errno(failure: TerminalFailure): number {
  if (failure === "AGAIN" || failure === "CAPACITY") return -ProcessErrno.AGAIN;
  return -ProcessErrno.BADF;
}
function byteCapacity(chunks: readonly Uint8Array[]): number {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += typedArrayLength(chunks[i]!);
  return total;
}

class Attachment implements TerminalAttachment {
  readonly identity: TerminalIdentity;
  readonly endpoints = new MapConstructor<Endpoint, true>();
  readonly cursors = new MapConstructor<GeometryCursor, true>();
  private disposed = false;
  constructor(
    readonly session: Session,
    readonly context: ContextRecord,
    readonly state: ProcessState,
    readonly checkActive: () => void,
    readonly policy: TerminalPolicy,
  ) {
    this.identity = session.identity;
  }
  check(state = this.state): TerminalFailure | undefined {
    this.checkActive();
    if (this.disposed) return "CANCELED";
    if (!alive(this.session.identity, state.slot, state.pid)) return "PROCESS_GONE";
    if (!this.session.rootLive()) {
      this.session.close();
      return "PROCESS_GONE";
    }
    if (this.session.closed()) return "CLOSED";
    return undefined;
  }
  run<T>(state: ProcessState, callback: () => TerminalResult<T>): TerminalResult<T> {
    const denied = this.check(state);
    if (denied) return error(denied);
    return this.session.transact(state, () => {
      const failure = this.check(state);
      return failure ? error(failure) : callback();
    });
  }
  private startup(): TerminalResult<void> {
    const failure = this.check();
    if (failure) return error(failure);
    if (this.context.memberSlot < 0) return ok(undefined);
    const s = this.session,
      row = MEMBERS + this.context.memberSlot * 16;
    if (s.get(row) !== this.context.memberGeneration || s.get(row + 1) === REMOVED)
      return error("CANCELED");
    if (s.get(row + 1) === PENDING) {
      if (s.get(row + 7) !== this.state.parentPid) return error("DENIED");
      return error("AGAIN");
    }
    if (s.get(row + 4) !== this.state.slot || s.get(row + 5) !== this.state.pid)
      return error("DENIED");
    const group = GROUPS + s.get(row + 2) * 16;
    if (s.get(group) !== s.get(row + 3) || s.get(group + 1) === RETIRED) return error("CANCELED");
    return s.get(group + 1) === RUNNING ? ok(undefined) : error("AGAIN");
  }
  ready(): TerminalResult<void> {
    for (;;) {
      const seen = this.session.get(H.wake);
      const denied = this.check();
      if (denied) return error(denied);
      const result = this.session.transact(this.state, () => this.startup());
      if (result.kind !== "error" || result.code !== "AGAIN") return result;
      assertTerminalWaitAllowed();
      atomicsWait(this.session.wake, 0, seen, 10);
    }
  }
  selected(state: ProcessState): boolean {
    if (this.context.memberSlot >= 0 && state.pid === this.state.pid) {
      const row = MEMBERS + this.context.memberSlot * 16;
      return this.matches(row, state) && this.session.get(row) === this.context.memberGeneration;
    }
    for (let slot = 0; slot < TERMINAL_SESSION_LIMITS.memberships; slot++)
      if (this.matches(MEMBERS + slot * 16, state)) return true;
    return false;
  }
  private matches(row: number, state: ProcessState): boolean {
    const s = this.session,
      group = s.get(H.selected) - 1;
    if (group < 0 || s.get(row + 1) !== BOUND || s.get(row + 2) !== group) return false;
    return (
      s.get(row + 3) === s.get(GROUPS + group * 16) &&
      s.get(row + 4) === state.slot &&
      s.get(row + 5) === state.pid
    );
  }
  resolve(target: TerminalTarget): Stream {
    return this.endpoint(target, this.state);
  }
  endpoint(target: TerminalTarget, state: ProcessState): Endpoint {
    if (target !== 0 && target !== 1 && target !== 2)
      throw new TypeError("invalid terminal target");
    if (this.disposed) throw new ProcessError(ProcessErrno.BADF, "terminal attachment disposed");
    if (mapSize(this.endpoints) >= TERMINAL_SESSION_LIMITS.wrappersPerAttachment)
      throw new ProcessError(ProcessErrno.AGAIN, "terminal wrapper capacity exceeded");
    const endpoint = new Endpoint(this, target, state);
    mapSet(this.endpoints, endpoint, true);
    return endpoint;
  }
  inherit(): TerminalContext {
    return context(this.session.identity);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    mapForEach(this.endpoints, (_present, endpoint) => endpoint.close());
    mapForEach(this.cursors, (_present, cursor) => cursor.dispose());
    this.session.notify();
  }
}
class Endpoint implements Stream {
  readonly kind = "terminal";
  readonly [controlKey]: Controls;
  private closed = false;
  constructor(
    readonly attachment: Attachment,
    readonly target: TerminalTarget,
    readonly state: ProcessState,
  ) {
    this[controlKey] = new Controls(this);
  }
  get notification(): Int32Array {
    return this.attachment.session.wake;
  }
  check(): TerminalFailure | undefined {
    this.attachment.checkActive();
    return this.closed ? "CANCELED" : this.attachment.check(this.state);
  }
  run<T>(callback: () => TerminalResult<T>): TerminalResult<T> {
    const denied = this.check();
    if (denied) return error(denied);
    return this.attachment.run(this.state, callback);
  }
  tryRead(chunks: readonly Uint8Array[]): number {
    const denied = this.check();
    if (denied === "CLOSED") return 0;
    if (denied) return errno(denied);
    if (!byteCapacity(chunks)) return 0;
    const result = this.run(() => this.readInput(chunks));
    return result.kind === "ok" ? result.value : result.code === "CLOSED" ? 0 : errno(result.code);
  }
  private readInput(chunks: readonly Uint8Array[]): TerminalResult<number> {
    const a = this.attachment;
    if (!a.selected(this.state)) return error("AGAIN");
    const count = a.session.turn((turn) => {
      if (!a.policy.inputReadiness(turn).readable) return -ProcessErrno.AGAIN;
      return a.policy.tryRead(turn, chunks);
    });
    if (!a.session.rootLive()) a.session.close();
    if (count >= 0) a.session.notify();
    return a.session.closed() ? error("CLOSED") : ok(count);
  }
  read(chunks: readonly Uint8Array[]): number {
    for (;;) {
      const seen = this.attachment.session.get(H.wake);
      if (signalPending(this.state.signals)) return -27;
      const result = this.tryRead(chunks);
      if (result !== -ProcessErrno.AGAIN) return result;
      assertTerminalWaitAllowed();
      atomicsWait(this.attachment.session.wake, 0, seen, 10);
    }
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    const denied = this.check();
    if (denied) return errno(denied);
    if (!byteCapacity(chunks)) return 0;
    if (this.target === 0) return -ProcessErrno.BADF;
    const target = this.target;
    let count: number;
    try {
      count = withTerminalPolicy(() => this.attachment.policy.tryWrite(target, chunks));
    } catch (cause) {
      this.attachment.session.close();
      throw cause;
    }
    this.attachment.session.notify();
    return this.check() ? -ProcessErrno.BADF : count;
  }
  write(chunks: readonly Uint8Array[]): number {
    for (;;) {
      const seen = this.attachment.session.get(H.wake);
      if (signalPending(this.state.signals)) return -27;
      const result = this.tryWrite(chunks);
      if (result !== -ProcessErrno.AGAIN) return result;
      assertTerminalWaitAllowed();
      atomicsWait(this.attachment.session.wake, 0, seen, 10);
    }
  }
  readiness(): Readiness {
    const denied = this.check();
    if (denied)
      return { readable: denied === "CLOSED", writable: false, hangup: denied === "CLOSED" };
    const result = this.run(() => {
      if (!this.attachment.selected(this.state)) return ok({ readable: false, nbytes: 0 });
      return ok(
        this.attachment.session.turn((turn) => this.attachment.policy.inputReadiness(turn)),
      );
    });
    const input =
      result.kind === "ok" ? result.value : { readable: result.code === "CLOSED", nbytes: 0 };
    return { ...input, writable: this.outputReady(), hangup: this.attachment.session.closed() };
  }
  private outputReady(): boolean {
    if (this.target === 0) return false;
    const target = this.target;
    try {
      return withTerminalPolicy(() => this.attachment.policy.outputReadiness(target).writable);
    } catch (cause) {
      this.attachment.session.close();
      throw cause;
    }
  }
  forProcess(pid: number): Stream {
    const denied = this.check();
    if (denied) throw new ProcessError(ProcessErrno.BADF, "terminal view is not active");
    const state = findProcess(this.attachment.session.identity, pid);
    if (!state || !live(state))
      throw new ProcessError(ProcessErrno.SRCH, "terminal child is not live");
    return this.attachment.endpoint(this.target, state);
  }
  registerWake(wake: Int32Array): (() => void) | undefined {
    const denied = this.check();
    if (denied) return;
    const common = this.attachment.session.commonWake;
    if (
      typedArrayBuffer(common) !== typedArrayBuffer(wake) ||
      typedArrayByteOffset(common) !== typedArrayByteOffset(wake) ||
      typedArrayLength(wake) !== 1
    )
      return;
    return () => {};
  }
  revoke(): void {
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    mapDelete(this.attachment.endpoints, this);
    mapForEach(this.attachment.cursors, (_present, cursor) => {
      if (cursor.endpoint === this) cursor.dispose();
    });
    this.attachment.session.notify();
  }
}
class Controls implements TerminalControls {
  constructor(private readonly endpoint: Endpoint) {}
  snapshot(): TerminalResult<TerminalSnapshot> {
    return this.endpoint.run(() => ok(this.endpoint.attachment.session.snapshot()));
  }
  setMode(options: {
    readonly expected: TerminalSelection | null;
    readonly mode: TerminalMode;
  }): TerminalResult<void> {
    const { expected, mode } = options;
    return this.endpoint.run(() => this.set({ expected, mode }));
  }
  private set(options: {
    readonly expected: TerminalSelection | null;
    readonly mode: TerminalMode;
  }): TerminalResult<void> {
    const a = this.endpoint.attachment,
      s = a.session;
    if (!a.selected(this.endpoint.state)) return error("DENIED");
    if (options.mode !== "raw" && options.mode !== "cooked") return error("INVALID");
    if (s.selection() !== options.expected) return error("STALE");
    if (mode(s.get(H.mode)) === options.mode) return ok(undefined);
    const next = s.next(H.modeRevision);
    if (next.kind === "error") return next;
    const changed = s.transition(a.policy, {
      kind: "mode",
      previous: mode(s.get(H.mode)),
      next: options.mode,
    });
    if (changed.kind === "error") return changed;
    try {
      const failure = this.endpoint.check();
      if (failure) {
        s.close();
        return error(failure);
      }
    } catch (cause) {
      s.close();
      throw cause;
    }
    s.put(H.mode, modeWord(options.mode));
    s.put(H.modeRevision, next.value);
    return ok(undefined);
  }
  subscribeGeometry(): TerminalResult<TerminalGeometrySubscription> {
    const denied = this.endpoint.check();
    if (denied) return error(denied);
    const a = this.endpoint.attachment;
    if (mapSize(a.cursors) >= TERMINAL_SESSION_LIMITS.geometrySubscriptionsPerAttachment)
      return error("CAPACITY");
    const cursor = new GeometryCursor(this.endpoint);
    mapSet(a.cursors, cursor, true);
    return ok(cursor);
  }
}
class GeometryCursor implements TerminalGeometrySubscription {
  private revision = 0;
  private disposed = false;
  private waiting = false;
  constructor(readonly endpoint: Endpoint) {}
  poll(): TerminalResult<TerminalGeometrySnapshot | null> {
    if (this.disposed) return error("CANCELED");
    return this.endpoint.run(() => {
      const geometry = this.endpoint.attachment.session.geometry();
      if (geometry.revision === this.revision) return ok(null);
      if (activeControl?.state === "executing")
        controlTurn(activeControl).publish(() => {
          this.revision = geometry.revision;
        });
      else this.revision = geometry.revision;
      return ok(geometry);
    });
  }
  async wait(): Promise<TerminalResult<TerminalGeometrySnapshot>> {
    if (this.waiting) return error("AGAIN");
    this.waiting = true;
    try {
      return await this.waitForGeometry();
    } finally {
      this.waiting = false;
    }
  }
  private async waitForGeometry(): Promise<TerminalResult<TerminalGeometrySnapshot>> {
    const s = this.endpoint.attachment.session;
    for (;;) {
      const seen = s.get(H.wake),
        result = this.poll();
      if (result.kind === "error" && result.code !== "AGAIN") return result;
      if (result.kind === "ok" && result.value !== null) return ok(result.value);
      await waitForChange(s, seen);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    mapDelete(this.endpoint.attachment.cursors, this);
    this.endpoint.attachment.session.notify();
  }
}
export function terminalControls(resource: Resource | undefined): TerminalControls | undefined {
  if (!resource || resource.kind !== "terminal") return;
  const controls = reflectGet(resource, controlKey);
  return isInstance(controls, Controls) ? controls : undefined;
}

/** Broker integration: finish runs after gate release in the same continuation. */
export function prepareTerminalDescendant<T>(options: {
  terminal: TerminalAuthority;
  root: WorkerProcessTransport;
  signal: AbortSignal;
  work(turn: TerminalControlTurn): TerminalResult<void>;
  finish(result: TerminalResult<void>): T;
  check(): TerminalFailure | undefined;
}): Promise<TerminalResult<T>> {
  if (!isInstance(options.terminal, Authority) || !options.terminal.matches(options.root))
    throw new ProcessError(
      ProcessErrno.NOTSUP,
      "terminal preparation must borrow its exact root authority",
    );
  return options.terminal.prepare(
    options.work,
    { signal: options.signal },
    options.finish,
    options.check,
  );
}
