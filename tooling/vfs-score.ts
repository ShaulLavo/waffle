import { BROWSERS, LANES, WORKLOADS, VFS_NAMES, SCORE_PROTOCOL, SAMPLING, FIXTURE_SEED, expectedState, primaryMetrics, MAXIMUM_REGRESSION, MINIMUM_GAIN, type BrowserName, type VfsName, type Workload, type Lane, type Eligibility } from "./vfs-score-config.js";

export interface Sample {
  protocol: typeof SCORE_PROTOCOL;
  revision: string;
  campaign: string;
  runner: string;
  browser: BrowserName;
  browserVersion: string;
  vfs: VfsName;
  workload: Workload;
  lane: Lane;
  repetition: number;
  warmup: boolean;
  state: Eligibility;
  reason?: string;
  metrics: Record<string, number>;
  /** Operation distributions retain the raw observations, not just percentiles. */
  latencies?: Record<string, number[]>;
  acknowledgements?: { operation: number; elapsedMs: number }[];
  observations?: Record<string, unknown>;
  pair?: number;
  role?: "baseline" | "candidate";
}
export function median(values: readonly number[]): number {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error("Expected finite, nonempty observations");
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length || fraction <= 0 || fraction > 1) throw new Error("Invalid percentile");
  return values.toSorted((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]!;
}
export function geometric(values: readonly { ratio: number; weight: number }[]): number {
  if (!values.length || values.some(v => !(v.ratio > 0) || !Number.isFinite(v.ratio) || !(v.weight > 0))) throw new Error("Invalid geometric score");
  return Math.exp(values.reduce((sum, v) => sum + Math.log(v.ratio) * v.weight, 0) / values.reduce((sum, v) => sum + v.weight, 0));
}
/** Paired percentile bootstrap of the geometric mean ratio, fixed seed, 10,000 resamples.
 * Ratios are candidate cost/reference cost; an upper bound <=1.05 passes a guardrail.
 * Pairs, never independent baseline and candidate observations, are resampled. */
export function pairedInterval(reference: readonly number[], candidate: readonly number[]): { ratio: number; lower: number; upper: number; pairs: number } {
  if (reference.length !== candidate.length || reference.length < 9) throw new Error("Promotion needs at least nine paired observations");
  const logs = reference.map((value, i) => {
    const other = candidate[i]!;
    if (!(value > 0) || !(other > 0) || !Number.isFinite(value) || !Number.isFinite(other)) throw new Error("Nonpositive paired metric");
    return Math.log(other / value);
  });
  let seed = FIXTURE_SEED;
  const draws = Array.from({ length: 10_000 }, () => {
    let total = 0;
    for (let i = 0; i < logs.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; total += logs[(seed >>> 0) % logs.length]!; }
    return Math.exp(total / logs.length);
  });
  return { ratio: Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length), lower: percentile(draws, 0.025), upper: percentile(draws, 0.975), pairs: logs.length };
}
export function cellKey(row: Pick<Sample, "browser" | "vfs" | "workload" | "lane">): string { return `${row.browser}/${row.vfs}/${row.workload}/${row.lane}`; }
function group(rows: readonly Sample[]): Map<string, Sample[]> {
  const result = new Map<string, Sample[]>();
  for (const row of rows) {
    if (row.protocol !== SCORE_PROTOCOL) throw new Error(`Score protocol mismatch: ${row.protocol}`);
    if (row.warmup) continue;
    const key = cellKey(row); const entries = result.get(key) ?? []; entries.push(row); result.set(key, entries);
  }
  return result;
}
export interface CellScore { key: string; state: Eligibility; reason?: string; score?: number; raw: Record<string, { baseline: number; candidate: number; unit: string }>; guardrails: Record<string, ReturnType<typeof pairedInterval> & { pass: boolean }>; }
/** The initial baseline remains immutable. An accepted reference is a separate ratchet input.
 * Missing/failed cells are visible and make the fixed-mask score incomplete, never faster. */
