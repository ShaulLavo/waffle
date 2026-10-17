import { expect, test } from "bun:test";
import { calibratedIterations, interruptionCpuCorpora, measureInterruptionOverhead, type InterruptionBenchmarkMode } from "./engine-interruption-benchmark";

for (const corpus of interruptionCpuCorpora) test(`${corpus.name} guest source agrees with the host checksum`, () => {
  for (const iterations of [1, 1000, 20_000]) {
    const actual = new Function(`${corpus.source(iterations)} return value;`)();
    expect(actual).toBe(corpus.checksum(iterations));
  }
});
test("iteration calibration targets long samples but caps work on every engine", () => {
  expect(calibratedIterations(1_000_000, 250, 1000)).toBe(4_000_000);
  expect(calibratedIterations(1_000_000, 0, 1000)).toBe(100_000_000);
  expect(calibratedIterations(1_000_000, 100_000, 1000)).toBe(100_000);
});
test("overhead runner preserves two corpora, all three modes, seven raw pairs and warmup", async () => {
  const calls: InterruptionBenchmarkMode[] = [];
  const checksums = new Map<string, number>();
  const report = await measureInterruptionOverhead(async (mode, source) => {
    calls.push(mode);
    const match = /i<(\d+)/.exec(source);
    if (!match) throw new Error("benchmark source lacks a bounded CPU loop");
    const iterations = Number(match[1]);
    const corpus = interruptionCpuCorpora[source.includes("const object=") ? 1 : 0]!;
    const key = `${corpus.name}:${iterations}`;
    let checksum = checksums.get(key);
    if (checksum === undefined) { checksum = corpus.checksum(iterations); checksums.set(key, checksum); }
    return { checksum, milliseconds: mode === "candidate-hooks" ? 1010 : 1000 };
  }, true);
  expect(calls.length).toBe(50); // Two corpora × (calibration + eight three-mode pairs).
  expect(calls.filter(mode => mode === "pristine").length).toBe(16);
  expect("corpora" in report && Array.isArray(report.corpora)).toBe(true);
  if (!("corpora" in report) || !Array.isArray(report.corpora)) throw new Error("missing corpora");
  for (const corpus of report.corpora) {
    expect(corpus.samples.length).toBe(21);
    expect(corpus.measuredPairs).toBe(7);
    expect(corpus.totalPatchRatio).toBe(1.01);
    expect(corpus.pairs.length).toBe(7);
  }
});
