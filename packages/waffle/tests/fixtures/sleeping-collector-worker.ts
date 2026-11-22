import { atomicsWait } from "../../proc/intrinsics/core.ts";

// docs/webkit-blocking-waits.md. A sleeper builds a large heap and blocks at once, so a
// collection cycle over that heap is open while it sleeps. A starter allocates across several
// event-loop turns, as a process Worker that awaits its imports does, then creates Wasm
// memories the way a process start does.

export interface SleepingCollectorRequest {
  readonly role: "sleeper" | "starter";
  /** "waffle" sleeps through the runtime's wait, "native" through the engine's own. */
  readonly wait: "waffle" | "native";
  readonly cells: SharedArrayBuffer;
  /** Heap size in units of about half a megabyte. */
  readonly size: number;
}

export type SleepingCollectorMessage =
  | { readonly step: "sleeping" | "creating" }
  | { readonly step: "started"; readonly ms: number };

function build(size: number): unknown[] {
  const keep: unknown[] = [];
  for (let index = 0; index < size * 4000; index++)
    keep.push({ a: index, b: [index], c: `x${index}` });
  return keep;
}

const post = (message: SleepingCollectorMessage) => globalThis.postMessage(message);

async function start(keep: unknown[]): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    keep.push(build(1));
  }
  post({ step: "creating" });
  const began = performance.now();
  for (let round = 0; round < 3; round++) {
    keep.push(new WebAssembly.Memory({ initial: 1 }));
    keep.push(build(1));
  }
  post({ step: "started", ms: performance.now() - began });
}

globalThis.onmessage = ({ data }: MessageEvent<SleepingCollectorRequest>) => {
  const keep = build(data.size);
  if (data.role === "starter") {
    void start(keep);
    return;
  }
  post({ step: "sleeping" });
  const cells = new Int32Array(data.cells);
  if (data.wait === "waffle") atomicsWait(cells, 0, 0);
  else Atomics.wait(cells, 0, 0);
  // Keeps the heap reachable for as long as the sleeper lives.
  post({ step: "sleeping" });
  keep.length = 0;
};
