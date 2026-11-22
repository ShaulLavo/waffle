import { atomicsWaitAsync, atomicsWaitAsyncFor } from "../../proc/intrinsics.ts";

export interface WaitAsyncWaiterRequest {
  readonly word: SharedArrayBuffer;
  readonly progress: SharedArrayBuffer;
  readonly mode: "native" | "settled";
  readonly waits: number;
  readonly longWaits: number;
  readonly timeout: number;
  readonly longTimeout: number;
}

// Loops timed waits on a word another Worker keeps notifying, counting every settled wait.
self.onmessage = async ({ data }: MessageEvent<WaitAsyncWaiterRequest>) => {
  const word = new Int32Array(data.word);
  const progress = new Int32Array(data.progress);
  const wait = data.mode === "native" ? atomicsWaitAsync : atomicsWaitAsyncFor;
  const run = async (count: number, timeout: number) => {
    for (let index = 0; index < count; index++) {
      const waiting = wait(word, 0, Atomics.load(word, 0), timeout);
      if (waiting.async) await waiting.value;
      else await new Promise((resolve) => setTimeout(resolve, 0));
      Atomics.add(progress, 0, 1);
    }
  };
  await run(data.waits, data.timeout);
  // After WebKit loses a wake, later waits in the same Worker can stall too; a long-timeout wait
  // models a loop that rechecks its state rarely, and it must keep moving through the helper.
  await run(data.longWaits, data.longTimeout);
  self.postMessage("done");
  self.close();
};
