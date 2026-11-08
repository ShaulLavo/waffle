import { validGraphicsOpen } from "../display/open.js";
import type { GraphicsOpen } from "../display/protocol.js";
import type { GpuServiceRequest, GpuServiceReply } from "../display/service-protocol.js";
import type { ServiceAccess } from "../display/service-readers.js";
import { ConnectionAccess } from "./access.js";
import { GpuConnection, GpuScheduler } from "./scheduler.js";
import { RecordRing } from "./ring.js";
import { gpuPayloadLayout } from "../display/generated/graphics-layout.js";
import { GPU_TERMINAL, ServiceCredit } from "./protocol.js";
import { GpuSurfaces, type SurfaceConnection } from "./surfaces.js";
import type { SurfaceTarget } from "./replay.js";

interface ConnectionOwner {
  readonly grant: number;
  readonly access: ConnectionAccess;
  reason: number | undefined;
  phase: "live" | "sealed" | "settling" | "retired" | "retained";
  readonly id: number;
  readonly control: Int32Array;
  readonly open: GraphicsOpen;
  readonly connection: GpuConnection;
  readonly surfaces: SurfaceConnection;
  waiting: boolean;
}
interface GrantOwner {
  phase: "live" | "sealed" | "settling" | "ready-to-ack" | "retired" | "retained";
}
export interface GpuServiceOptions {
  readonly access: ServiceAccess;
  readonly root?: object;
  readonly suppressTransfer?: boolean;
}
/** Dedicated responsive realm. Never imported by a guest worker. */
export class GpuService {
  readonly #grants = new Map<number, GrantOwner>();
  readonly #connections = new Map<string, ConnectionOwner>();
  readonly #scheduler = new GpuScheduler();
  readonly #credit = new ServiceCredit();
  readonly #surfaces: GpuSurfaces;
  readonly #tasks = new MessageChannel();
  readonly #root: object | undefined;
  #slices = 0;
  #scheduled = false;
  #live = true;
  #disposing = false;
  #disposal: Promise<void> | undefined;
  #disposed: (() => void) | undefined;
  #rejectDispose: ((error: unknown) => void) | undefined;
  readonly #failures: unknown[] = [];
  constructor(
    readonly send: (message: GpuServiceReply) => void,
    private readonly options: GpuServiceOptions,
  ) {
    this.#surfaces = new GpuSurfaces(options.suppressTransfer);
    this.#root = options.root ?? nativeRoot();
    this.#tasks.port1.onmessage = () => this.#turn();
  }
  receive(message: GpuServiceRequest): void {
    this.options.access.run(() => { this.#receive(message); return undefined; });
  }
  #receive(message: GpuServiceRequest): void {
    if (!this.#live || this.#disposing) return;
    switch (message.type) {
      case "open":
        this.#open(message);
        return;
      case "close":
        this.#close(message.grant, message.id, GPU_TERMINAL.closed);
        return;
      case "revoke":
        this.#revoke(message.grant);
        return;
      case "tick":
        this.#surfaces.tick();
        this.#schedule();
        return;
      case "surface-dispose":
        this.#surfaces.dispose(message.id);
        return;
      default: {
        const exhaustive: never = message;
        throw new Error(String(exhaustive));
      }
    }
  }
  #open(message: Extract<GpuServiceRequest, { type: "open" }>): void {
    const open = message.open;
    let grant = this.#grants.get(message.grant);
    if (!grant) this.#grants.set(message.grant, (grant = { phase: "live" }));
    if (grant.phase !== "live") return;
    if (!validGraphicsOpen(open, open.commands.byteLength - 64, open.replies.byteLength - 64))
      return;
    const control = new Int32Array(open.control);
    try {
      this.#surfaces.attach(message.surfaces);
    } catch {
      failOpen(open, -64, GPU_TERMINAL.service);
      return;
    }
    if (Atomics.load(control, 0) !== 0) {
      failOpen(open, -64, GPU_TERMINAL.revoked);
      return;
    }
    if (!this.#root) {
      failOpen(open, -58, GPU_TERMINAL.service);
      return;
    }
    if (this.#connections.size >= 8 || this.#connections.has(key(message.grant, open.id))) {
      failOpen(open, -48, GPU_TERMINAL.resource);
      return;
    }
    let connection: GpuConnection | undefined;
    const access = new ConnectionAccess(this.options.access, () => this.#schedule());
    const retire = (reason: number) => this.#close(message.grant, open.id, reason);
    try {
      const commands = new RecordRing(open.commands, 8),
        replies = new RecordRing(open.replies, 16);
      const target: { root: object; surfaces?: SurfaceTarget } = { root: this.#root };
      connection = new GpuConnection(commands, replies, target, this.#credit, {
        arena: new Uint8Array(open.arena),
        access,
        requestRetirement: retire,
      });
      const surfaces = (target.surfaces = this.#surfaces.connection(
        message.surfaces.map((surface) => surface.id),
        connection.completions,
      ));
      const owner: ConnectionOwner = {
        grant: message.grant,
        access, phase: "live", reason: undefined,
        id: open.id,
        control, open,
        connection,
        surfaces,
        waiting: false,
      };
      this.#connections.set(key(message.grant, open.id), owner);
      this.#scheduler.add(connection);
      if (Atomics.compareExchange(control, 0, 0, 1) !== 0) {
        this.#seal(owner, GPU_TERMINAL.revoked);
        return;
      }
      Atomics.notify(control, 0);
      this.#schedule();
    } catch {
      connection?.completions.finishRetirement(GPU_TERMINAL.service);
      failOpen(open, -64, GPU_TERMINAL.service);
    }
  }
  #schedule(): void {
    if (this.#scheduled || !this.#live) return;
    this.#scheduled = true;
    this.#tasks.port2.postMessage(null);
  }
  #turn(): void {
    this.#scheduled = false;
    this.options.access.run(() => { this.#admittedTurn(); return undefined; });
  }
  #admittedTurn(): void {
    if (!this.#live) return;
    this.#slices++;
    this.#retireQueued();
    if (!this.#live) return;
    const progress = this.#scheduler.turn();
    for (const owner of Array.from(this.#connections.values())) {
      if (owner.phase !== "live") continue;
      const state = owner.connection.state;
      if (state.kind === "terminal") {
        this.#seal(owner, state.reason);
        continue;
      }
      this.#arm(owner);
    }
    if (progress) this.#schedule();
  }
  #arm(owner: ConnectionOwner): void {
    if (owner.waiting || owner.phase !== "live") return;
    const ring = owner.connection.commands;
    const seen = ring.sequence();
    const wait = ring.waitAsync(seen, 10);
    if (!wait.async) {
      this.#schedule();
      return;
    }
    owner.waiting = true;
    void wait.value.then(() => {
      owner.access.run(() => {
        owner.waiting = false;
        if (this.#connections.get(key(owner.grant, owner.id)) === owner) this.#schedule();
        return undefined;
      });
    });
  }
  #close(grant: number, id: number, reason: number): void {
    const owner = this.#connections.get(key(grant, id));
    if (owner) this.#seal(owner, reason);
  }
  #seal(owner: ConnectionOwner, reason: number): void {
    if (owner.phase !== "live") return;
    owner.reason = reason;
    owner.phase = "sealed";
    owner.access.seal();
    this.#scheduler.remove(owner.connection);
    this.#schedule();
  }
  #revoke(id: number): void {
    let grant = this.#grants.get(id);
    if (!grant) this.#grants.set(id, (grant = { phase: "live" }));
    if (grant.phase !== "live") return;
    grant.phase = "sealed";
    for (const owner of this.#connections.values())
      if (owner.grant === id) this.#seal(owner, GPU_TERMINAL.revoked);
    this.#schedule();
  }
  #retireQueued(): void {
    // Capture the ack set before cleanup. Cleanup can reenter receive(), but cannot ack inline.
    const acknowledgements = Array.from(this.#grants).filter(([, grant]) => grant.phase === "ready-to-ack");
    const retiring = Array.from(this.#connections.values()).filter((owner) => owner.phase === "sealed");
    for (const owner of retiring) {
      if (owner.access.active) continue;
      this.#retire(owner);
    }
    for (const [id, grant] of this.#grants) this.#readyGrant(id, grant);
    for (const [id, grant] of acknowledgements) {
      if (grant.phase !== "ready-to-ack") continue;
      grant.phase = "retired";
      this.send({ type: "retired", grant: id });
    }
    if (this.#disposing && (!this.#connections.size || Array.from(this.#connections.values()).every((owner) => owner.phase === "retained"))) this.#finishDispose();
  }
  #readyGrant(id: number, grant: GrantOwner): void {
    if (grant.phase !== "sealed") return;
    const owned = Array.from(this.#connections.values()).filter((owner) => owner.grant === id);
    if (owned.some((owner) => owner.phase === "retained")) { grant.phase = "retained"; return; }
    if (owned.length) return;
    grant.phase = "ready-to-ack";
    this.#schedule();
  }
  #retire(owner: ConnectionOwner): void {
    owner.phase = "settling";
    const reason = owner.reason ?? GPU_TERMINAL.closed;
    try {
      // The sealed lease stays closed. Only this queued owner has final settlement authority.
      owner.surfaces.dispose();
      owner.connection.completions.finishRetirement(reason);
      const selected = new RecordRing(owner.open.commands, 8).terminal()?.reason ?? reason;
      Atomics.store(owner.control, 1, selected);
      const previous = Atomics.load(owner.control, 0);
      if (previous >= 0) Atomics.compareExchange(owner.control, 0, previous, selected === GPU_TERMINAL.resource ? -48 : -64);
      Atomics.notify(owner.control, 0);
      owner.phase = "retired";
      this.#connections.delete(key(owner.grant, owner.id));
      this.send({ type: "closed", grant: owner.grant, id: owner.id });
    } catch (error) {
      owner.phase = "retained";
      this.#failures.push(error);
      this.send({ type: "retirement-failed", grant: owner.grant });
    }
  }
  snapshot() {
    return {
      connections: this.#connections.size,
      devicesLive: Array.from(this.#connections.values()).reduce(
        (sum, owner) => sum + owner.connection.replay.devicesLive,
        0,
      ),
      slices: this.#slices,
      cleanupFailures: this.#failures.length,
      heapBytes: this.#credit.used,
      ...this.#surfaces.snapshot(),
    };
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposal = new Promise<void>((resolve, reject) => { this.#disposed = resolve; this.#rejectDispose = reject; });
    void this.#disposal.catch(() => {});
    this.#disposing = true;
    const admitted = this.options.access.run(() => {
      for (const id of this.#grants.keys()) this.#revoke(id);
      for (const owner of this.#connections.values()) this.#seal(owner, GPU_TERMINAL.service);
      if (!this.#connections.size) this.#finishDispose();
      else this.#schedule();
      return undefined;
    });
    if (admitted === "closed") {
      // No transport access is allowed here, including effectful completion getters.
      for (const owner of this.#connections.values()) {
        owner.access.seal();
        owner.connection.completions.abandon();
      }
      this.#connections.clear();
      this.#finishDispose();
    }
    return this.#disposal;
  }
  #finishDispose(): void {
    this.#live = false;
    this.#tasks.port1.close();
    this.#tasks.port2.close();
    if (this.#failures.length) this.#rejectDispose?.(new AggregateError(this.#failures, "GPU service cleanup retained"));
    else this.#disposed?.();
  }

}
function key(grant: number, id: number): string {
  return `${grant}:${id}`;
}
function failOpen(open: GraphicsOpen, errno: number, reason: number): void {
  const selected = new RecordRing(open.commands, 8).terminate(reason).reason;
  new RecordRing(open.replies, 16).terminate(selected);
  Atomics.store(new Int32Array(open.arena, gpuPayloadLayout.terminalOffset, 1), 0, selected);
  const control = new Int32Array(open.control);
  Atomics.store(control, 1, selected);
  Atomics.compareExchange(
    control,
    0,
    0,
    selected === reason ? errno : selected === GPU_TERMINAL.resource ? -48 : -64,
  );
  Atomics.notify(control, 0);
}

function nativeRoot(): object | undefined {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return undefined;
  return {
    get wgslLanguageFeatures() {
      return gpu.wgslLanguageFeatures;
    },
    requestAdapter(options?: GPURequestAdapterOptions) {
      return gpu.requestAdapter(options);
    },
  };
}
