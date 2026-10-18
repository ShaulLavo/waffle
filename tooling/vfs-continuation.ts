import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The recorded revision must execute this independently reviewed helper, not just
// an identically named file with arbitrary behavior. Capture it before any audit.
const AUDITED_HELPER = readFileSync(fileURLToPath(import.meta.url), "utf8");
import { BROWSERS, WORKLOADS, LANES, SCORE_PROTOCOL, primaryMetrics, type BrowserName, type Workload, type Lane } from "./vfs-score-config.js";
import { cellKey, type Sample } from "./vfs-score.js";

export const BASELINE_CELLS = BROWSERS.flatMap(browser => ["indexeddb", "opfs-memory"].flatMap(vfs => WORKLOADS.flatMap(workload => LANES.map(lane => `${browser}/${vfs}/${workload}/${lane}`))));
export function parseCells(value: string): Set<string> {
  const keys = value.split(","), allowed = new Set(BASELINE_CELLS);
  if (!keys.length || new Set(keys).size !== keys.length || keys.some(key => !allowed.has(key))) throw new Error(`Invalid cell selection ${value}`);
  return new Set(keys);
}
export function assertSelectionScope(cells: ReadonlySet<string>, browsers: readonly BrowserName[], workloads: readonly Workload[], lanes: readonly Lane[]): void {
  for (const key of cells) {
    const [browser, , workload, lane] = key.split("/");
    if (!browsers.includes(browser as BrowserName) || !workloads.includes(workload as Workload) || !lanes.includes(lane as Lane)) throw new Error(`Cell ${key} falls outside the other selections`);
  }
}

/** These exact insertions are the entire permitted controller delta. In particular,
 * none changes a fixture, browser request, measured interval, repetition or cleanup. */
