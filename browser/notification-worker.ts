import { atomicsWaitAsync } from "../proc/intrinsics.js";
import type {
  NotificationConnection,
  NotificationRelayReply,
  NotificationRelayRequest,
  NotificationWord,
} from "./notification-relay.js";

function publish(state: Int32Array): void {
  if (Atomics.load(state, 1)) return;
  Atomics.add(state, 0, 1);
  Atomics.notify(state, 0);
}

async function observe(word: NotificationWord, state: Int32Array): Promise<void> {
  let seen = Atomics.load(word.cells, word.index);
  while (!Atomics.load(state, 1)) {
    const waiting = atomicsWaitAsync(word.cells, word.index, seen);
    if (waiting.async) await waiting.value;
    seen = Atomics.load(word.cells, word.index);
    publish(state);
  }
}

async function observeSafely(
  word: NotificationWord,
  state: Int32Array,
  reply: (value: NotificationRelayReply) => void,
): Promise<void> {
  try {
    await observe(word, state);
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
  for (const word of words) void observeSafely(word, state, reply);
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
