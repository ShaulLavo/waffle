import { gpuPayloadLayout } from "../../../browser/display/generated/graphics-layout.js";
import { CompletionOwner } from "../../../browser/gpu/completions.js";
import { GpuService } from "../../../browser/gpu/service.js";
import { GpuReplay } from "../../../browser/gpu/replay.js";
import { GpuConnection, GpuScheduler } from "../../../browser/gpu/scheduler.js";
import { LogicalReader } from "../../../browser/gpu/transport.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { SurfaceConnection } from "../../../browser/gpu/surfaces.js";
import type { GpuServiceRequest } from "../../../browser/display/protocol.js";
import { installFairnessObserver } from "./fairness-observer.js";

type Open = Extract<GpuServiceRequest, { type: "open" }>;
type Mode =
  | "append"
  | "completions"
  | "header"
  | "chunk"
  | "nesting"
  | "admission"
  | "regrant"
  | "disposal";
interface Owner {
  readonly id: number;
  readonly open: Open;
  readonly connection: GpuConnection;
  reader: LogicalReader | undefined;
  surfaces: SurfaceConnection | undefined;
  readerReads: number;
  ringReads: number;
  chunkBytes: number;
  logicalBytes: number;
  heldReads: number;
  readerDisposed: boolean;
  device: number;
  created: number;
  destroyed: number;
  retiredAck: boolean;
  protocolReads: number;
  protocolReplays: number;
  peakHeap: number;
}
interface Command {
  readonly test: string;
  readonly id: string;
  readonly token?: string;
  readonly surface?: number;
  readonly mode?: Mode;
  readonly audit?: SharedArrayBuffer;
}
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: (event: MessageEvent<GpuServiceRequest | Command>) => void;
};
const fairness = installFairnessObserver();
const realm = crypto.randomUUID();
const owners: Owner[] = [];
interface OpenAttempt {
  readonly message: Open;
  readonly beforeConnections: number;
  readonly beforeHeap: number;
  readonly beforeNativeRequests: number;
  afterConnections: number;
  afterHeap: number;
  afterNativeRequests: number;
  retiredAck: boolean;
}
const attempts: OpenAttempt[] = [];
let holdNextOpen = false;
let pendingOpen: Open | undefined;
const rings = new WeakMap<RecordRing, Owner>();
const devices = new WeakMap<GPUDevice, Owner>();
const presenters = new WeakMap<object, number>();
let nextPresenter = 0;
const lifecycle: {
  kind: string;
  owner: number;
  grant: number;
  surface: number;
  device: number;
  presenter: number;
  at: number;
}[] = [];
function presenterId(value: object | undefined): number {
  if (!value) return 0;
  const existing = presenters.get(value);
  if (existing) return existing;
  const id = ++nextPresenter;
  presenters.set(value, id);
  return id;
}
function life(kind: string, owner: Owner, presenter = 0) {
  if (lifecycle.length >= 8192) throw new Error("Ownership lifecycle overflow");
  lifecycle.push({
    kind,
    owner: owner.id,
    grant: owner.open.grant,
    surface: owner.open.surfaces[0]!.id,
    device: owner.device,
    presenter,
    at: performance.now(),
  });
}
let scopeResult:
  | {
      owner: number;
      device: number;
      kind: "none" | "error";
      at: number;
      releasedAt: number | null;
    }
  | undefined;
let receiving: Open | undefined;
let active: Owner | undefined;
let serial = 0;
let nextDevice = 0;
let selection: { token: string; surface: number; mode: Mode } | undefined;
let enabled = false;
let held = false;
let released = false;
let nativeHeld = false;
let nativeReleased = false;
const gate = Promise.withResolvers<void>();
const disposalSettled = Promise.withResolvers<void>();
let disposalAudit: SharedArrayBuffer | undefined;
let heldCompletion: { owner: number; token: number } | undefined;
let lateCallback:
  | {
      owner: number;
      device: number;
      token: number;
      kind: "none" | "error";
      at: number;
    }
  | undefined;