export const CONTROLLER_EDITS: readonly (readonly [string, string])[] = [
  ['const PREFIX = "VFS_EVIDENCE ";', 'import { parseCells, assertSelectionScope, compareContinuation } from "./vfs-continuation.js";\n\nconst PREFIX = "VFS_EVIDENCE ";'],
  ['lanes: Lane[]; mode:', 'lanes: Lane[]; cells?: Set<string>; continuationOf?: string; mode:'],
  ['    else if (flag === "--lanes") options.lanes = list(value, LANES);', '    else if (flag === "--lanes") options.lanes = list(value, LANES);\n    else if (flag === "--cells") options.cells = parseCells(value);\n    else if (flag === "--continuation-of") options.continuationOf = value;'],
  ['  return options;\n}', '  if (options.cells) assertSelectionScope(options.cells, options.browsers, options.workloads, options.lanes);\n  if (options.continuationOf && !options.cells) throw new Error("Continuation requires an explicit --cells selection");\n  return options;\n}'],
  ['  const lifecycle = new BrowserRunnerLifecycle(3_500_000); const samples: Sample[] = [];', '  const continuation = options.continuationOf ? compareContinuation(resolve(import.meta.dir, ".."), options.continuationOf, options.revision) : undefined;\n  const lifecycle = new BrowserRunnerLifecycle(3_500_000); const samples: Sample[] = [];'],
  ['selections: { browsers: options.browsers, workloads: options.workloads, lanes: options.lanes }, intervals:', 'selections: { browsers: options.browsers, workloads: options.workloads, lanes: options.lanes, cells: options.cells ? Array.from(options.cells) : undefined }, continuation, intervals:'],
  ['["vfs-workloads.ts", "vfs-score-config.ts", "vfs-guest.ts", "vfs-browser.ts", "vfs-benchmark.ts"]', '["vfs-workloads.ts", "vfs-score-config.ts", "vfs-guest.ts", "vfs-browser.ts", "vfs-benchmark.ts", "vfs-continuation.ts"]'],
  ['      for (const workload of options.workloads) for (const lane of options.lanes) {\n        const templates', '      for (const workload of options.workloads) for (const lane of options.lanes) {\n        if (options.cells && !options.cells.has(`${browser}/${vfs}/${workload}/${lane}`)) continue;\n        const templates'],
];
export function controllerWithSelection(source: string): string {
  for (const [before, after] of CONTROLLER_EDITS) {
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("Baseline controller does not have the exact audited selection insertion points");
    source = source.replace(before, after);
  }
  return source;
}
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", resolve(root)].concat(args), { encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024 }); }
export function compareContinuation(root: string, baseline: string, revision: string) {
  for (const value of [baseline, revision]) if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Continuation comparisons require immutable full Git commits");
  if (git(root, "rev-parse", `${baseline}^{commit}`).trim() !== baseline || git(root, "rev-parse", `${revision}^{commit}`).trim() !== revision) throw new Error("Continuation commit identity mismatch");
  git(root, "merge-base", "--is-ancestor", baseline, revision);
  const changedFiles = git(root, "diff", "--no-ext-diff", "--name-only", baseline, revision).trim().split("\n").filter(Boolean);
  const permitted = new Set(["tooling/vfs-benchmark.ts", "tooling/vfs-continuation.ts", "tests/vfs-continuation.test.ts"]);
  if (!changedFiles.includes("tooling/vfs-benchmark.ts") || changedFiles.some(path => !permitted.has(path))) throw new Error(`Continuation changes a measured or non-orchestration path: ${changedFiles.join(", ")}`);
  for (const entry of git(root, "ls-tree", revision, "--", ...Array.from(permitted)).trim().split("\n")) {
    if (!entry.startsWith("100644 blob ")) throw new Error("Continuation orchestration must use ordinary non-executable source files");
  }
  if (git(root, "show", `${revision}:tooling/vfs-continuation.ts`) !== AUDITED_HELPER) throw new Error("Continuation helper differs from the executing reviewed helper");
  const original = git(root, "show", `${baseline}:tooling/vfs-benchmark.ts`);
  const controller = git(root, "show", `${revision}:tooling/vfs-benchmark.ts`);
  if (controller !== controllerWithSelection(original)) throw new Error("Continuation controller differs outside the exact audited selection/orchestration insertions");
  return {
    protocol: "waffle-vfs-continuation-1", completesRevision: baseline, revision,
    purpose: `Complete only missing cells of ${baseline}; never rerun completed cells or pool partial repetitions`,
    changedFiles, sourceDiff: git(root, "diff", "--no-ext-diff", "--binary", baseline, revision),
    measuredPathEquivalent: true,
  };
}
function groups(rows: readonly Sample[], revision: string): Map<string, Sample[]> {
  if (new Set(rows.map(row => row.campaign)).size > 1) throw new Error("An input archive mixes campaign identities");
  const result = new Map<string, Sample[]>();
  for (const row of rows) {
    if (row.protocol !== SCORE_PROTOCOL || row.revision !== revision || !BASELINE_CELLS.includes(cellKey(row))) throw new Error("Unexpected baseline sample identity");
    if (!((row.warmup === true && [-2, -1].includes(row.repetition)) || (row.warmup === false && [0, 1, 2, 3, 4].includes(row.repetition)))) throw new Error("Invalid screening repetition/warmup identity");
    const key = cellKey(row), values = result.get(key) ?? [];
    if (values.some(value => value.repetition === row.repetition && value.warmup === row.warmup)) throw new Error(`Duplicate repetition in ${key}`);
    values.push(row); result.set(key, values);
  }
  return result;
}
function complete(rows: readonly Sample[]): boolean {
  return rows.length === 7 && rows.every(row => row.state === "eligible" && primaryMetrics(row.workload, row.vfs).every(metric => Number.isFinite(row.metrics[metric.name]) && row.metrics[metric.name]! > 0))
    && [-2, -1].every(repetition => rows.some(row => row.warmup && row.repetition === repetition))
    && [0, 1, 2, 3, 4].every(repetition => rows.some(row => !row.warmup && row.repetition === repetition));
}
/** Select only interrupted/absent cells; correctness and environment failures are
 * history, not permission to retry until a favorable result appears. */
