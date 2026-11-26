import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createNotificationBridge,
  type NotificationBridge,
} from "../browser/notification-relay.js";

const relayUrl = new URL("../browser/notification-worker.ts", import.meta.url).href;

const NativeWorker = globalThis.Worker;
let constructed: string[] = [];
let terminated: string[] = [];

beforeEach(() => {
  constructed = [];
  terminated = [];
  globalThis.Worker = class extends NativeWorker {
    private readonly url: string;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.url = String(url);
      constructed.push(this.url);
    }
    override terminate(): void {
      terminated.push(this.url);
      super.terminate();
    }
  } as typeof Worker;
});

afterEach(() => {
  globalThis.Worker = NativeWorker;
});

interface Guest {
  readonly bridge: NotificationBridge;
  readonly word: Int32Array;
  readonly replies: unknown[];
  park(): void;
}

/** Arms one bridge on its own word, the way a guest's NotificationWaitScope does. */
async function guest(): Promise<Guest> {
  const bridge = createNotificationBridge(relayUrl);
  const word = new Int32Array(new SharedArrayBuffer(4));
  const replies: unknown[] = [];
  const port = bridge.connection.port;
  const armed = new Promise<unknown>((resolve) => {
    port.onmessage = ({ data }) => {
      replies.push(data);
      resolve(data);
    };
  });
  port.postMessage({ type: "arm", words: [{ cells: word, index: 0 }] });
  expect(await armed).toEqual({ type: "armed" });
  return {
    bridge,
    word,
    replies,
    park: () => port.postMessage({ type: "park", values: [Atomics.load(word, 0)] }),
  };
}

/** Parks, changes the guest's word and waits up to 1 s for its publication. */
async function forwarded({ bridge, word, park }: Guest): Promise<boolean> {
  const state = bridge.connection.state;
  const sequence = Atomics.load(state, 0);
  park();
  await new Promise((resolve) => setTimeout(resolve, 5));
  Atomics.add(word, 0, 1);
  Atomics.notify(word, 0);
  const waiting = Atomics.waitAsync(state, 0, sequence, 1000);
  return (waiting.async ? await waiting.value : waiting.value) !== "timed-out";
}

const relays = () => constructed.filter((url) => url === relayUrl);

test("bridges on one page share one relay Worker, which stops with the last bridge", async () => {
  const guests = [await guest(), await guest(), await guest()];
  try {
    // Blocking waiters start inside the relay Worker; the page constructs only the relay.
    expect(relays()).toHaveLength(1);
    for (const each of guests) expect(await forwarded(each)).toBe(true);
    expect(relays()).toHaveLength(1);

    // Dropping one connection leaves the others forwarding.
    const before = Atomics.load(guests[0]!.bridge.connection.state, 0);
    await guests[0]!.bridge.dispose();
    expect(Atomics.load(guests[0]!.bridge.connection.state, 1)).toBe(1);
    expect(terminated).not.toContain(constructed[0]);
    Atomics.add(guests[0]!.word, 0, 1);
    Atomics.notify(guests[0]!.word, 0);
    expect(await forwarded(guests[1]!)).toBe(true);
    expect(Atomics.load(guests[0]!.bridge.connection.state, 0)).toBe(before + 1);

    await guests[1]!.bridge.dispose();
    await guests[2]!.bridge.dispose();
    expect(terminated.filter((url) => url === relayUrl)).toHaveLength(1);

    // A later guest starts a fresh relay.
    const later = await guest();
    expect(relays()).toHaveLength(2);
    expect(await forwarded(later)).toBe(true);
    await later.bridge.dispose();
  } finally {
    for (const each of guests) await each.bridge.dispose();
  }
});

test("a malformed guest message fails only that guest's connection", async () => {
  const healthy = await guest();
  const broken = await guest();
  try {
    broken.bridge.connection.port.postMessage(null);
    await broken.bridge.closed;
    expect(Atomics.load(broken.bridge.connection.state, 1)).toBe(1);
    expect(broken.replies.at(-1)).toMatchObject({ type: "error" });
    expect(Atomics.load(healthy.bridge.connection.state, 1)).toBe(0);
    expect(await forwarded(healthy)).toBe(true);
  } finally {
    await broken.bridge.dispose();
    await healthy.bridge.dispose();
  }
});

test("an unparked guest starts no blocking waiters while its word changes", async () => {
  const quiet = await guest();
  try {
    const sequence = Atomics.load(quiet.bridge.connection.state, 0);
    for (let round = 0; round < 1000; round++) {
      Atomics.add(quiet.word, 0, 1);
      Atomics.notify(quiet.word, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(relays()).toHaveLength(1);
    expect(Atomics.load(quiet.bridge.connection.state, 0)).toBe(sequence);
  } finally {
    await quiet.bridge.dispose();
  }
});
