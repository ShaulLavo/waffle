import {
  createNotificationWaiters,
  notificationBlockingWait,
  type NotificationBlockingRequest,
} from "./notification-blocking-wait.js";
import type {
  NotificationConnection,
  NotificationRelayReply,
  NotificationRelayRequest,
  NotificationWord,
} from "./notification-relay.js";

const waiters = createNotificationWaiters(import.meta.url);
const waitForWord = waiters.wait;

// One observer and pending reply per armed word. Disposal clears these roots before
// terminating the relay; late replies must not recreate the cleared slots.
const observers: (Promise<void> | undefined)[] = [];
const pendingWaits: (Promise<string> | undefined)[] = [];

function publish(state: Int32Array): void {
  if (Atomics.load(state, 1)) return;
  Atomics.add(state, 0, 1);
  Atomics.notify(state, 0);
}

function clearRoot<T>(roots: (T | undefined)[], slot: number): void {
  if (slot < roots.length) roots[slot] = undefined;
}

async function observe(word: NotificationWord, state: Int32Array, slot: number): Promise<void> {
  let seen = Atomics.load(word.cells, word.index);
  while (!Atomics.load(state, 1)) {
    const waiting = waitForWord(word.cells, word.index, seen);
    if (!waiting.async) {
      seen = Atomics.load(word.cells, word.index);
      publish(state);
      continue;
    }
    pendingWaits[slot] = waiting.value;
    try {
      await waiting.value;
    } finally {
      clearRoot(pendingWaits, slot);
    }
    seen = Atomics.load(word.cells, word.index);
    publish(state);
  }
}

async function observeSafely(
  word: NotificationWord,
  state: Int32Array,
  reply: (value: NotificationRelayReply) => void,
  slot: number,
): Promise<void> {
  try {
    await observe(word, state, slot);
  } catch (error) {
    reply({ type: "error", message: String(error) });
    globalThis.postMessage("failed");
  } finally {
    clearRoot(observers, slot);
  }
}

function arm(
  words: readonly NotificationWord[],
  state: Int32Array,
  reply: (value: NotificationRelayReply) => void,
): void {
  for (let slot = 0; slot < words.length; slot++)
    observers[slot] = observeSafely(words[slot]!, state, reply, slot);
  reply({ type: "armed" });
}

function connect({ port, state }: NotificationConnection): void {
  let armed = false;
  const reply = (value: NotificationRelayReply) => port.postMessage(value);
  port.onmessage = ({ data }: MessageEvent<NotificationRelayRequest>) => {
    if (data.type === "dispose") {
      waiters.dispose();
      observers.length = 0;
      pendingWaits.length = 0;
      port.close();
      globalThis.postMessage("disposed");
      return;
    }
    if (armed || Atomics.load(state, 1)) return;
    armed = true;
    try {
      arm(data.words, state, reply);
    } catch (error) {
      reply({ type: "error", message: String(error) });
    }
  };
  port.start();
}

globalThis.onmessage = ({
  data,
}: MessageEvent<NotificationConnection | NotificationBlockingRequest>) => {
  if ("type" in data) notificationBlockingWait(data);
  else connect(data);
};