const startCompletion = CompletionOwner.prototype.start;
CompletionOwner.prototype.start = function (token, start, settle, reject, abandon) {
  const owner = owners.find((owner) => owner.connection.completions === this);
  if (!enabled || selection?.mode !== "disposal" || !owner || !selected(owner))
    return Reflect.apply(startCompletion, this, [token, start, settle, reject, abandon]);
  if (heldCompletion) throw new Error("Repeated selected disposal completion");
  heldCompletion = { owner: owner.id, token };
  const observedAbandon = function (this: unknown, value: Parameters<typeof abandon>[0]) {
    const result = Reflect.apply(abandon, this, [value]);
    lateCallback = {
      owner: owner.id,
      device: owner.device,
      token,
      kind: value === null ? "none" : "error",
      at: performance.now(),
    };
    writeDisposalAudit(1, "late");
    disposalSettled.resolve();
    return result;
  };
  return Reflect.apply(startCompletion, this, [token, start, settle, reject, observedAbandon]);
};
/**
 * Scalar, append-only payload observations written by the real calls. Only a compilation
 * entry changes later, when its own native promise settles.
 */
interface PayloadSubject {
  readonly order: number;
  readonly owner: number;
  readonly grant: number;
  readonly connection: number;
  readonly device: number;
  readonly at: number;
}
const payloadLimit = 1024;
interface PayloadCompilation extends PayloadSubject {
  call: number;
  settled: "pending" | "fulfilled" | "rejected";
  settledAt: number | null;
  pending: number;
}
interface PayloadAllocation extends PayloadSubject {
  length: number;
  readyBefore: number;
  readyAfter: number;
  repliesUsedBefore: number;
  pendingBefore: number;
  outcome: "handle" | "refused" | "empty" | "threw";
  handle: number;
  generation: number;
  terminalReason: number;
  failure: string | null;
}
interface PayloadPublication extends PayloadSubject {
  token: number;
  status: number;
  handle: number;
  generation: number;
  length: number;
  published: boolean;
  repliesUsed: number;
}
interface PayloadTermination extends PayloadSubject {
  requested: number;
  terminalBefore: number;
  selected: number;
}
const payloadPressure: {
  compilations: PayloadCompilation[];
  allocations: PayloadAllocation[];
  publications: PayloadPublication[];
  terminations: PayloadTermination[];
  uncorrelatedCompilations: number;
  dropped: number;
} = {
  compilations: [],
  allocations: [],
  publications: [],
  terminations: [],
  uncorrelatedCompilations: 0,
  dropped: 0,
};
let payloadOrder = 0;
function payloadOwner(completions: CompletionOwner): Owner | undefined {
  return owners.find((owner) => owner.connection.completions === completions);
}
function payloadSubject(owner: Owner): PayloadSubject {
  return {
    order: ++payloadOrder,
    owner: owner.id,
    grant: owner.open.grant,
    connection: owner.open.open.id,
    device: owner.device,
    at: performance.now(),
  };
}
function payloadRecord<T>(list: T[], entry: T): void {
  const total =
    payloadPressure.compilations.length +
    payloadPressure.allocations.length +
    payloadPressure.publications.length +
    payloadPressure.terminations.length;
  if (total >= payloadLimit) payloadPressure.dropped++;
  else list.push(entry);
}
function readySlots(owner: Owner): number {
  const words = new BigInt64Array(
    owner.open.open.arena,
    gpuPayloadLayout.directoryOffset,
    (gpuPayloadLayout.slots * gpuPayloadLayout.slotBytes) / 8,
  );
  let ready = 0;
  for (let index = 0; index < gpuPayloadLayout.slots; index++) {
    const word = Atomics.load(words, (index * gpuPayloadLayout.slotBytes) / 8);
    if (Number(word & 0xffffffffn) === gpuPayloadLayout.ready) ready++;
  }
  return ready;
}
/** Selected reason of a termination the wrapped call itself caused, or zero. */
function terminatedSince(owner: Owner, before: number): number {
  const entry = payloadPressure.terminations.findLast(
    (candidate) => candidate.order > before && candidate.owner === owner.id,
  );
  return entry?.selected ?? 0;
}
function wireNumber(value: unknown, key: string): number {
  if (!value || typeof value !== "object") return 0;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "number" ? field : 0;
}
const terminateCompletion = CompletionOwner.prototype.terminate;
CompletionOwner.prototype.terminate = function (reason) {
  const owner = payloadOwner(this);
  // A plain atomic read; the state getter would synchronize before the real call.
  const terminalBefore = owner ? ringSnapshot(owner.open.open.commands).terminal : 0;
  const result = Reflect.apply(terminateCompletion, this, [reason]);
  if (!owner) return result;
  // The state getter does not synchronize once the owner is terminal.
  const state = this.state;
  payloadRecord(payloadPressure.terminations, {
    ...payloadSubject(owner),
    requested: reason,
    terminalBefore,
    selected: state.kind === "terminal" ? state.reason : 0,
  });
  return result;
};
const fillPayload = CompletionOwner.prototype.fillPayload;
CompletionOwner.prototype.fillPayload = function (length, fill) {
  const owner = payloadOwner(this);
  if (!owner) return Reflect.apply(fillPayload, this, [length, fill]);
  const readyBefore = readySlots(owner);
  const before = {
    order: payloadOrder,
    replies: ringSnapshot(owner.open.open.replies).used,
    pending: this.pendingCount,
  };
  let handle: ReturnType<typeof fillPayload>;
  try {
    handle = Reflect.apply(fillPayload, this, [length, fill]);
  } catch (error) {
    recordAllocation(this, owner, length, readyBefore, before, undefined, true);
    throw error;
  }
  recordAllocation(this, owner, length, readyBefore, before, handle, false);
  return handle;
};
function recordAllocation(
  completions: CompletionOwner,
  owner: Owner,
  length: number,
  readyBefore: number,
  before: { order: number; replies: number; pending: number },
  handle: ReturnType<typeof fillPayload>,
  threw: boolean,
) {
  const terminalReason = terminatedSince(owner, before.order);
  const outcome = threw ? "threw" : handle ? "handle" : terminalReason ? "refused" : "empty";
  payloadRecord(payloadPressure.allocations, {
    ...payloadSubject(owner),
    length,
    readyBefore,
    readyAfter: readySlots(owner),
    repliesUsedBefore: before.replies,
    pendingBefore: before.pending,
    outcome,
    handle: handle?.id ?? 0,
    generation: handle?.generation ?? 0,
    terminalReason,
    failure: outcome === "refused" || outcome === "threw" ? (completions.failure ?? null) : null,
  });
}
const publishCompletion = CompletionOwner.prototype.publish;
CompletionOwner.prototype.publish = function (name, token, status, value) {
  const published = Reflect.apply(publishCompletion, this, [name, token, status, value]);
  const owner = payloadOwner(this);
  if (!owner || name !== "compilation-result") return published;
  payloadRecord(payloadPressure.publications, {
    ...payloadSubject(owner),
    token,
    status,
    handle: wireNumber(value.payload, "id"),
    generation: wireNumber(value.payload, "generation"),
    length: wireNumber(value, "length"),
    published,
    repliesUsed: ringSnapshot(owner.open.open.replies).used,
  });
  return published;
};
const getCompilationInfo = globalThis.GPUShaderModule?.prototype.getCompilationInfo;
if (getCompilationInfo) {
  GPUShaderModule.prototype.getCompilationInfo = function () {
    const pending = Reflect.apply(getCompilationInfo, this, []);
    const owner = active;
    if (!owner) {
      payloadPressure.uncorrelatedCompilations++;
      return pending;
    }
    const entry: PayloadCompilation = {
      ...payloadSubject(owner),
      call: payloadPressure.compilations.filter((call) => call.owner === owner.id).length + 1,
      settled: "pending",
      settledAt: null,
      pending: owner.connection.completions.pendingCount,
    };
    payloadRecord(payloadPressure.compilations, entry);
    const settle = (kind: "fulfilled" | "rejected") => () => {
      entry.settled = kind;
      entry.settledAt = performance.now();
    };
    // Observes settlement without touching the native result; the original promise is returned.
    void pending.then(settle("fulfilled"), settle("rejected"));
    return pending;
  };
}
let malformedReleased = false;
let injection:
  | {
      owner: number;
      mode: Mode;
      read: number;
      offset: number;
      before: number;
      after: number;
    }
  | undefined;
