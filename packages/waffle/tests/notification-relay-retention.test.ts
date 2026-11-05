import { expect, test } from "bun:test";

const collectingRelay = new URL("./fixtures/notification-collecting-worker.ts", import.meta.url)
  .href;

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
  return { worker, channel, state };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bumps `word` and waits up to 1 s for the relay to publish the change. */
async function forwarded(state: Int32Array, word: Int32Array): Promise<boolean> {
  const sequence = Atomics.load(state, 0);
  Atomics.add(word, 0, 1);
  Atomics.notify(word, 0);
  const waiting = Atomics.waitAsync(state, 0, sequence, 1000);
  const result = waiting.async ? await waiting.value : waiting.value;
  return result !== "timed-out";
}

async function lostWords(
  state: Int32Array,
  words: readonly Int32Array[],
  round: number,
): Promise<string[]> {
  const lost: string[] = [];
  for (const [index, word] of words.entries())
    if (!(await forwarded(state, word))) lost.push(`round ${round} word ${index}`);
  return lost;
}

// Guards forwarding under continuous full collections. Bun's engine kept forwarding even before the
// relay retained its waits, so this does not reproduce the iOS Safari 26.5 loss; that was observed
// only on the device.
test("the relay keeps forwarding every armed word while full collections run", async () => {
  const words = [0, 1, 2].map(() => new Int32Array(new SharedArrayBuffer(4)));
  const { worker, channel, state } = await armRelay(collectingRelay, words);
  let lost: string[] = [];
  try {
    for (let round = 0; round < 40 && lost.length === 0; round++) {
      // Leave the relay idle in its waits while collections run.
      await pause(25);
      lost = await lostWords(state, words, round);
    }
  } finally {
    channel.port2.close();
    worker.terminate();
  }
  expect(lost).toEqual([]);
}, 30000);
