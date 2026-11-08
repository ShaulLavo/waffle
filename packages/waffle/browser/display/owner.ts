import { graphicsLaunchRetention } from "./launch-retention.js";
import {
  createServiceReaders,
  type ServiceReaderFence,
  type JoinedServiceReaders,
} from "./service-readers.js";
import type { GpuServiceRequest, GpuServiceReply, ServiceSurface } from "./service-protocol.js";
import { validGraphicsOpen } from "./open.js";
import { allocateSharedControl } from "../../memory/control.js";
import type { GraphicsConnection, GraphicsGrant, GraphicsOpen } from "./protocol.js";

export interface DisplaySurface {
  readonly id: number;
  dispose(): void;
}
export interface RuntimeDisplay {
  createSurface(canvas: HTMLCanvasElement): DisplaySurface;
  grant(options: {
    readonly surfaces: readonly DisplaySurface[];
    readonly gpu: boolean;
  }): GraphicsGrant;
}
type GrantId = number & { readonly __brand: "GraphicsGrantId" };
type ServiceIncarnation = number & { readonly __brand: "GpuServiceIncarnation" };

interface SurfaceOwner {
  readonly surface: DisplaySurface;
  readonly element: HTMLCanvasElement;
  readonly info: SharedArrayBuffer;
  holder: GrantId | undefined;
  state: "local" | "transferred" | "lost" | "disposed";
}
interface GrantOwner {
  binding: ServiceOwner | undefined;
  readonly id: GrantId;
  readonly port: MessagePort;
  readonly revocation: Int32Array;
  readonly surfaces: readonly SurfaceOwner[];
  readonly opens: Map<number, GraphicsOpen>;
  state: "live" | "revoking" | "retired";
  readonly retire: () => void;
  readonly retired: Promise<void>;
}
interface ServiceRetirement {
  readonly readers: Promise<JoinedServiceReaders>;
  readonly settled: Promise<void>;
}
interface ServiceOwner {
  worker: Worker | undefined;
  readonly constructed: Promise<Worker | undefined>;
  readonly incarnation: ServiceIncarnation;
  readonly readers: ServiceReaderFence;
  readonly exposed: Map<GrantOwner, Set<GraphicsOpen>>;
  retirement: ServiceRetirement | undefined;
  readonly retirementStarted: Promise<ServiceRetirement>;
  readonly beginRetirement: (retirement: ServiceRetirement) => void;
  phase: "starting" | "live" | "closing" | "joined" | "retained";
}
// Reader join is not alias-release evidence. Keep original wrappers through page destruction.
const retainedServices = new Set<ServiceOwner>();
const retainedGrants = new Set<GrantOwner>();
const ownedWorkers = new WeakSet<Worker>();