let late: { reads: number; kind: string; reason: number } | undefined;
function malformed(): boolean {
  return (
    selection?.mode === "header" || selection?.mode === "chunk" || selection?.mode === "nesting"
  );
}
function selected(owner: Owner): boolean {
  return owner.open.surfaces.some((surface) => surface.id === selection?.surface);
}
function ownerFor(connection: GpuConnection): Owner {
  const owner = rings.get(connection.commands);
  if (!owner) throw new Error("Ownership connection observer missing");
  return owner;
}
const add = GpuScheduler.prototype.add;
GpuScheduler.prototype.add = function (connection) {
  if (!receiving) throw new Error("Ownership open correlation missing");
  const owner: Owner = {
    id: fairness.trace(connection.replay).id,
    open: receiving,
    connection,
    reader: undefined,
    surfaces: undefined,
    readerReads: 0,
    ringReads: 0,
    chunkBytes: 0,
    logicalBytes: 0,
    heldReads: 0,
    readerDisposed: false,
    device: 0,
    created: 0,
    destroyed: 0,
    retiredAck: false,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: 0,
  };
  owners.push(owner);
  rings.set(connection.commands, owner);
  return add.call(this, connection);
};
const slice = GpuConnection.prototype.slice;
GpuConnection.prototype.slice = function (budget) {
  active = ownerFor(this);
  try {
    return slice.call(this, budget);
  } finally {
    active = undefined;
  }
};
const read = LogicalReader.prototype.read;
LogicalReader.prototype.read = function () {
  const owner = rings.get(this.ring);
  if (!owner) throw new Error("Ownership reader correlation missing");
  owner.reader = this;
  owner.readerReads++;
  if (enabled && malformed() && selected(owner) && !malformedReleased) {
    owner.heldReads++;
    held = true;
    this.lastReadBytes = 0;
    return { kind: "empty" };
  }
  if (enabled && selection?.mode === "append" && selected(owner) && this.assembling && !released) {
    owner.heldReads++;
    held = true;
    this.lastReadBytes = 0;
    return { kind: "empty" };
  }
  const result = read.call(this);
  owner.peakHeap = Math.max(owner.peakHeap, this.credit.used);
  if (result.kind === "terminal" && result.reason === 2) owner.protocolReads++;
  return result;
};
const readInto = RecordRing.prototype.readInto;
RecordRing.prototype.readInto = function (destination) {
  const result = readInto.call(this, destination);
  const owner = rings.get(this);
  if (owner && result.kind === "record") {
    owner.ringReads++;
    const view = new DataView(destination.buffer, destination.byteOffset, result.bytes);
    if (view.getUint16(0, true) === 0x1004) {
      owner.chunkBytes = result.bytes;
      owner.logicalBytes = view.getUint32(8, true);
      corrupt(owner, view);
    }
  }
  return result;
};
function corrupt(owner: Owner, view: DataView) {
  if (!enabled || !malformedReleased || !malformed() || !selected(owner) || injection) return;
  const chunkOffset = view.getUint32(12, true);
  const mode = selection!.mode;
  if (mode === "chunk" && chunkOffset === 0) return;
  const offset = mode === "header" ? 0 : mode === "chunk" ? 12 : 44;
  const before = view.getUint32(offset, true);
  const after = mode === "header" ? 0xffff0001 : mode === "chunk" ? chunkOffset + 8 : 0x1001;
  view.setUint32(offset, after, true);
  injection = {
    owner: owner.id,
    mode,
    read: owner.ringReads,
    offset,
    before,
    after,
  };
}
const disposeReader = LogicalReader.prototype.dispose;
LogicalReader.prototype.dispose = function () {
  const result = disposeReader.call(this);
  const owner = rings.get(this.ring);
  if (owner) owner.readerDisposed = true;
  return result;
};
const configure = SurfaceConnection.prototype.configure;
SurfaceConnection.prototype.configure = function (surface, descriptor) {
  const result = configure.call(this, surface, descriptor);
  const owner = owners.find((entry) => entry.connection.completions === this.completions);
  if (!owner) throw new Error("Ownership surface observer missing");
  owner.surfaces = this;
  life("configure", owner, presenterId(this.visible.get(owner.open.surfaces[0]!.id)?.presenter));
  return result;
};
function releasedPresenter(connection: SurfaceConnection, release: () => void) {
  const owner = owners.find((entry) => entry.connection.completions === connection.completions);
  const visible = owner ? connection.visible.get(owner.open.surfaces[0]!.id) : undefined;
  const presenter = visible?.presenter;
  const result = release();
  if (!owner || !presenter || presenter.owner !== connection) return result;
  if (visible?.presenter === presenter)
    throw new Error("Ownership presenter release did not occur");
  life("release", owner, presenterId(presenter));
  return result;
}
const unconfigure = SurfaceConnection.prototype.unconfigure;
SurfaceConnection.prototype.unconfigure = function (surface) {
  return releasedPresenter(this, () => unconfigure.call(this, surface));
};
const disposeSurfaces = SurfaceConnection.prototype.dispose;
SurfaceConnection.prototype.dispose = function () {
  return releasedPresenter(this, () => disposeSurfaces.call(this));
};
const popScope = globalThis.GPUDevice?.prototype.popErrorScope;
if (popScope) {
  GPUDevice.prototype.popErrorScope = function () {
    const owner = devices.get(this);
    const pending = popScope.call(this);
    if (
      !owner ||
      !enabled ||
      (selection?.mode !== "regrant" && selection?.mode !== "disposal") ||
      !selected(owner) ||
      held
    )
      return pending;
    held = true;
    return pending.then(async (result) => {
      scopeResult = {
        owner: owner.id,
        device: owner.device,
        kind: result === null ? "none" : "error",
        at: performance.now(),
        releasedAt: null,
      };
      nativeHeld = true;
      await gate.promise;
      scopeResult.releasedAt = performance.now();
      nativeHeld = false;
      nativeReleased = true;
      return result;
    });
  };
}
const replayStep = GpuReplay.prototype.step;
GpuReplay.prototype.step = function () {
  const result = replayStep.call(this);
  if (
    active &&
    result.kind === "terminal" &&
    active.connection.state.kind === "terminal" &&
    active.connection.state.reason === 2
  )
    active.protocolReplays++;
  return result;
};
const requestDevice = globalThis.GPUAdapter?.prototype.requestDevice;
let nativeRequests = 0;
if (requestDevice) {
  GPUAdapter.prototype.requestDevice = function (descriptor) {
    const owner = active;
    if (!owner) throw new Error("Ownership native device correlation missing");
    nativeRequests++;
    const pending = requestDevice.call(this, descriptor);
    const remember = (device: GPUDevice) => {
      owner.device = ++nextDevice;
      owner.created++;
      devices.set(device, owner);
      return device;
    };
    if (!enabled || selection?.mode !== "completions" || !selected(owner)) {
      void pending.then(remember, () => {});
      return pending;
    }
    return pending.then(async (device) => {
      remember(device);
      held = nativeHeld = true;
      await gate.promise;
      nativeHeld = false;
      nativeReleased = true;
      return device;
    });
  };
}
const destroy = globalThis.GPUDevice?.prototype.destroy;
if (destroy) {
  GPUDevice.prototype.destroy = function () {
    const result = destroy.call(this);
    const owner = devices.get(this);
    if (owner) owner.destroyed++;
    return result;
  };
}
const service = new GpuService((message) => {
  if (message.type === "retired") {
    for (const owner of owners)
      if (owner.open.grant === message.grant) {
        owner.retiredAck = true;
        life("retired", owner);
      }
    for (const attempt of attempts)
      if (attempt.message.grant === message.grant) attempt.retiredAck = true;
  }
  if (
    message.type === "retired" &&
    selection?.mode === "disposal" &&
    owners.some((owner) => selected(owner) && owner.open.grant === message.grant)
  ) {
    void disposalSettled.promise.then(() => host.postMessage(message));
    return;
  }
  host.postMessage(message);
});
function ringSnapshot(backing: SharedArrayBuffer) {
  const publication = Atomics.load(new BigInt64Array(backing, 0, 1), 0);
  const cells = new Int32Array(backing, 0, 16);
  const head = Number(publication & 0xffffffffn);
  const tail = Atomics.load(cells, 2) >>> 0;
  return {
    capacity: backing.byteLength - 64,
    head,
    tail,
    used: (head - tail) >>> 0,
    writer: Atomics.load(cells, 3),
    terminal: Number((publication >> 32n) & 0xffffffffn),
  };
}
function ownerSnapshot(owner: Owner) {
  const connection = owner.connection;
  const visible = owner.surfaces?.visible.get(owner.open.surfaces[0]!.id);
  const presenter = visible?.presenter?.owner === owner.surfaces ? visible?.presenter : undefined;
  return {
    id: owner.id,
    grant: owner.open.grant,
    surface: owner.open.surfaces[0]!.id,
    device: owner.device,
    state: connection.state.kind,
    devices: connection.replay.devicesLive,
    created: owner.created,
    destroyed: owner.destroyed,
    readerReads: owner.readerReads,
    ringReads: owner.ringReads,
    chunkBytes: owner.chunkBytes,
    logicalBytes: owner.logicalBytes,
    readerDisposed: owner.readerDisposed,
    protocolReads: owner.protocolReads,
    protocolReplays: owner.protocolReplays,
    peakHeap: owner.peakHeap,
    terminalReason: connection.state.kind === "terminal" ? connection.state.reason : 0,
    partial: owner.reader?.assembling ?? false,
    heldReads: owner.heldReads,
    pending: connection.completions.pendingCount,
    payloadBytes: connection.completions.payloadBytes,
    payloadReadySlots: readySlots(owner),
    replayBusy: connection.replay.busy,
    presenter: presenter !== undefined,
    presenterId: presenterId(presenter),
    presenterDevice: presenter ? (devices.get(presenter.device)?.device ?? 0) : 0,
    frame: presenter?.frame !== undefined,
    retiredAck: owner.retiredAck,
    commands: ringSnapshot(owner.open.open.commands),
    replies: ringSnapshot(owner.open.open.replies),
  };
}
function attemptSnapshot(attempt: OpenAttempt) {
  const { message } = attempt;
  const control = new Int32Array(message.open.control);
  const admitted = owners.find((owner) => owner.open === message);
  return {
    grant: message.grant,
    surface: message.surfaces[0]!.id,
    connection: message.open.id,
    owner: admitted?.id ?? null,
    status: Atomics.load(control, 0),
    reason: Atomics.load(control, 1),
    arenaTerminal: Atomics.load(
      new Int32Array(message.open.arena, gpuPayloadLayout.terminalOffset, 1),
      0,
    ),
    commands: ringSnapshot(message.open.commands),
    replies: ringSnapshot(message.open.replies),
    retiredAck: attempt.retiredAck,
    beforeConnections: attempt.beforeConnections,
    afterConnections: attempt.afterConnections,
    beforeHeap: attempt.beforeHeap,
    afterHeap: attempt.afterHeap,
    beforeNativeRequests: attempt.beforeNativeRequests,
    afterNativeRequests: attempt.afterNativeRequests,
  };
}
function snapshot(responseId: string) {
  return {
    ...service.snapshot(),
    realm,
    serial: ++serial,
    responseId,
    at: performance.now(),
    token: selection?.token,
    mode: selection?.mode,
    armed: enabled,
    held,
    released,
    nativeHeld,
    nativeReleased,
    malformedReleased,
    injection,
    late,
    owners: owners.map(ownerSnapshot),
    attempts: attempts.map(attemptSnapshot),
    nativeRequests,
    fairness: fairness.snapshot(),
    lifecycle: lifecycle.slice(),
    scopeResult,
    lateCallback,
    heldCompletion,
    payloadPressure: {
      compilations: payloadPressure.compilations.slice(),
      allocations: payloadPressure.allocations.slice(),
      publications: payloadPressure.publications.slice(),
      terminations: payloadPressure.terminations.slice(),
      uncorrelatedCompilations: payloadPressure.uncorrelatedCompilations,
      dropped: payloadPressure.dropped,
    },
    pendingOpen: pendingOpen
      ? {
          grant: pendingOpen.grant,
          surface: pendingOpen.surfaces[0]!.id,
          connection: pendingOpen.open.id,
        }
      : null,
  };
}
function coverage() {
  const observed = fairness.snapshot();
  const native = Object.fromEntries(
    ["draw", "finish", "submit", "transferToImageBitmap", "transferFromImageBitmap"].map((name) => [
      name,
      Object.entries(observed.native)
        .filter(([key]) => key.endsWith(`:${name}`))
        .reduce((sum, [, value]) => sum + value.count, 0),
    ]),
  );
  return {
    readerReads: owners.reduce((sum, owner) => sum + owner.readerReads, 0),
    ringReads: owners.reduce((sum, owner) => sum + owner.ringReads, 0),
    disposed: owners.filter((owner) => owner.readerDisposed && owner.retiredAck).length,
    destroyed: owners.reduce((sum, owner) => sum + owner.destroyed, 0),
    nativeRequests,
    presents: observed.presents.length,
    native,
  };
}
function arm(data: Command) {
  if (!data.token || !Number.isSafeInteger(data.surface) || !data.surface || !data.mode)
    throw new Error("Ownership selection missing");
  if (enabled) throw new Error("Ownership selection already armed");
  const observed = coverage();
  const { native, ...counts } = observed;
  if (Object.values(counts).some((count) => count <= 0))
    throw new Error("Ownership observer positive coverage missing in this service");
  if (Object.values(native).some((count) => count <= 0))
    throw new Error("Ownership native observer positive coverage missing in this service");
  selection = { token: data.token, surface: data.surface, mode: data.mode };
  if (malformed() || data.mode === "regrant" || data.mode === "disposal") {
    const victim = owners.find(selected);
    if (
      !victim ||
      victim.readerReads < 1 ||
      victim.ringReads < 1 ||
      victim.created !== 1 ||
      victim.connection.state.kind !== "ready" ||
      !victim.surfaces
    )
      throw new Error("Malformed victim observer positive coverage missing");
  }
  if (data.mode === "disposal") {
    if (!(data.audit instanceof SharedArrayBuffer) || data.audit.byteLength !== 2 * 1024 * 1024)
      throw new Error("Disposal audit backing missing");
    disposalAudit = data.audit;
    writeDisposalAudit(0, "armed");
  }
  enabled = true;
  return observed;
}
function command(data: Command) {
  try {
    if (data.test === "admission-coverage") {
      const observed = coverage();
      host.postMessage({
        testId: data.id,
        gpuSnapshot: { ...snapshot(data.id), coverage: observed },
      });
      return;
    }
    if (data.test === "ownership-observe") {
      if (!data.token || !data.surface || !data.mode || selection)
        throw new Error("Ownership correlation missing or repeated");
      selection = { token: data.token, surface: data.surface, mode: data.mode };
    }
    if (data.test === "ownership-arm") {
      const coverage = arm(data);
      host.postMessage({
        testId: data.id,
        gpuSnapshot: { ...snapshot(data.id), coverage },
      });
      return;
    }
    if (data.test === "malformed-release") malformedReleased = true;
    if (data.test === "malformed-late") {
      const victim = owners.find(selected);
      if (!victim?.reader || victim.connection.state.kind !== "terminal")
        throw new Error("Malformed late probe needs the original retired reader");
      const before = victim.ringReads;
      const result = victim.reader.read();
      victim.connection.replay.step();
      late = {
        reads: victim.ringReads - before,
        kind: result.kind,
        reason: result.kind === "terminal" ? result.reason : 0,
      };
    }
    if (data.test === "ownership-release") {
      released = true;
      gate.resolve();
    }
    host.postMessage({ testId: data.id, gpuSnapshot: snapshot(data.id) });
  } catch (error) {
    host.postMessage({
      testId: data.id,
      gpuSnapshot: { observerError: String(error) },
    });
  }
}
host.onmessage = ({ data }) => {
  if ("test" in data && data.test === "service-failure")
    throw new Error(`GPU_SERVICE_FAILURE ${data.id}`);
  if ("test" in data && data.test === "service-hold-open") {
    holdNextOpen = true;
    host.postMessage({ testId: data.id, gpuSnapshot: snapshot(data.id) });
    return;
  }
  if (!("test" in data) && data.type === "open" && holdNextOpen) {
    if (pendingOpen) throw new Error("Repeated held service open");
    pendingOpen = data;
    return;
  }
  if ("test" in data) {
    command(data);
    return;
  }
  receiving = data.type === "open" ? data : undefined;
  const before = receiving ? service.snapshot() : undefined;
  const attempt: OpenAttempt | undefined =
    receiving && before
      ? {
          message: receiving,
          beforeConnections: before.connections,
          beforeHeap: before.heapBytes,
          beforeNativeRequests: nativeRequests,
          afterConnections: 0,
          afterHeap: 0,
          afterNativeRequests: 0,
          retiredAck: false,
        }
      : undefined;
  if (attempt) attempts.push(attempt);
  try {
    service.receive(data);
    observeDisposalRetirement(data);
    if (attempt) {
      const after = service.snapshot();
      attempt.afterConnections = after.connections;
      attempt.afterHeap = after.heapBytes;
      attempt.afterNativeRequests = nativeRequests;
    }
  } finally {
    receiving = undefined;
  }
};

function writeDisposalAudit(slot: number, name: string) {
  if (!disposalAudit) throw new Error("Missing armed disposal audit");
  const bytes = new TextEncoder().encode(
    JSON.stringify({ name, service: snapshot(`disposal-${name}`) }),
  );
  if (bytes.length > 1048572) throw new Error("Disposal audit overflow");
  new Uint8Array(disposalAudit, slot * 1048576 + 4, bytes.length).set(bytes);
  Atomics.store(new Int32Array(disposalAudit, slot * 1048576, 1), 0, bytes.length);
}

function observeDisposalRetirement(message: GpuServiceRequest) {
  if (message.type !== "revoke" || selection?.mode !== "disposal") return;
  if (!owners.some((owner) => selected(owner) && owner.open.grant === message.grant)) return;
  writeDisposalAudit(0, "retired");
  released = true;
  gate.resolve();
}