export function missingBaselineCells(original: readonly Sample[], baseline: string) {
  const before = groups(original, baseline);
  const completedCells: string[] = [], missingCells: string[] = [], blockedCells: string[] = [];
  for (const key of BASELINE_CELLS) {
    const rows = before.get(key) ?? [];
    if (complete(rows)) completedCells.push(key);
    else {
      const blocked = rows.length >= 7 || rows.some(row => {
        if (row.state === "invalid environment" && row.reason?.startsWith("controller-interrupted:")) return false;
        return row.state !== "eligible" || !primaryMetrics(row.workload, row.vfs).every(metric => Number.isFinite(row.metrics[metric.name]) && row.metrics[metric.name]! > 0);
      });
      if (blocked) blockedCells.push(key); else missingCells.push(key);
    }
  }
  return { completedCells, missingCells, blockedCells };
}
/** Assemble an initial archive, never a promotion candidate. Original partial history
 * remains separate and visible; it cannot be pooled into a continuation's five samples. */
export function assembleBaseline(root: string, baseline: string, revision: string, original: readonly Sample[], continued: readonly Sample[]) {
  const provenance = compareContinuation(root, baseline, revision);
  const before = groups(original, baseline), after = groups(continued, revision);
  const selection = missingBaselineCells(original, baseline);
  const all = original.concat(continued);
  if (new Set(all.map(row => row.runner)).size > 1) throw new Error("Continuation changed the benchmark runner");
  for (const browser of BROWSERS) if (new Set(all.filter(row => row.browser === browser && row.browserVersion !== "unavailable").map(row => row.browserVersion)).size > 1) throw new Error(`Continuation changed ${browser}'s version`);
  let samples: Sample[] = [], incompleteHistory: Sample[] = [];
  const completedCells: string[] = [];
  for (const key of BASELINE_CELLS) {
    const old = before.get(key) ?? [], next = after.get(key) ?? [];
    if (complete(old) && next.length) throw new Error(`Continuation reran completed cell ${key}`);
    if (next.length && selection.blockedCells.includes(key)) throw new Error(`Continuation would retry a failed/invalid cell ${key}`);
    if (next.length) { incompleteHistory = incompleteHistory.concat(old); samples = samples.concat(next); if (complete(next)) completedCells.push(key); }
    else { samples = samples.concat(old); if (complete(old)) completedCells.push(key); }
  }
  return { provenance, campaignState: completedCells.length === BASELINE_CELLS.length ? "complete existing-backend baseline" : "incomplete", samples, incompleteHistory, completedCells, missingCells: BASELINE_CELLS.filter(key => !completedCells.includes(key)) };
}
if (import.meta.main) {
  const [root, baseline, revision, original, continued, output] = process.argv.slice(2);
  if (!root || !baseline || !revision || !original || !continued || !output) throw new Error("Usage: bun tooling/vfs-continuation.ts REPOSITORY BASE_SHA CONTINUATION_SHA ORIGINAL.json CONTINUED.json EXTERNAL_OUTPUT.json");
  const destination = resolve(output), repo = resolve(root), own = resolve(import.meta.dir, "..");
  if ([repo, own].some(path => destination === path || destination.startsWith(`${path}/`))) throw new Error("Evidence must remain outside repositories");
  if (await Bun.file(destination).exists()) throw new Error("Refusing to overwrite an immutable baseline archive");
  const load = async (path: string): Promise<Sample[]> => { const data = await Bun.file(path).json(); return Array.isArray(data) ? data : data.samples; };
  const result = assembleBaseline(root, baseline, revision, await load(original), await load(continued));
  await Bun.write(destination, JSON.stringify(result, null, 2));
}
