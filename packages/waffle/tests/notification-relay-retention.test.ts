import { expect, test } from "bun:test";
import { controlledNotificationRelay } from "./fixtures/notification-controlled-relay.js";

const collectingRelay = new URL("./fixtures/notification-collecting-worker.ts", import.meta.url)
  .href;
const relay = new URL("../browser/notification-worker.ts", import.meta.url).href;

/** Arms the real relay on `words` and resolves once it replies. */
async function armRelay(url: string, words: readonly Int32Array[]) {
  const worker = new Worker(url, { type: "module" });
  const channel = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(8));
  worker.postMessage({ port: channel.port1, state }, [channel.port1]);
  const armed = new Promise<unknown>((resolve) => {
    channel.port2.onmessage = ({ data }) => resolve(data);
  });
  channel.port2.postMessage({ type: "arm", words: words.map((cells) => ({ cells, index: 0 })) });
  expect(await armed).toEqual({ type: "armed" });
  /** What a guest sends before it blocks: the values it observed. */
  const park = () =>
    channel.port2.postMessage({
      type: "park",
      values: words.map((cells) => Atomics.load(cells, 0)),
    });
  return { worker, channel, state, park };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parks, bumps `word` and waits up to 1 s for the relay to publish the change. */
async function forwarded(state: Int32Array, word: Int32Array, park: () => void): Promise<boolean> {
  const sequence = Atomics.load(state, 0);
  park();
  Atomics.add(word, 0, 1);
  Atomics.notify(word, 0);
  const waiting = Atomics.waitAsync(state, 0, sequence, 1000);
  const result = waiting.async ? await waiting.value : waiting.value;
  return result !== "timed-out";
}

async function lostWords(
  state: Int32Array,
  words: readonly Int32Array[],
  park: () => void,
  round: number,
): Promise<string[]> {
  const lost: string[] = [];
  for (const [index, word] of words.entries())
    if (!(await forwarded(state, word, park))) lost.push(`round ${round} word ${index}`);
  return lost;
}

// Guards forwarding under continuous full collections. Bun's engine kept forwarding even before the
// relay retained its waits, so this does not reproduce the iOS Safari 26.5 loss; that was observed
// only on the device.
test("a parked relay forwards every armed word while full collections run", async () => {
  const words = [0, 1, 2].map(() => new Int32Array(new SharedArrayBuffer(4)));
  const { worker, channel, state, park } = await armRelay(collectingRelay, words);
  let lost: string[] = [];
  try {
    for (let round = 0; round < 40 && lost.length === 0; round++) {
      // Leave the parked relay idle in its waits while collections run.
      park();
      await pause(25);
      lost = await lostWords(state, words, park, round);
    }
  } finally {
    channel.port2.close();
    worker.terminate();
  }
  expect(lost).toEqual([]);
}, 30000);

test("an idle parked relay publishes nothing until a word changes", async () => {
  const words = [0, 1, 2].map(() => new Int32Array(new SharedArrayBuffer(4)));
  const { worker, channel, state, park } = await armRelay(relay, words);
  try {
    park();
    const before = Atomics.load(state, 0);
    await pause(200);
    expect(Atomics.load(state, 0)).toBe(before);
    expect(await forwarded(state, words[1]!, park)).toBe(true);
    const after = Atomics.load(state, 0);
    park();
    await pause(200);
    expect(Atomics.load(state, 0)).toBe(after);
  } finally {
    channel.port2.close();
    worker.terminate();
  }
});

test("an unparked relay registers no waits and publishes nothing while its words change", async () => {
  const relay = await controlledNotificationRelay();
  try {
    for (let round = 0; round < 100; round++)
      for (const word of relay.words) {
        Atomics.add(word, 0, 1);
        Atomics.notify(word, 0);
      }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relay.waits).toHaveLength(0);
    expect(Atomics.load(relay.state, 0)).toBe(0);
  } finally {
    await relay.close();
  }
});

