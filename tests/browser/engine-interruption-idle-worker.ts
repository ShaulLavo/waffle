// Real native Atomics.wait fixture for the harness's causal-wake controls. No WASM.
import { observeEventLoopWait } from "./engine-interruption-probe";
const context = self as unknown as DedicatedWorkerGlobalScope;
context.onmessage = (event: MessageEvent<{ evidence: SharedArrayBuffer; budget: SharedArrayBuffer }>) => {
  const probe = new Int32Array(event.data.evidence), cells = new Int32Array(event.data.budget);
  const restore = observeEventLoopWait(probe, new Int32Array(event.data.budget, 4, 1), Atomics, 1_000);
  try { Atomics.wait(cells, 1, 0, 4); }
  finally { restore(); }
};
