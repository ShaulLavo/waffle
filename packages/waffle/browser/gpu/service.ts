import { validGraphicsOpen } from "../display/open.js";
import type { GraphicsOpen, GpuServiceRequest, GpuServiceReply } from "../display/protocol.js";
import { GpuConnection, GpuScheduler } from "./scheduler.js";
import { RecordRing } from "./ring.js";
import { gpuPayloadLayout } from "../display/generated/graphics-layout.js";
import { GPU_TERMINAL, ServiceCredit } from "./protocol.js";
import { GpuSurfaces, type SurfaceConnection } from "./surfaces.js";
import type { SurfaceTarget } from "./replay.js";

interface ConnectionOwner {
  readonly grant: number;
  readonly id: number;
  readonly control: Int32Array;
  readonly connection: GpuConnection;
  readonly surfaces: SurfaceConnection;
  waiting: boolean;
}
export interface GpuServiceOptions {
  readonly root?: object;
  readonly suppressTransfer?: boolean;
}
/** Dedicated responsive realm. Never imported by a guest worker. */
export class GpuService {
  readonly #connections = new Map<string, ConnectionOwner>();
  readonly #scheduler = new GpuScheduler();
  readonly #credit = new ServiceCredit();
  readonly #surfaces: GpuSurfaces;
  readonly #tasks = new MessageChannel();
  readonly #root: object | undefined;
  #slices = 0;
  #scheduled = false;
  #live = true;
  constructor(
    readonly send: (message: GpuServiceReply) => void,
    options: GpuServiceOptions = {},
  ) {
    this.#surfaces = new GpuSurfaces(options.suppressTransfer);
    this.#root = options.root ?? nativeRoot();
    this.#tasks.port1.onmessage = () => this.#turn();
  }
  receive(message: GpuServiceRequest): void {
    if (!this.#live) return;
    switch (message.type) {
      case "open":
        this.#open(message);
        return;
      case "close":
        this.#close(message.grant, message.id, GPU_TERMINAL.closed);
        return;
      case "revoke": {
        for (const owner of Array.from(this.#connections.values()))
          if (owner.grant === message.grant) this.#retire(owner, GPU_TERMINAL.revoked);
        this.send({ type: "retired", grant: message.grant });
        return;
      }
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
    try {
      const commands = new RecordRing(open.commands, 8),
        replies = new RecordRing(open.replies, 16);
      const target: { root: object; surfaces?: SurfaceTarget } = { root: this.#root };
      connection = new GpuConnection(commands, replies, target, this.#credit, {
        arena: new Uint8Array(open.arena),
      });
      const surfaces = (target.surfaces = this.#surfaces.connection(
        message.surfaces.map((surface) => surface.id),
        connection.completions,
      ));
      const owner: ConnectionOwner = {
        grant: message.grant,
        id: open.id,
        control,
        connection,
        surfaces,
        waiting: false,
      };
      this.#connections.set(key(message.grant, open.id), owner);
      this.#scheduler.add(connection);
      if (Atomics.compareExchange(control, 0, 0, 1) !== 0) {
        this.#retire(owner, GPU_TERMINAL.revoked);
        return;
      }
      Atomics.notify(control, 0);
      this.#schedule();
    } catch {
      connection?.close(GPU_TERMINAL.service);
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
    if (!this.#live) return;
    this.#slices++;
    const progress = this.#scheduler.turn();
    for (const owner of Array.from(this.#connections.values())) {
      const state = owner.connection.state;
      if (state.kind === "terminal") {
        this.#retire(owner, state.reason);
        continue;
      }
      this.#arm(owner);
    }
    if (progress) this.#schedule();
  }
  #arm(owner: ConnectionOwner): void {
    if (owner.waiting) return;
    const ring = owner.connection.commands;
    const seen = ring.sequence();
    const wait = ring.waitAsync(seen, 10);
    if (!wait.async) {
      this.#schedule();
      return;
    }
    owner.waiting = true;
    void wait.value.then(() => {
      owner.waiting = false;
      if (this.#connections.get(key(owner.grant, owner.id)) === owner) this.#schedule();
    });
  }
  #close(grant: number, id: number, reason: number): void {
    const owner = this.#connections.get(key(grant, id));
    if (owner) this.#retire(owner, reason);
  }
  #retire(owner: ConnectionOwner, reason: number): void {
    // Stop surface continuations before core destruction releases native devices.
    const winner = owner.connection.commands.terminate(reason).reason;
    owner.surfaces.dispose();
    owner.connection.close(winner);
    this.#scheduler.remove(owner.connection);
    this.#connections.delete(key(owner.grant, owner.id));
    const state = owner.connection.state;
    const selected = state.kind === "terminal" ? state.reason : reason;
    Atomics.store(owner.control, 1, selected);
    const previous = Atomics.load(owner.control, 0);
    if (previous >= 0)
      Atomics.compareExchange(
        owner.control,
        0,
        previous,
        selected === GPU_TERMINAL.resource ? -48 : -64,
      );
    Atomics.notify(owner.control, 0);
    this.send({ type: "closed", grant: owner.grant, id: owner.id });
  }
  snapshot() {
    return {
      connections: this.#connections.size,
      devicesLive: Array.from(this.#connections.values()).reduce(
        (sum, owner) => sum + owner.connection.replay.devicesLive,
        0,
      ),
      slices: this.#slices,
      heapBytes: this.#credit.used,
      ...this.#surfaces.snapshot(),
    };
  }
  dispose(): void {
    if (!this.#live) return;
    this.#live = false;
    for (const owner of Array.from(this.#connections.values()))
      this.#retire(owner, GPU_TERMINAL.service);
    this.#tasks.port1.close();
    this.#tasks.port2.close();
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