test("a park publishes once, then the relay stops until the next park", async () => {
  const relay = await controlledNotificationRelay();
  try {
    relay.park();
    expect(relay.waits).toHaveLength(3);
    // Parking again on the same values reuses the outstanding waits.
    relay.park();
    expect(relay.waits).toHaveLength(3);
    Atomics.add(relay.words[1]!, 0, 1);
    relay.waits[1]!.resolve("ok");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Atomics.load(relay.state, 0)).toBe(1);
    // Later traffic while the guest runs: no new waits, no publications.
    for (const word of relay.words) Atomics.add(word, 0, 1);
    relay.waits[0]!.resolve("ok");
    relay.waits[2]!.resolve("ok");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relay.waits).toHaveLength(3);
    expect(Atomics.load(relay.state, 0)).toBe(1);
    // A park on stale values publishes at once without waiting.
    relay.inspect("relay.receive({ type: 'park', values: [0, 0, 0] })");
    expect(relay.waits).toHaveLength(3);
    expect(Atomics.load(relay.state, 0)).toBe(2);
    // A park on current values waits on every word again.
    relay.park();
    expect(relay.waits).toHaveLength(6);
  } finally {
    await relay.close();
  }
});

test("a parked relay rewaits after a wake on a stale value without publishing", async () => {
  const relay = await controlledNotificationRelay();
  try {
    relay.park();
    expect(relay.waits).toHaveLength(3);
    // The word moved and the guest saw it before parking again; the stale wait then returns.
    Atomics.add(relay.words[0]!, 0, 1);
    relay.park();
    expect(Atomics.load(relay.state, 0)).toBe(0);
    relay.waits[0]!.resolve("not-equal");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Atomics.load(relay.state, 0)).toBe(0);
    expect(relay.waits).toHaveLength(4);
    relay.waits[3]!.resolve("ok");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Atomics.load(relay.state, 0)).toBe(1);
  } finally {
    await relay.close();
  }
});

test("a fenced relay stops publishing and disposes while its waits are pending", async () => {
  const words = [0, 1, 2].map(() => new Int32Array(new SharedArrayBuffer(4)));
  const { worker, channel, state, park } = await armRelay(relay, words);
  const disposed = new Promise<unknown>((resolve) => {
    worker.onmessage = ({ data }) => resolve(data);
  });
  try {
    park();
    await pause(50);
    // The page's dispose order (notification-relay.ts): fence, bump, then tell the relay.
    Atomics.store(state, 1, 1);
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
    const fenced = Atomics.load(state, 0);
    for (const word of words) {
      Atomics.add(word, 0, 1);
      Atomics.notify(word, 0);
    }
    await pause(100);
    expect(Atomics.load(state, 0)).toBe(fenced);
    channel.port2.postMessage({ type: "dispose" });
    expect(await disposed).toBe("disposed");
  } finally {
    channel.port2.close();
    worker.terminate();
  }
});

test.each(["resolve", "reject"])(
  "late wait %s cannot restore disposed relay roots",
  async (outcome) => {
    const relay = await controlledNotificationRelay();
    try {
      relay.park();
      expect(relay.waits).toHaveLength(3);
      expect(
        relay.inspect(
          "relay.pendingWaits.every((wait, slot) => wait === waits[slot].promise) && connections.size",
        ),
      ).toBe(1);
      relay.dispose();
      const fenced = Atomics.load(relay.state, 0);
      expect(relay.inspect("[relay.pendingWaits.length, connections.size].join(',')")).toBe("0,0");
      expect(relay.notices).toEqual(["disposed"]);
      if (outcome === "reject") relay.waits[0]!.reject(new Error("late wait rejection"));
      else relay.waits[0]!.resolve("ok");
      for (const wait of relay.waits.slice(1)) wait.resolve("ok");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(relay.inspect("[relay.pendingWaits.length, connections.size].join(',')")).toBe("0,0");
      expect(Atomics.load(relay.state, 0)).toBe(fenced);
      expect(relay.notices).toEqual(["disposed"]);
      expect(relay.waits).toHaveLength(3);
    } finally {
      await relay.close();
    }
  },
);
