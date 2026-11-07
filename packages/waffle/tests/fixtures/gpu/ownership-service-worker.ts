import { GpuService } from "../../../browser/gpu/service.js";
import { GpuReplay } from "../../../browser/gpu/replay.js";
import { GpuConnection, GpuScheduler } from "../../../browser/gpu/scheduler.js";
import { LogicalReader } from "../../../browser/gpu/transport.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { SurfaceConnection } from "../../../browser/gpu/surfaces.js";
import type { GpuServiceRequest } from "../../../browser/display/protocol.js";
import { installFairnessObserver } from "./fairness-observer.js";

type Open = Extract<GpuServiceRequest, { type: "open" }>;
type Mode = "append" | "completions" | "header" | "chunk" | "nesting";
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
}
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: (event: MessageEvent<GpuServiceRequest | Command>) => void;
};
const fairness = installFairnessObserver();
const realm = crypto.randomUUID();
const owners: Owner[] = [];
const rings = new WeakMap<RecordRing, Owner>();
const devices = new WeakMap<GPUDevice, Owner>();
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
let malformedReleased = false;
let injection:
  | { owner: number; mode: Mode; read: number; offset: number; before: number; after: number }
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
  injection = { owner: owner.id, mode, read: owner.ringReads, offset, before, after };
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
  return result;
};
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
    for (const owner of owners) if (owner.open.grant === message.grant) owner.retiredAck = true;
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
    replayBusy: connection.replay.busy,
    presenter: presenter !== undefined,
    frame: presenter?.frame !== undefined,
    retiredAck: owner.retiredAck,
    commands: ringSnapshot(owner.open.open.commands),
    replies: ringSnapshot(owner.open.open.replies),
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
    fairness: fairness.snapshot(),
  };
}
function arm(data: Command) {
  if (!data.token || !Number.isSafeInteger(data.surface) || !data.surface || !data.mode)
    throw new Error("Ownership selection missing");
  if (enabled) throw new Error("Ownership selection already armed");
  const observed = fairness.snapshot();
  const native = Object.fromEntries(
    ["draw", "finish", "submit", "transferToImageBitmap", "transferFromImageBitmap"].map((name) => [
      name,
      Object.entries(observed.native)
        .filter(([key]) => key.endsWith(`:${name}`))
        .reduce((sum, [, value]) => sum + value.count, 0),
    ]),
  );
  const coverage = {
    readerReads: owners.reduce((sum, owner) => sum + owner.readerReads, 0),
    ringReads: owners.reduce((sum, owner) => sum + owner.ringReads, 0),
    disposed: owners.filter((owner) => owner.readerDisposed && owner.retiredAck).length,
    destroyed: owners.reduce((sum, owner) => sum + owner.destroyed, 0),
    nativeRequests,
    presents: observed.presents.length,
  };
  if (Object.values(coverage).some((count) => count <= 0))
    throw new Error("Ownership observer positive coverage missing in this service");
  if (Object.values(native).some((count) => count <= 0))
    throw new Error("Ownership native observer positive coverage missing in this service");
  selection = { token: data.token, surface: data.surface, mode: data.mode };
  if (malformed()) {
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
  enabled = true;
  return { ...coverage, native };
}
function command(data: Command) {
  try {
    if (data.test === "ownership-observe") {
      if (!data.token || !data.surface || !data.mode || selection)
        throw new Error("Ownership correlation missing or repeated");
      selection = { token: data.token, surface: data.surface, mode: data.mode };
    }
    if (data.test === "ownership-arm") {
      const coverage = arm(data);
      host.postMessage({ testId: data.id, gpuSnapshot: { ...snapshot(data.id), coverage } });
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
    host.postMessage({ testId: data.id, gpuSnapshot: { observerError: String(error) } });
  }
}
host.onmessage = ({ data }) => {
  if ("test" in data) {
    command(data);
    return;
  }
  receiving = data.type === "open" ? data : undefined;
  try {
    service.receive(data);
  } finally {
    receiving = undefined;
  }
};
