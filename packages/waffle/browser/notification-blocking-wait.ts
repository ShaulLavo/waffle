import type { NotificationWord } from "./notification-relay.js";

export interface NotificationBlockingRequest {
  readonly type: "wait";
  readonly word: NotificationWord;
  readonly seen: number;
}

interface Waiter extends NotificationWord {
  readonly worker: Worker;
  pending: ReturnType<typeof Promise.withResolvers<string>> | undefined;
}

/** Each source can sleep indefinitely without depending on a worker's async timer dispatch. */
export function createNotificationWaiters(url: string) {
  const waiters: Waiter[] = [];
  const create = (cells: Int32Array, index: number): Waiter => {
    const worker = new Worker(url, { type: "module" });
    const waiter: Waiter = { cells, index, worker, pending: undefined };
    worker.onmessage = ({ data }: MessageEvent<string>) => {
      const pending = waiter.pending;
      waiter.pending = undefined;
      pending?.resolve(data);
    };
    worker.onerror = (event) => waiter.pending?.reject(Error(event.message));
    waiters.push(waiter);
    return waiter;
  };
  return {
    wait(cells: Int32Array, index: number, seen: number) {
      if (Atomics.load(cells, index) !== seen) return { async: false, value: "not-equal" } as const;
      const waiter =
        waiters.find((waiter) => waiter.cells === cells && waiter.index === index) ??
        create(cells, index);
      const pending = Promise.withResolvers<string>();
      waiter.pending = pending;
      waiter.worker.postMessage({
        type: "wait",
        word: { cells, index },
        seen,
      } satisfies NotificationBlockingRequest);
      return { async: true, value: pending.promise } as const;
    },
    dispose(): void {
      for (const waiter of waiters) waiter.worker.terminate();
      waiters.length = 0;
    },
  };
}

/** The worker repeats this handler only when the relay rearms it, never on a timer. */
export function notificationBlockingWait({ word, seen }: NotificationBlockingRequest): void {
  globalThis.postMessage(Atomics.wait(word.cells, word.index, seen));
}