export interface DisplayOwnerOptions {
  readonly workerUrl?: string | URL;
  readonly worker?: () => Worker;
  readonly commandBytes?: number;
  readonly completionBytes?: number;
}
/** Page-only owner. Constructing it, surfaces or grants never loads a GPU implementation. */
export function createDisplayOwner(checkLive: () => void, options: DisplayOwnerOptions = {}) {
  const commandBytes = ringSize(options.commandBytes ?? 4 * 1024 * 1024);
  const completionBytes = ringSize(options.completionBytes ?? 256 * 1024);
  const surfaces = new Map<number, SurfaceOwner>();
  const grants = new Map<number, GrantOwner>();
  let nextSurface = 1,
    nextGrant = 1,
    incarnation = 0;
  let service: ServiceOwner | undefined;
  let disposed = false;
  let frame: number | undefined;
  let disposal: Promise<void> | undefined;
  let retained = false;
  const assertLive = () => {
    checkLive();
    if (disposed) throw new Error("Display disposed");
  };
  const post = (message: GpuServiceRequest, transfer: Transferable[] = []) =>
    liveService().worker.postMessage(message, transfer);
  const liveService = () => {
    if (!service || service.phase !== "live" || !boundService(service))
      throw new Error("GPU service retirement pending");
    return service;
  };
  const finish = (grant: GrantOwner) => {
    if (grant.state === "retired") return;
    grant.state = "retired";
    Atomics.store(grant.revocation, 0, 1);
    Atomics.notify(grant.revocation, 0);
    for (const surface of grant.surfaces)
      if (surface.holder === grant.id) surface.holder = undefined;
    grant.port.close();
    grant.opens.clear();
    grants.delete(grant.id);
    grant.retire();
  };
  const retireService = (owner: ServiceOwner) => {
    if (owner.retirement) return owner.retirement;
    owner.phase = "closing";
    const closed = owner.readers.close();
    let begin!: () => void, fail!: (error: unknown) => void;
    const logical = new Promise<void>((resolve, reject) => {
      begin = resolve;
      fail = reject;
    });
    const readers = logical.then(() => joinServiceReaders(owner, closed, finish));
    const settled = readers
      .then(async () => {
        const worker = await owner.constructed;
        await worker?.terminate();
        if (!worker) retainedServices.delete(owner);
        if (service === owner) service = undefined;
      })
      .catch((error: unknown) => {
        owner.phase = "retained";
        retained = true;
        throw error;
      });
    owner.retirement = { readers, settled };
    owner.beginRetirement(owner.retirement);
    void settled.catch(() => {});
    try {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      for (const surface of surfaces.values())
        if (surface.state === "transferred") surface.state = "lost";
      for (const [grant, opens] of owner.exposed) revokeExposed(grant, opens);
      begin();
    } catch (error) {
      fail(error);
    }
    return owner.retirement;
  };
  const failService = (owner: ServiceOwner) => {
    retireService(owner);
  };
  const tick = () => {
    frame = undefined;
    if (!service || disposed) return;
    try {
      post({ type: "tick" });
    } catch {
      failService(service);
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  const activate = (): ServiceOwner => {
    if (service) return liveService();
    assertLive();
    const readers = createServiceReaders();
    let constructed!: (worker: Worker | undefined) => void;
    let beginRetirement!: (retirement: ServiceRetirement) => void;
    const retirementStarted = new Promise<ServiceRetirement>((resolve) => {
      beginRetirement = resolve;
    });
    const owner: ServiceOwner = {
      worker: undefined,
      constructed: new Promise<Worker | undefined>((resolve) => {
        constructed = resolve;
      }),
      readers,
      incarnation: serviceIncarnation(++incarnation),
      exposed: new Map(),
      phase: "starting",
      retirement: undefined,
      retirementStarted,
      beginRetirement,
    };
    retainedServices.add(owner);
    service = owner;
    let worker: Worker;
    try {
      worker = createGpuWorker(options);
      if (ownedWorkers.has(worker)) throw new Error("GPU Worker already owned");
      ownedWorkers.add(worker);
      owner.worker = worker;
      constructed(worker);
      assertLive();
      if (owner.retirement) throw new Error("GPU service retired during construction");
      owner.phase = "live";
    } catch (error) {
      constructed(undefined);
      failService(owner);
      throw error;
    }
    worker.onerror = () => failService(owner);
    worker.onmessageerror = () => failService(owner);
    worker.onmessage = ({ data }: MessageEvent<GpuServiceReply>) => {
      if (service !== owner || owner.phase !== "live") return;
      const grant = grants.get(data.grant);
      if (!grant || grant.binding !== owner) return;
      if (data.type === "retirement-failed") failService(owner);
      else if (data.type === "retired" && grant.state === "revoking") finish(grant);
      else if (data.type === "closed") grant.opens.delete(data.id);
    };
    try {
      liveService();
      worker.postMessage({
        type: "bootstrap",
        readers: readers.bootstrap,
        incarnation: owner.incarnation,
      });
    } catch (error) {
      failService(owner);
      throw error;
    }
    assertLive();
    liveService();
    frame = requestAnimationFrame(tick);
    return owner;
  };
  const attach = (grant: GrantOwner, open: GraphicsOpen) => {
    // Publish ownership before worker construction or any transfer can fail.
    grant.opens.set(open.id, open);
    try {
      assertLive();
      if (grant.state !== "live") throw new Error("Revoked grant");
      const owner = activate();
      if (grant.binding && grant.binding !== owner)
        throw new Error("GPU grant belongs to retired service");
      grant.binding = owner;
      let exposure = owner.exposed.get(grant);
      if (!exposure) owner.exposed.set(grant, (exposure = new Set()));
      exposure.add(open);
      const transfer: Transferable[] = [];
      const attached: ServiceSurface[] = grant.surfaces.map((surface) => {
        if (surface.state === "lost" || surface.state === "disposed")
          throw new Error("Surface lost");
        if (surface.state === "transferred") return { id: surface.surface.id };
        const canvas = surface.element.transferControlToOffscreen();
        surface.state = "transferred";
        transfer.push(canvas);
        return { id: surface.surface.id, canvas };
      });
      post({ type: "open", grant: grant.id, open, surfaces: attached }, transfer);
    } catch {
      settleOpen(open, -64, 5);
      if (service) failService(service);
      if (!grant.binding) finish(grant);
    }
  };
  const revoke = (grant: GrantOwner) => {
    if (grant.state !== "live") return;
    grant.state = "revoking";
    Atomics.store(grant.revocation, 0, 1);
    Atomics.notify(grant.revocation, 0);
    for (const open of grant.opens.values()) settleOpen(open, -64, 4);
    for (const surface of grant.surfaces)
      if (surface.holder === grant.id) surface.holder = undefined;
    if (!grant.binding) {
      finish(grant);
      return;
    }
    try {
      if (grant.binding.phase !== "live" || !boundService(grant.binding)) return;
      grant.binding.worker.postMessage({ type: "revoke", grant: grant.id });
    } catch {
      failService(grant.binding);
    }
  };
  const refresh = (surface: SurfaceOwner) => {
    if (surface.state === "disposed") return;
    const cells = new Int32Array(surface.info);
    Atomics.add(cells, 0, 1);
    Atomics.store(cells, 1, surface.element.width);
    Atomics.store(cells, 2, surface.element.height);
    Atomics.store(cells, 3, Math.round(globalThis.devicePixelRatio * 1000) || 1000);
    Atomics.store(
      cells,
      4,
      (document.visibilityState === "visible" ? 1 : 0) | (document.hasFocus() ? 2 : 0),
    );
    Atomics.add(cells, 0, 1);
  };
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          for (const surface of surfaces.values()) refresh(surface);
        })
      : undefined;
  const visibility = () => {
    for (const surface of surfaces.values()) refresh(surface);
  };
  globalThis.addEventListener?.("resize", visibility);
  globalThis.addEventListener?.("focus", visibility);
  globalThis.addEventListener?.("blur", visibility);
  globalThis.document?.addEventListener("visibilitychange", visibility);
  const display: RuntimeDisplay = Object.freeze({
    createSurface(element: HTMLCanvasElement): DisplaySurface {
      assertLive();
      if (surfaces.size >= 16) throw new RangeError("Display surface limit");
      for (const owned of surfaces.values())
        if (owned.element === element) throw new Error("Canvas already owned");
      if (nextSurface > 0xffffffff) throw new RangeError("Surface identities exhausted");
      const id = nextSurface++;
      const surface: DisplaySurface = Object.freeze({
        id,
        dispose() {
          if (owned.state === "disposed") return;
          if (owned.holder !== undefined) {
            const grant = grants.get(owned.holder);
            if (grant) revoke(grant);
          }
          owned.state = "disposed";
          observer?.unobserve(element);
          surfaces.delete(id);
          if (service) {
            try {
              post({ type: "surface-dispose", id });
            } catch {
              failService(service);
            }
          }
        },
      });
      const owned: SurfaceOwner = {
        surface,
        element,
        info: allocateSharedControl(64),
        holder: undefined,
        state: "local",
      };
      surfaces.set(id, owned);
      refresh(owned);
      observer?.observe(element);
      return surface;
    },
    grant(configuration: Parameters<RuntimeDisplay["grant"]>[0]): GraphicsGrant {
      assertLive();
      const gpu = configuration.gpu;
      if (typeof gpu !== "boolean") throw new TypeError("GPU grant must be explicit");
      const selected = configuration.surfaces.map((surface) => {
        const owner = surfaces.get(surface.id);
        if (
          !owner ||
          owner.surface !== surface ||
          owner.state === "lost" ||
          owner.holder !== undefined
        )
          throw new Error("Surface unavailable");
        return owner;
      });
      if (new Set(selected).size !== selected.length) throw new Error("Duplicate surface");
      const id = grantId(nextGrant++);
      const revocation = allocateSharedControl(64);
      const channel = new MessageChannel();
      let retire!: () => void;
      const retired = new Promise<void>((resolve) => {
        retire = resolve;
      });
      const grant: GrantOwner = {
        id,
        binding: undefined,
        port: channel.port1,
        revocation: new Int32Array(revocation),
        surfaces: selected,
        state: "live",
        opens: new Map(),
        retire,
        retired,
      };
      for (const surface of selected) surface.holder = id;
      grants.set(id, grant);
      retainedGrants.add(grant);
      channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (grant.state !== "live") return;
        if (validGraphicsOpen(data, commandBytes, completionBytes)) {
          if (!gpu || grant.opens.has(data.id) || grant.opens.size >= 8) {
            settleOpen(data, -28, 2);
            return;
          }
          try {
            graphicsLaunchRetention(publicGrant);
          } catch {
            settleOpen(data, -64, 5);
            revoke(grant);
            return;
          }
          attach(grant, data);
        } else if (
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          data.type === "close" &&
          "id" in data &&
          typeof data.id === "number" &&
          service
        ) {
          try {
            post({ type: "close", grant: id, id: data.id });
          } catch {
            failService(service);
          }
        }
      };
      const connection: GraphicsConnection = {
        port: channel.port2,
        gpu,
        revocation,
        surfaces: selected.map((surface) => ({ id: surface.surface.id, info: surface.info })),
        commandBytes,
        completionBytes,
      };
      const publicGrant: GraphicsGrant = Object.freeze({
        connection,
        dispose: () => revoke(grant),
        retired: () => retired,
      });
      return publicGrant;
    },
  });
  const suspend = () => {
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    for (const grant of Array.from(grants.values())) revoke(grant);
  };
  return {
    display,
    retained: () => retained || (service !== undefined && service.phase !== "joined"),
    suspend,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      const retiring = Promise.all(Array.from(grants.values(), (grant) => grant.retired));
      const owner = service;
      disposal = Promise.resolve()
        .then(async () => {
          // Healthy grant cleanup needs the service reader gate until its actual acknowledgement.
          await (owner
            ? Promise.race([retiring, owner.retirementStarted.then((failure) => failure.settled)])
            : retiring);
          await (owner ? retireService(owner).settled : undefined);
          observer?.disconnect();
          globalThis.removeEventListener?.("resize", visibility);
          globalThis.removeEventListener?.("focus", visibility);
          globalThis.removeEventListener?.("blur", visibility);
          globalThis.document?.removeEventListener("visibilitychange", visibility);
          surfaces.clear();
        })
        .catch((error: unknown) => {
          retained = true;
          throw error;
        });
      void disposal.catch(() => {});
      suspend();
      return disposal;
    },
  };
}
function boundService(owner: ServiceOwner): owner is ServiceOwner & { worker: Worker } {
  return owner.worker !== undefined;
}
function revokeExposed(grant: GrantOwner, opens: ReadonlySet<GraphicsOpen>): void {
  if (grant.state === "retired") return;
  grant.state = "revoking";
  Atomics.store(grant.revocation, 0, 1);
  Atomics.notify(grant.revocation, 0);
  for (const open of opens) settleOpen(open, -64, 5);
}
async function joinServiceReaders(
  owner: ServiceOwner,
  closed: ReturnType<ServiceReaderFence["close"]>,
  finish: (grant: GrantOwner) => void,
): Promise<JoinedServiceReaders> {
  const proof = await closed.join();
  if (!closed.accepts(proof)) throw new Error("Wrong GPU service reader proof");
  for (const [grant, opens] of owner.exposed) {
    if (grant.state === "retired") continue;
    for (const open of opens) settleOpen(open, -64, 5);
    finish(grant);
  }
  owner.phase = "joined";
  return proof;
}
function ringSize(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes < 64 || bytes > 16 * 1024 * 1024 || bytes & (bytes - 1))
    throw new RangeError("Invalid graphics ring size");
  return bytes;
}
function settledOpen(open: GraphicsOpen): boolean {
  const control = new Int32Array(open.control);
  const reason = Atomics.load(control, 1);
  if (reason <= 0 || Atomics.load(control, 0) >= 0) return false;
  return (
    Number((Atomics.load(new BigInt64Array(open.commands, 0, 1), 0) >> 32n) & 0xffffffffn) ===
      reason &&
    Number((Atomics.load(new BigInt64Array(open.replies, 0, 1), 0) >> 32n) & 0xffffffffn) ===
      reason &&
    Atomics.load(new Int32Array(open.arena), 0) === reason
  );
}
function settleOpen(open: GraphicsOpen, errno: number, reason: number): void {
  if (settledOpen(open)) return;
  const selected = terminateRing(open.commands, reason);
  terminateRing(open.replies, selected);
  Atomics.store(new Int32Array(open.arena), 0, selected);
  const cells = new Int32Array(open.control);
  Atomics.store(cells, 1, selected);
  const previous = Atomics.load(cells, 0);
  if (previous >= 0)
    Atomics.compareExchange(
      cells,
      0,
      previous,
      selected === reason ? errno : selected === 3 ? -48 : -64,
    );
  Atomics.notify(cells, 0);
}
function terminateRing(buffer: SharedArrayBuffer, reason: number): number {
  const publication = new BigInt64Array(buffer, 0, 1);
  let seen = Atomics.load(publication, 0);
  while (((seen >> 32n) & 0xffffffffn) === 0n) {
    const next = (BigInt(reason | 0) << 32n) | (seen & 0xffffffffn);
    const previous = Atomics.compareExchange(publication, 0, seen, next);
    if (previous === seen) {
      seen = next;
      break;
    }
    seen = previous;
  }
  const cells = new Int32Array(buffer, 0, 16);
  Atomics.add(cells, 4, 1);
  Atomics.notify(cells, 4);
  return Number((seen >> 32n) & 0xffffffffn);
}

function grantId(value: number): GrantId {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Grant identities exhausted");
  return value as GrantId;
}
function serviceIncarnation(value: number): ServiceIncarnation {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("Service identities exhausted");
  return value as ServiceIncarnation;
}

function createGpuWorker(options: DisplayOwnerOptions): Worker {
  if (options.worker) return options.worker();
  if (options.workerUrl)
    return new Worker(options.workerUrl, { type: "module", name: "waffle-gpu" });
  return new Worker(new URL("../gpu/service-worker.ts", import.meta.url), {
    type: "module",
    name: "waffle-gpu",
  });
}
