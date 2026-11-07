import { validGraphicsOpen } from "../gpu/protocol.js";
import { allocateSharedControl } from "../../memory/control.js";
import type {
  GraphicsConnection,
  GraphicsGrant,
  GraphicsOpen,
  GpuServiceRequest,
  GpuServiceReply,
  ServiceSurface,
} from "./protocol.js";

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
  readonly id: GrantId;
  readonly port: MessagePort;
  readonly revocation: Int32Array;
  readonly surfaces: readonly SurfaceOwner[];
  readonly opens: Map<number, GraphicsOpen>;
  state: "live" | "revoking" | "retired";
  readonly retire: () => void;
}
interface ServiceOwner {
  readonly worker: Worker;
  readonly incarnation: ServiceIncarnation;
}
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
  const assertLive = () => {
    checkLive();
    if (disposed) throw new Error("Display disposed");
  };
  const post = (message: GpuServiceRequest, transfer: Transferable[] = []) =>
    service!.worker.postMessage(message, transfer);
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
  const failService = (owner: ServiceOwner) => {
    if (service !== owner) return;
    // Retire the actual failed worker before a future open can replace it.
    service = undefined;
    owner.worker.terminate();
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    for (const surface of surfaces.values())
      if (surface.state === "transferred") surface.state = "lost";
    for (const grant of Array.from(grants.values())) {
      for (const open of grant.opens.values()) settleOpen(open, -64, 5);
      finish(grant);
    }
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
    if (service) return service;
    assertLive();
    const worker = createGpuWorker(options);
    const owner = { worker, incarnation: serviceIncarnation(++incarnation) };
    service = owner;
    worker.onerror = () => failService(owner);
    worker.onmessageerror = () => failService(owner);
    worker.onmessage = ({ data }: MessageEvent<GpuServiceReply>) => {
      if (service !== owner) return;
      const grant = grants.get(data.grant);
      if (!grant) return;
      if (data.type === "retired") finish(grant);
      else if (data.type === "closed") grant.opens.delete(data.id);
    };
    frame = requestAnimationFrame(tick);
    return owner;
  };
  const attach = (grant: GrantOwner, open: GraphicsOpen) => {
    // Publish ownership before worker construction or any transfer can fail.
    grant.opens.set(open.id, open);
    try {
      assertLive();
      if (grant.state !== "live") throw new Error("Revoked grant");
      activate();
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
      else finish(grant);
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
    if (!service) {
      finish(grant);
      return;
    }
    try {
      post({ type: "revoke", grant: grant.id });
    } catch {
      failService(service);
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
        port: channel.port1,
        revocation: new Int32Array(revocation),
        surfaces: selected,
        state: "live",
        opens: new Map(),
        retire,
      };
      for (const surface of selected) surface.holder = id;
      grants.set(id, grant);
      channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (grant.state !== "live") return;
        if (validGraphicsOpen(data, commandBytes, completionBytes)) {
          if (!gpu || grant.opens.has(data.id) || grant.opens.size >= 8) {
            settleOpen(data, -28, 2);
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
      return Object.freeze({ connection, dispose: () => revoke(grant), retired: () => retired });
    },
  });
  return {
    display,
    suspend() {
      for (const grant of Array.from(grants.values())) revoke(grant);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const grant of Array.from(grants.values())) revoke(grant);
      if (service) failService(service);
      observer?.disconnect();
      globalThis.removeEventListener?.("resize", visibility);
      globalThis.removeEventListener?.("focus", visibility);
      globalThis.removeEventListener?.("blur", visibility);
      globalThis.document?.removeEventListener("visibilitychange", visibility);
      surfaces.clear();
    },
  };
}
function ringSize(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes < 64 || bytes > 16 * 1024 * 1024 || bytes & (bytes - 1))
    throw new RangeError("Invalid graphics ring size");
  return bytes;
}
function settleOpen(open: GraphicsOpen, errno: number, reason: number): void {
  const selected = terminateRing(open.commands, reason);
  terminateRing(open.replies, selected);
  Atomics.store(new Int32Array(open.arena), 0, selected);
  const cells = new Int32Array(open.control);
  Atomics.store(cells, 1, selected);
  Atomics.store(cells, 0, selected === reason ? errno : selected === 3 ? -48 : -64);
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
