// Calibrated, bounded CPU corpora shared by the real browser engine overhead gate.
// Timings are guest loop durations, not worker startup or module compilation.
export type InterruptionBenchmarkMode = "candidate-hooks" | "candidate-masked" | "pristine";
export interface CpuCorpus {
  name: string;
  source(iterations: number): string;
  checksum(iterations: number): number;
}
export const interruptionCpuCorpora: readonly CpuCorpus[] = [
  {
    name: "arithmetic-backedges",
    source: iterations => `let value=1; for(let i=0;i<${iterations};i++) value=(value*1664525+1013904223)>>>0;`,
    checksum(iterations) { let value = 1; for (let i = 0; i < iterations; i++) value = (value * 1664525 + 1013904223) >>> 0; return value; },
  },
  {
    name: "function-property-calls",
    source: iterations => `const object={value:1,step(amount){this.value=(this.value+amount)>>>0;return this.value;}}; function advance(object,i){return object.step((i&255)+1);} let value=1; for(let i=0;i<${iterations};i++) value=(advance(object,i)^i)>>>0;`,
    checksum(iterations) {
      const object = { value: 1, step(amount: number) { this.value = (this.value + amount) >>> 0; return this.value; } };
      function advance(object: { step(amount: number): number }, index: number) { return object.step((index & 255) + 1); }
      let value = 1; for (let i = 0; i < iterations; i++) value = (advance(object, i) ^ i) >>> 0; return value;
    },
  },
];
export function calibratedIterations(iterations: number, elapsedMs: number, targetMs: number): number {
  return Math.min(100_000_000, Math.max(100_000, Math.round(iterations * targetMs / Math.max(1, elapsedMs))));
}
function median(values: number[]): number { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]!; }
export interface InterruptionTiming { milliseconds: number; checksum: number; }
export async function measureInterruptionOverhead(run: (mode: InterruptionBenchmarkMode, source: string) => Promise<InterruptionTiming>, pristine: boolean): Promise<object> {
  const modes: InterruptionBenchmarkMode[] = pristine ? ["candidate-hooks", "candidate-masked", "pristine"] : ["candidate-hooks", "candidate-masked"];
  const targetMs = 1_000, calibrationIterations = 1_000_000, measuredPairs = 7;
  const corpora: object[] = [];
  for (const corpus of interruptionCpuCorpora) {
    const source = (iterations: number) => `const started=Date.now(); ${corpus.source(iterations)} console.log('BENCH',Date.now()-started,value);`;
    const calibration = await run("candidate-masked", source(calibrationIterations));
    if (calibration.checksum !== corpus.checksum(calibrationIterations)) throw new Error(`${corpus.name}: calibration checksum mismatch`);
    const iterations = calibratedIterations(calibrationIterations, calibration.milliseconds, targetMs);
    const checksum = corpus.checksum(iterations);
    const samples: { pair: number; mode: InterruptionBenchmarkMode; milliseconds: number }[] = [];
    for (let pair = 0; pair <= measuredPairs; pair++) for (const mode of pair % 2 ? modes.toReversed() : modes) {
      const timing = await run(mode, source(iterations));
      if (timing.checksum !== checksum) throw new Error(`${corpus.name} ${mode}: corpus checksum mismatch`);
      if (!Number.isFinite(timing.milliseconds) || timing.milliseconds < 250) throw new Error(`${corpus.name} ${mode}: sample ${timing.milliseconds}ms too short for a small-overhead claim; calibration was ${calibration.milliseconds}ms at ${calibrationIterations} iterations`);
      if (pair > 0) samples.push({ pair, mode, milliseconds: timing.milliseconds });
    }
    const summaries = modes.map(mode => {
      const times = samples.filter(sample => sample.mode === mode).map(sample => sample.milliseconds);
      const meanMs = times.reduce((sum, time) => sum + time, 0) / times.length;
      const standardDeviationMs = Math.sqrt(times.reduce((sum, time) => sum + (time - meanMs) ** 2, 0) / (times.length - 1));
      return { mode, medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), meanMs, standardDeviationMs };
    });
    const medianMs = (mode: InterruptionBenchmarkMode) => summaries.find(summary => summary.mode === mode)!.medianMs;
    const pairs = Array.from({ length: measuredPairs }, (_, index) => {
      const pair = index + 1;
      const duration = (mode: InterruptionBenchmarkMode) => samples.find(sample => sample.pair === pair && sample.mode === mode)!.milliseconds;
      return { pair, hostPollingRatio: duration("candidate-hooks") / duration("candidate-masked"),
        totalPatchRatio: pristine ? duration("candidate-hooks") / duration("pristine") : undefined };
    });
    corpora.push({ name: corpus.name, targetMs, iterations, checksum, calibration, warmupPairs: 1, measuredPairs, samples, summaries, pairs,
      hostPollingRatio: medianMs("candidate-hooks") / medianMs("candidate-masked"),
      totalPatchRatio: pristine ? medianMs("candidate-hooks") / medianMs("pristine") : undefined });
  }
  return { corpora, method: "two calibrated ~1s CPU corpora; one warmup and seven measured pairs per corpus; alternating mode order; guest Date.now duration; no probe work in timed checkpoint imports; candidate-masked isolates host polling, optional pristine artifact measures total patch overhead; raw samples and paired ratios retained" };
}
