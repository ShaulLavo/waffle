import { atomicsWaitAsync, atomicsWaitAsyncFor } from "../../proc/intrinsics.ts";

export interface WaitAsyncWaiterRequest {
  readonly word: SharedArrayBuffer;
  readonly progress: SharedArrayBuffer;
  readonly mode: "native" | "settled";
  readonly waits: number;
  readonly untimed: number;
  readonly timeout: number;
}

// Loops timed waits on a word another Worker keeps notifying, counting every settled wait.
self.onmessage = async ({ data }: MessageEvent<WaitAsyncWaiterRequest>) => {
  const word = new Int32Array(data.word);
  const progress = new Int32Array(data.progress);
  const wait = data.mode === "native" ? atomicsWaitAsync : atomicsWaitAsyncFor;
  for (let index = 0; index < data.waits; index++) {
    const waiting = wait(word, 0, Atomics.load(word, 0), data.timeout);
    if (waiting.async) await waiting.value;
    else await new Promise((resolve) => setTimeout(resolve, 0));
    Atomics.add(progress, 0, 1);
  }
  // WebKit's lost timed wait also stops later untimed waits in the same Worker from waking it.
  for (let index = 0; index < data.untimed; index++) {
    const waiting = atomicsWaitAsync(word, 0, Atomics.load(word, 0));
    if (waiting.async) await waiting.value;
    Atomics.add(progress, 0, 1);
  }
  self.postMessage("done");
  self.close();
};
