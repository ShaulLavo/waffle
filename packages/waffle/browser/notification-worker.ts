import { atomicsWaitAsync } from "../proc/intrinsics.js";
import type {
  NotificationConnection,
  NotificationRelayReply,
  NotificationRelayRequest,
  NotificationWord,
} from "./notification-relay.js";

// iOS Safari 26.5 was seen to stop resolving every pending wait of an idle relay, so a guest
// asleep in its poll woke only at its own timeout. Keep each armed word's observer and its
// pending wait reachable from this module, not only from the engine's waiter list. One slot per
// armed word, reused for every wait: no allocation beyond the waits themselves.
const observers: Promise<void>[] = [];
const pendingWaits: (Promise<string> | undefined)[] = [];

function publish(state: Int32Array): void {
  if (Atomics.load(state, 1)) return;
  Atomics.add(state, 0, 1);
  Atomics.notify(state, 0);
}

async function observe(word: NotificationWord, state: Int32Array, slot: number): Promise<void> {
  let seen = Atomics.load(word.cells, word.index);
  while (!Atomics.load(state, 1)) {
    const waiting = atomicsWaitAsync(word.cells, word.index, seen);
    if (waiting.async) {
      pendingWaits[slot] = waiting.value;
      await waiting.value;
      pendingWaits[slot] = undefined;
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
  }
}

function arm(
  words: readonly NotificationWord[],
  state: Int32Array,
  reply: (value: NotificationRelayReply) => void,
): void {
  if (typeof atomicsWaitAsync !== "function")
    throw new Error("notification relay requires Atomics.waitAsync");
  for (let slot = 0; slot < words.length; slot++)
    observers[slot] = observeSafely(words[slot]!, state, reply, slot);
  reply({ type: "armed" });
}

function connect({ port, state }: NotificationConnection): void {
  let armed = false;
  const reply = (value: NotificationRelayReply) => port.postMessage(value);
  port.onmessage = ({ data }: MessageEvent<NotificationRelayRequest>) => {
    if (data.type === "dispose") {
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

globalThis.onmessage = ({ data }: MessageEvent<NotificationConnection>) => connect(data);