export function score(initial: readonly Sample[], candidate: readonly Sample[], accepted?: readonly Sample[]) {
  const bases = group(initial), next = group(candidate), ratchet = accepted ? group(accepted) : undefined;
  const cells: CellScore[] = [];
  for (const vfs of VFS_NAMES) for (const browser of BROWSERS) for (const workload of WORKLOADS) for (const lane of LANES) {
    const key = cellKey({ browser, vfs, workload, lane });
    const a = bases.get(key) ?? [], b = next.get(key) ?? [];
    const cell: CellScore = { key, state: "deferred/not measured", raw: {}, guardrails: {} }; cells.push(cell);
    if (expectedState(browser, vfs) !== "supported") {
      cell.state = b.length && b.every(r => r.state === "unsupported as specified") ? "unsupported as specified" : "deferred/not measured";
      cell.reason = "Typed unsupported assertions are required; absence is not success"; continue;
    }
    // Keep every environmental and correctness outcome. There is no pass by retry.
    const bad = a.concat(b).find(r => r.state !== "eligible");
    if (bad) { cell.state = bad.state; cell.reason = bad.reason; continue; }
    if (a.length < SAMPLING.screening.repetitions || b.length < SAMPLING.screening.repetitions) { cell.reason = "Needs five measured repetitions in both inputs"; continue; }
    if (new Set(a.map(r => r.repetition)).size !== a.length || new Set(b.map(r => r.repetition)).size !== b.length) throw new Error(`Duplicate repetition in ${key}`);
    if (new Set(a.concat(b).map(r => `${r.runner}/${r.browserVersion}`)).size !== 1) { cell.state = "invalid environment"; cell.reason = "Different runner or browser version"; continue; }
    const ratios: { ratio: number; weight: number }[] = [];
    for (const metric of primaryMetrics(workload, vfs)) {
      if (a.concat(b).some(r => !(r.metrics[metric.name]! > 0) || !Number.isFinite(r.metrics[metric.name]))) { cell.reason = `Missing primary metric ${metric.name}`; break; }
      const baseline = median(a.map(r => r.metrics[metric.name]!)), value = median(b.map(r => r.metrics[metric.name]!));
      cell.raw[metric.name] = { baseline, candidate: value, unit: metric.unit };
      ratios.push({ ratio: metric.direction === "lower" ? baseline / value : value / baseline, weight: metric.weight });
    }
    if (ratios.length !== primaryMetrics(workload, vfs).length) continue;
    cell.state = "eligible"; cell.score = 100 * geometric(ratios);
    if (ratchet && vfs === "indexeddb") {
      const ref = ratchet.get(key) ?? [];
      if (ref.length !== b.length || b.length < 9 || ref.concat(b).some(r => r.pair === undefined || r.state !== "eligible") || new Set(ref.map(r => r.pair)).size !== ref.length || new Set(b.map(r => r.pair)).size !== b.length || new Set(ref.concat(b).map(r => `${r.runner}/${r.browserVersion}/${r.campaign}`)).size !== 1) { cell.reason = "Ratchet requires nine adjacent same-campaign pairs"; continue; }
      const paired = b.toSorted((x, y) => x.pair! - y.pair!), references = ref.toSorted((x, y) => x.pair! - y.pair!);
      if (paired.some((r, i) => r.pair !== references[i]!.pair)) { cell.reason = "Pair identities differ"; continue; }
      for (const metric of primaryMetrics(workload, vfs)) {
        const costs = (rows: Sample[]) => rows.map(r => metric.direction === "lower" ? r.metrics[metric.name]! : 1 / r.metrics[metric.name]!);
        const ci = pairedInterval(costs(references), costs(paired)); cell.guardrails[metric.name] = { ...ci, pass: ci.upper <= MAXIMUM_REGRESSION };
      }
    }
  }
  const perVfs = Object.fromEntries(VFS_NAMES.map(vfs => {
    const fixed = cells.filter(c => c.key.split("/")[1] === vfs && !c.key.match(/^(firefox|webkit)\/opfs-wal\//));
    const eligible = fixed.filter(c => c.state === "eligible");
    const complete = eligible.length === fixed.length;
    const partialScore = eligible.length ? 100 * geometric(eligible.map(c => ({ ratio: c.score! / 100, weight: 1 }))) : null;
    return [vfs, { complete, eligible: eligible.length, required: fixed.length, score: complete ? partialScore : null, partialScore }];
  }));
  const complete = VFS_NAMES.every(vfs => perVfs[vfs]!.complete);
  const familyScore = complete ? 100 * geometric(VFS_NAMES.map(vfs => ({ ratio: perVfs[vfs]!.score! / 100, weight: 1 }))) : null;
  const guarded = cells.filter(c => c.key.split("/")[1] === "indexeddb");
  const guardrailsPass = !!ratchet && guarded.every(c => c.state === "eligible" && Object.keys(c.guardrails).length === primaryMetrics(c.key.split("/")[2] as Workload, "indexeddb").length && Object.values(c.guardrails).every(g => g.pass));
  return { protocol: SCORE_PROTOCOL, cells, perVfs, family: { complete, score: familyScore }, guardrailsPass, scoreImprovesFivePercent: complete && familyScore! >= MINIMUM_GAIN * 100, decision: "Score alone does not certify correctness, required capabilities or maintenance cost. An incomplete score cannot promote a candidate." };
}

if (import.meta.main) {
  const [baseline, candidate, accepted] = process.argv.slice(2);
  if (!baseline || !candidate) throw new Error("Usage: bun tooling/vfs-score.ts INITIAL.json CANDIDATE.json [ACCEPTED-PAIRED.json]");
  const load = async (path: string): Promise<Sample[]> => { const data = await Bun.file(path).json(); return Array.isArray(data) ? data : data.samples; };
  console.log(JSON.stringify(score(await load(baseline), await load(candidate), accepted ? await load(accepted) : undefined), null, 2));
}
