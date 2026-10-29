import "../../search/shard-worker.ts";
import type { ShardRequest } from "../../search/shards.ts";

// The real shard worker with one fault injected into helper slot 0, selected by ?mode=.
// stop-throws: its stop handler throws and it keeps running.
// silent: it closes itself right after ready, so it never answers again.
// mute: it ignores stop and keeps running.
// lose-batch: it closes itself when its first batch arrives.
const mode = new URLSearchParams(location.search).get("mode");
const real = globalThis.onmessage!;
let faulty = false;
globalThis.onmessage = (event: MessageEvent<ShardRequest>) => {
  const data = event.data;
  if (data.type === "start") faulty = data.slot === 0;
  if (!faulty) return Reflect.apply(real, globalThis, [event]);
  if (data.type === "stop" && mode === "stop-throws") throw new Error("injected stop failure");
  if (data.type === "stop" && mode === "mute") return;
  if (data.type === "batch" && mode === "lose-batch") return close();
  Reflect.apply(real, globalThis, [event]);
  if (data.type === "start" && mode === "silent") close();
};
