import { expect, test } from "bun:test";
import { assertCausalIdleWake, probeCell, probeLength, snapshotProbe, suppressBudgetNotifications } from "./engine-interruption-probe";

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_500;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("native causal-wake fixture timed out");
    await Bun.sleep(1);
  }
}
async function nativeWaitTrial(suppressed: boolean) {
  // Own one short-lived worker and two shared buffers. Arm teardown before spawn.
  const evidence = new SharedArrayBuffer(probeLength * 4), probe = new Int32Array(evidence);
  const budget = new SharedArrayBuffer(16), cells = new Int32Array(budget);
  let worker: Worker | undefined;
  let mutation: ReturnType<typeof suppressBudgetNotifications> | undefined;
  const deadline = setTimeout(() => worker?.terminate(), 3_000);
  try {
    worker = new Worker(new URL("./engine-interruption-idle-worker.ts", import.meta.url).href);
    worker.postMessage({ evidence, budget });
    await until(() => Atomics.load(probe, probeCell.idleWaiting) === 1);
    const generation = Atomics.load(probe, probeCell.idleWaitActiveGeneration);
    await Bun.sleep(20);
    expect(Atomics.load(probe, probeCell.idleWaitActiveGeneration)).toBe(generation);
    expect(Atomics.load(probe, probeCell.idleWaiting)).toBe(1);
    Atomics.store(probe, probeCell.idleWaitSampleGeneration, generation);
    if (suppressed) mutation = suppressBudgetNotifications(new Int32Array(budget, 4, 1));
    const started = performance.now();
    Atomics.add(cells, 1, 1); // Wake generation publication alone must not wake a sleeper.
    Atomics.notify(cells, 1);
    await until(() => Atomics.load(probe, probeCell.idleWaitSampleCompleted) === generation);
    return { generation, elapsedMs: performance.now() - started, evidence: snapshotProbe(probe), suppressed: mutation?.count() ?? 0 };
  } finally { mutation?.restore(); clearTimeout(deadline); await worker?.terminate(); }
}

test("causal idle control wakes the sampled 1s native wait generation with notify", async () => {
  const result = await nativeWaitTrial(false);
  console.log(JSON.stringify({ control: "native-notify-enabled", elapsedMs: result.elapsedMs, sampledResult: result.evidence.idleWaitSampleResult }));
  expect(() => assertCausalIdleWake(result.evidence, result.generation)).not.toThrow();
  expect(result.evidence.idleWaitSampleResult).toBe(1); // Native ok, not timed-out/not-equal.
  expect(result.evidence.idleWaitOk).toBe(1);
  expect(result.elapsedMs).toBeLessThan(500);
}, 5_000);

test("mutation-negative notify removal fails the same causal admission despite changed wake generation", async () => {
  const result = await nativeWaitTrial(true);
  console.log(JSON.stringify({ control: "native-notify-removed-mutant", elapsedMs: result.elapsedMs, sampledResult: result.evidence.idleWaitSampleResult, suppressed: result.suppressed }));
  expect(result.suppressed).toBe(1);
  expect(() => assertCausalIdleWake(result.evidence, result.generation)).toThrow("did not return native ok");
  expect(result.evidence.idleWaitSampleResult).toBe(2); // The actual 1s wait timed out.
  expect(result.evidence.idleWaitTimedOut).toBe(1);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
}, 5_000);
