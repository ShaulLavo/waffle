import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { BASELINE_CELLS, CONTROLLER_EDITS, parseCells, assertSelectionScope, controllerWithSelection, compareContinuation, assembleBaseline, missingBaselineCells } from "../tooling/vfs-continuation.js";
import type { Sample } from "../tooling/vfs-score.js";
import { SCORE_PROTOCOL } from "../tooling/vfs-score-config.js";

function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8", stdio: "pipe" }).trim(); }
async function repository() {
  const root = await mkdtemp(resolve(tmpdir(), "vfs-continuation-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.name", "VFS fixture"); git(root, "config", "user.email", "fixture@example.test");
    await mkdir(resolve(root, "tooling")); await mkdir(resolve(root, "fs"));
    // A synthetic text controller exercises every exact insertion without depending
    // on old history being present in a shallow CI checkout. It is never executed.
    const controller = CONTROLLER_EDITS.map(([before]) => before).join("\n").concat("\n// measured clock stays unchanged\n");
    await writeFile(resolve(root, "tooling/vfs-benchmark.ts"), controller);
    await writeFile(resolve(root, "fs/indexeddb.ts"), "// unchanged storage\n");
    await writeFile(resolve(root, "tooling/vfs-workloads.ts"), "// unchanged fixture\n");
    git(root, "add", "."); git(root, "commit", "-qm", "baseline"); const baseline = git(root, "rev-parse", "HEAD");
    await writeFile(resolve(root, "tooling/vfs-benchmark.ts"), controllerWithSelection(controller));
    await writeFile(resolve(root, "tooling/vfs-continuation.ts"), await readFile(resolve(import.meta.dir, "../tooling/vfs-continuation.ts"), "utf8"));
    git(root, "add", "."); git(root, "commit", "-qm", "selection only"); const revision = git(root, "rev-parse", "HEAD");
    return { root, controller, baseline, revision, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
function rows(revision: string, workload: "W1" | "W2", campaign = "original"): Sample[] {
  return [-2, -1, 0, 1, 2, 3, 4].map(repetition => ({ protocol: SCORE_PROTOCOL, revision, campaign, runner: "fixed-runner", browser: "chromium", browserVersion: "156", vfs: "opfs-memory", workload, lane: "host", repetition, warmup: repetition < 0, state: "eligible", metrics: { readinessMs: 2, firstUseMs: 1, durableInstallMs: 85_700 } }));
}
test("exact cell selection rejects empty, duplicate, unimplemented and out-of-scope cells", () => {
  expect(BASELINE_CELLS.length).toBe(60);
  expect(parseCells("chromium/opfs-memory/W2/guest").size).toBe(1);
  expect(parseCells(BASELINE_CELLS.join(",")).size).toBe(60);
  for (const input of ["", "chromium/opfs-safe/W2/host", "chromium/opfs-memory/W6/host", "chromium/opfs-memory/W2/host,chromium/opfs-memory/W2/host", "chromium/opfs-memory/W2/host,"]) expect(() => parseCells(input)).toThrow();
  const cells = parseCells("chromium/opfs-memory/W2/guest");
  expect(() => assertSelectionScope(cells, ["chromium"], ["W2"], ["guest"])).not.toThrow();
  expect(() => assertSelectionScope(cells, ["firefox"], ["W2"], ["guest"])).toThrow("outside");
  expect(() => assertSelectionScope(cells, ["chromium"], ["W1"], ["guest"])).toThrow("outside");
  expect(() => assertSelectionScope(cells, ["chromium"], ["W2"], ["host"])).toThrow("outside");
});
test("continuation audit permits exact selection edits and records the complete Git diff", async () => {
  const fixture = await repository();
  try {
    const result = compareContinuation(fixture.root, fixture.baseline, fixture.revision);
    expect(result.measuredPathEquivalent).toBe(true); expect(result.completesRevision).toBe(fixture.baseline);
    expect(result.changedFiles).toEqual(["tooling/vfs-benchmark.ts", "tooling/vfs-continuation.ts"]);
    expect(result.sourceDiff).toContain("diff --git a/tooling/vfs-benchmark.ts");
    expect(result.sourceDiff).toContain("diff --git a/tooling/vfs-continuation.ts");
    expect(() => compareContinuation(fixture.root, fixture.baseline.slice(0, 7), fixture.revision)).toThrow("full Git");
    expect(() => controllerWithSelection("unrecognized controller")).toThrow("exact audited");
  } finally { await fixture.close(); }
});
test("continuation audit binds executable helper bytes and rejects mode changes", async () => {
  const fixture = await repository();
  try {
    await writeFile(resolve(fixture.root, "tooling/vfs-continuation.ts"), "process.env.TMPDIR = '/different-profile-root';\n");
    git(fixture.root, "add", "."); git(fixture.root, "commit", "-qm", "invalid helper behavior");
    expect(() => compareContinuation(fixture.root, fixture.baseline, git(fixture.root, "rev-parse", "HEAD"))).toThrow("executing reviewed helper");
    git(fixture.root, "reset", "--hard", fixture.revision);
    for (const path of ["tooling/vfs-continuation.ts", "tooling/vfs-benchmark.ts"]) {
      git(fixture.root, "update-index", "--chmod=+x", path); git(fixture.root, "commit", "-qm", "invalid file mode");
      expect(() => compareContinuation(fixture.root, fixture.baseline, git(fixture.root, "rev-parse", "HEAD"))).toThrow("non-executable");
      git(fixture.root, "reset", "--hard", fixture.revision);
    }
  } finally { await fixture.close(); }
});
test("missing-cell selection retains successes and blocks failed or malformed history", () => {
  const revision = "a".repeat(40);
  const original = rows(revision, "W1").concat(rows(revision, "W2").slice(0, 3));
  const selected = missingBaselineCells(original, revision);
  expect(selected.completedCells).toEqual(["chromium/opfs-memory/W1/host"]);
  expect(selected.missingCells.length).toBe(59); expect(selected.blockedCells).toEqual([]);
  const interrupted = original.map(row => row.workload === "W2" ? { ...row, state: "invalid environment" as const, reason: "controller-interrupted: Target page, context or browser has been closed", metrics: {} } : row);
  expect(missingBaselineCells(interrupted, revision).missingCells).toContain("chromium/opfs-memory/W2/host");
  const sevenInterrupted = rows(revision, "W2").map(row => ({ ...row, state: "invalid environment" as const, reason: "controller-interrupted: Target page, context or browser has been closed", metrics: {} }));
  expect(missingBaselineCells(sevenInterrupted, revision).missingCells).toContain("chromium/opfs-memory/W2/host");
  expect(missingBaselineCells(interrupted, revision).blockedCells).not.toContain("chromium/opfs-memory/W2/host");
  const genuineFailure = interrupted.map((row, i) => i === interrupted.length - 1 ? { ...row, state: "failed correctness" as const } : row);
  expect(missingBaselineCells(genuineFailure, revision).blockedCells).toContain("chromium/opfs-memory/W2/host");
  const unrelatedEnvironment = interrupted.map(row => row.workload === "W2" ? { ...row, reason: "browser crashed unexpectedly" } : row);
  expect(missingBaselineCells(unrelatedEnvironment, revision).blockedCells).toContain("chromium/opfs-memory/W2/host");
  for (const broken of [original.map(row => row.workload === "W2" ? { ...row, state: "invalid environment" as const } : row), original.map(row => row.workload === "W2" ? { ...row, metrics: { durableInstallMs: 0 } } : row)]) {
    const selection = missingBaselineCells(broken, revision);
    expect(selection.blockedCells).toEqual(["chromium/opfs-memory/W2/host"]);
    expect(selection.missingCells).not.toContain("chromium/opfs-memory/W2/host");
  }
  expect(() => missingBaselineCells(original, "b".repeat(40))).toThrow("identity");
});
test("continuation audit rejects a clock edit even inside the allowed controller path", async () => {
  const fixture = await repository();
  try {
    await writeFile(resolve(fixture.root, "tooling/vfs-benchmark.ts"), controllerWithSelection(fixture.controller).replace("measured clock stays unchanged", "measured clock changed"));
    git(fixture.root, "add", "."); git(fixture.root, "commit", "-qm", "invalid timing edit");
    expect(() => compareContinuation(fixture.root, fixture.baseline, git(fixture.root, "rev-parse", "HEAD"))).toThrow("outside the exact");
  } finally { await fixture.close(); }
});
test("continuation audit rejects storage, fixture, adapter and startup-observer changes", async () => {
  for (const path of ["fs/indexeddb.ts", "tooling/vfs-workloads.ts", "tooling/vfs-browser.ts", "tooling/vfs-guest.ts", "tooling/vfs-startup.ts", "tests/browser-runner-lifecycle.ts"]) {
    const fixture = await repository();
    try {
      await mkdir(resolve(fixture.root, path, ".."), { recursive: true });
      await writeFile(resolve(fixture.root, path), "// measured path changed\n");
      git(fixture.root, "add", "."); git(fixture.root, "commit", "-qm", "invalid measured path");
      expect(() => compareContinuation(fixture.root, fixture.baseline, git(fixture.root, "rev-parse", "HEAD"))).toThrow("measured or non-orchestration");
    } finally { await fixture.close(); }
  }
});
test("assembly retains complete original cells and never pools their partial successors", async () => {
  const fixture = await repository();
  try {
    const original = rows(fixture.baseline, "W1").concat(rows(fixture.baseline, "W2").slice(0, 3));
    const continued = rows(fixture.revision, "W2", "continuation");
    const result = assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued);
    expect(result.samples.length).toBe(14); expect(result.incompleteHistory.length).toBe(3);
    expect(result.completedCells).toEqual(["chromium/opfs-memory/W1/host", "chromium/opfs-memory/W2/host"]);
    expect(result.missingCells.length).toBe(58); expect(result.campaignState).toBe("incomplete");
    expect(result.samples.filter(row => row.workload === "W2").every(row => row.revision === fixture.revision)).toBe(true);
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.concat(rows(fixture.revision, "W1", "continuation")))).toThrow("reran completed");
    const failed = original.map(row => row.workload === "W2" && row.warmup ? { ...row, state: "failed correctness" as const } : row);
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, failed, continued)).toThrow("retry a failed/invalid");
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.concat(continued.slice(0, 1)))).toThrow("Duplicate");
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.map(row => ({ ...row, revision: fixture.baseline })))).toThrow("identity");
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.map(row => ({ ...row, runner: "other" })))).toThrow("runner");
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.map(row => ({ ...row, browserVersion: "other" })))).toThrow("version");
    expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.map((row, i) => ({ ...row, campaign: `continuation-${i}` })))).toThrow("campaign");
    for (const malformed of [{ repetition: 99, warmup: false }, { repetition: -3, warmup: true }, { repetition: 0, warmup: true }, { repetition: -1, warmup: false }]) {
      const history = [{ ...rows(fixture.baseline, "W2")[0]!, ...malformed }];
      expect(() => missingBaselineCells(history, fixture.baseline)).toThrow("repetition/warmup");
      expect(() => assembleBaseline(fixture.root, fixture.baseline, fixture.revision, history, continued)).toThrow("repetition/warmup");
    }
    const partial = assembleBaseline(fixture.root, fixture.baseline, fixture.revision, original, continued.slice(0, 3));
    expect(partial.completedCells.length).toBe(1); expect(partial.campaignState).toBe("incomplete");
  } finally { await fixture.close(); }
});
