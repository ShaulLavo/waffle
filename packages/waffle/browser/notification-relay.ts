import { allocateSharedControl } from "../memory/control.js";
export interface NotificationConnection {
  readonly port: MessagePort;
  /** Sequence, external lifetime fence, then the id of the guest's active park (0: none). */
  readonly state: Int32Array;
}

export interface NotificationWord {
  readonly cells: Int32Array;
  readonly index: number;
}

export type NotificationRelayRequest =
  | { readonly type: "arm"; readonly words: readonly NotificationWord[] }
  /** The guest is about to block having observed `values`, one per armed word. It stored `id`
   * in state[2] first and clears it when the blocking call returns. */
  | { readonly type: "park"; readonly id: number; readonly values: readonly number[] }
  | { readonly type: "dispose" };

export type NotificationRelayReply =
  | { readonly type: "armed" }
  | { readonly type: "error"; readonly message: string };

/** Page to relay Worker: one message adds a guest connection, the other removes it. */
export type NotificationRelayControl =
  | (NotificationConnection & { readonly id: number })
  | { readonly drop: number };

/** Relay Worker to page, about one connection. */
export interface NotificationRelayNotice {
  readonly id: number;
  readonly type: "failed" | "disposed" | "dropped";
}

export interface NotificationBridge {
  readonly connection: NotificationConnection;
  /** Settles once the relay can no longer publish to this connection: after the relay
   * dropped it, or after the host's termination operation returns for the last one. */
  readonly closed: Promise<void>;
  dispose(): Promise<void>;
}

/** One relay Worker serves every bridge on this page that names the same Worker URL. It
 * lives while any of those bridges does and is terminated with the last one. */
class SharedRelay {
  private readonly worker: Worker;
  /** Live bridges by connection id: their dispose, for relay-reported failures. */
  private readonly members = new Map<number, () => Promise<void>>();
  /** Removed bridges waiting for the relay to acknowledge their drop. */
  private readonly drops = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly registry: Map<string, SharedRelay>,
  ) {
    this.worker = new Worker(url, { type: "module" });
    this.worker.onerror = () => {
      for (const dispose of Array.from(this.members.values())) void dispose().catch(() => {});
    };
    this.worker.onmessage = ({ data }: MessageEvent<NotificationRelayNotice>) => {
      const id = data?.id;
      if (data?.type === "dropped") return this.acknowledge(id);
      void this.members
        .get(id)?.()
        .catch(() => {});
    };
  }

  /** Posts the connection; throws before the relay knows it. */
  add(port: MessagePort, state: Int32Array, dispose: () => Promise<void>): number {
    const id = this.nextId++;
    this.worker.postMessage({ id, port, state } satisfies NotificationRelayControl, [port]);
    this.members.set(id, dispose);
    return id;
  }

  /** Resolves once the relay dropped the connection, or once its Worker was terminated. */
  remove(id: number): Promise<void> {
    const known = this.members.delete(id);
    if (!this.members.size) return this.stop();
    if (!known) return Promise.resolve();
    const dropped = Promise.withResolvers<void>();
    this.drops.set(id, dropped);
    try {
      this.worker.postMessage({ drop: id } satisfies NotificationRelayControl);
    } catch {
      this.acknowledge(id);
    }
    return dropped.promise;
  }

  private acknowledge(id: number): void {
    const dropped = this.drops.get(id);
    this.drops.delete(id);
    dropped?.resolve();
  }

  private stop(): Promise<void> {
    if (this.registry.get(this.url) === this) this.registry.delete(this.url);
    let stopped: Promise<void>;
    try {
      stopped = Promise.resolve(this.worker.terminate());
    } catch (error) {
      stopped = Promise.reject(error);
    }
    // Termination supersedes outstanding acknowledgments: those drops settle with its result.
    for (const [id, dropped] of Array.from(this.drops)) {
      this.drops.delete(id);
      stopped.then(dropped.resolve, dropped.reject);
    }
    return stopped;
  }
}

const relays = new Map<string, SharedRelay>();

function relayFor(url: string): SharedRelay {
  let relay = relays.get(url);
  if (!relay) relays.set(url, (relay = new SharedRelay(url, relays)));
  return relay;
}

/** Page-owned. No guest closure is needed to fence or stop forwarding to the guest. */
export function createNotificationBridge(workerUrl: string): NotificationBridge {
  const channel = new MessageChannel();
  let state: Int32Array;
  let relay: SharedRelay;
  try {
    state = new Int32Array(allocateSharedControl(12));
    relay = relayFor(workerUrl);
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
  let disposed = false;
  let id = 0;
  let finish!: () => void;
  let fail!: (reason: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const dispose = (): Promise<void> => {
    if (disposed) return closed;
    disposed = true;
    Atomics.store(state, 1, 1);
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
    channel.port2.close();
    relay.remove(id).then(finish, fail);
    return closed;
  };
  try {
    id = relay.add(channel.port1, state, dispose);
  } catch (error) {
    channel.port1.close();
    void dispose().catch(() => {});
    throw error;
  }
  return { connection: { port: channel.port2, state }, closed, dispose };
}
