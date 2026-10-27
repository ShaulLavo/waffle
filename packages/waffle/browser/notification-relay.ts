export interface NotificationConnection {
  readonly port: MessagePort;
  /** Sequence, then external lifetime fence. */
  readonly state: Int32Array;
}

export interface NotificationWord {
  readonly cells: Int32Array;
  readonly index: number;
}

export type NotificationRelayRequest =
  | { readonly type: "arm"; readonly words: readonly NotificationWord[] }
  | { readonly type: "dispose" };

export type NotificationRelayReply =
  | { readonly type: "armed" }
  | { readonly type: "error"; readonly message: string };

export interface NotificationBridge {
  readonly connection: NotificationConnection;
  /** Settles after the owning host's termination operation returns. */
  readonly closed: Promise<void>;
  dispose(): Promise<void>;
}

/** Page-owned. No guest closure is needed to fence or physically stop the relay. */
export function createNotificationBridge(workerUrl: string): NotificationBridge {
  const channel = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(8));
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, { type: "module" });
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
  let disposed = false;
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
    try {
      Promise.resolve(worker.terminate()).then(finish, fail);
    } catch (error) {
      fail(error);
    }
    return closed;
  };
  worker.onerror = () => {
    void dispose().catch(() => {});
  };
  worker.onmessage = () => {
    void dispose().catch(() => {});
  };
  try {
    worker.postMessage({ port: channel.port1, state }, [channel.port1]);
  } catch (error) {
    channel.port1.close();
    void dispose().catch(() => {});
    throw error;
  }
  return { connection: { port: channel.port2, state }, closed, dispose };
}
