import { expect, test } from "bun:test";
import { MemFS } from "../fs/memory.ts";
import { GuestIO, guestFixture } from "../tooling/vfs-guest.ts";
import { content, hash, random, SIZES, w2Trace, w4Trace, w5Trace, W1_READ_SET } from "../tooling/vfs-workloads.ts";
import { pairedInterval, geometric, median, score, type Sample } from "../tooling/vfs-score.ts";
import { SCORE_PROTOCOL, BROWSERS, LANES, WORKLOADS, primaryMetrics, pairOrder } from "../tooling/vfs-score-config.ts";

test("seeded content has stable random-access chunks and trace counts", () => {
  expect(hash(content(13, 4096))).toBe(hash(content(13, 4096)));
  expect(content(13, 64, 128)).toEqual(content(13, 1024).slice(128, 192));
  const a = random(), b = random(); for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  expect(new Set(W1_READ_SET).size).toBe(128);
  expect(SIZES.W1.directories).toBe(5000); expect(SIZES.W1.files).toBe(50000);
  const install = Array.from(w2Trace());
  expect(install.filter(op => op.kind === "write").length).toBe(21000);
  expect(install.filter(op => op.kind === "rename").length).toBe(2100);
  expect(install.filter(op => op.kind === "remove").length).toBe(300);
  expect(install.filter(op => op.kind === "barrier").length).toBe(22);
  const saves = Array.from(w4Trace());
  expect(saves.filter(op => op.kind === "write" && op.offset !== undefined).length).toBe(1000);
  expect(saves.filter(op => op.kind === "rename").length).toBe(100);
  expect(saves.filter(op => op.kind === "barrier").length).toBe(1200);
  for (const writers of [1, 2] as const) {
    const mixed = Array.from(w5Trace(writers)); expect(mixed.length).toBe(10000);
    expect(new Set(mixed.map(op => op.actor)).size).toBe(4); expect(mixed[0]!.kind).toBe("pin");
    expect(mixed.filter(op => op.kind === "unpin").length).toBe(1);
  }
});
test("prebuilt guest fixture invokes real preview1 filesystem operations", async () => {
  const fs = new MemFS(), guest = new GuestIO(fs, new WebAssembly.Module(guestFixture()));
  try {
    await guest.mkdir("/packages"); await guest.mkdir("/packages/a"); await guest.write("/packages/a/f", content(4, 70000));
    expect(await guest.stat("/packages/a/f")).toEqual({ size: 70000 });
    expect(await guest.read("/packages/a/f", 65530, 16)).toEqual(content(4, 16, 65530));
    expect(await guest.readdir("/packages/a")).toEqual(["f"]);
    await guest.write("/packages/a/f", content(5, 64), 1000); await guest.barrier("/packages/a/f");
    expect(await guest.read("/packages/a/f", 1000, 64)).toEqual(content(5, 64));
    await guest.rename("/packages/a", "/packages/b"); await guest.barrier();
    expect(await guest.readdir("/packages")).toEqual(["b"]);
    await guest.remove("/packages/b"); expect(await guest.readdir("/packages")).toEqual([]);
    await guest.write("/empty", new Uint8Array()); expect(await guest.stat("/empty")).toEqual({ size: 0 });
  } finally { guest.dispose(); }
});
function fixtures(campaign = "test", role: "baseline" | "candidate" = "baseline", factor = 1): Sample[] {
  const rows: Sample[] = [];
  for (const browser of BROWSERS) for (const workload of WORKLOADS) for (const lane of LANES) for (let i = 0; i < 9; i++) {
    const metrics = Object.fromEntries(primaryMetrics(workload, "indexeddb").map(metric => [metric.name, metric.direction === "lower" ? 100 / factor : 100 * factor]));
    rows.push({ protocol: SCORE_PROTOCOL, revision: "a".repeat(40), campaign, role, runner: "fixed", browser, browserVersion: "fixed", vfs: "indexeddb", workload, lane, repetition: i, pair: i, warmup: false, state: "eligible", metrics });
  }
  return rows;
}
test("normalised geometry retains raw units and fixed missing-cell masks", () => {
  const initial = fixtures(), candidate = fixtures("test", "candidate", 2);
  const result = score(initial, candidate);
  expect(result.perVfs.indexeddb!.complete).toBe(true); expect(result.perVfs.indexeddb!.score).toBeCloseTo(200);
  expect(result.family.complete).toBe(false); expect(result.family.score).toBeNull();
  expect(result.cells[0]!.raw.readinessMs).toEqual({ baseline: 100, candidate: 50, unit: "ms" });
  candidate[0]!.state = "failed correctness";
  expect(score(initial, candidate).perVfs.indexeddb!.complete).toBe(false);
  expect(score(initial, candidate.filter(row => row.browser !== "firefox")).perVfs.indexeddb!.complete).toBe(false);
  expect(() => score(initial, candidate.concat([candidate[10]!]))).toThrow("Duplicate repetition");
});
test("paired intervals guard accepted references, never reset initial baselines", () => {
  expect(median([1, 4, 2, 3])).toBe(2.5); expect(geometric([{ ratio: 2, weight: 1 }, { ratio: 0.5, weight: 1 }])).toBe(1);
  expect(() => pairedInterval([1, 2], [1, 2])).toThrow("nine paired");
  const a = Array.from({ length: 9 }, () => 100), b = a.map(value => value * 1.1);
  expect(pairedInterval(a, b).lower).toBeCloseTo(1.1); expect(pairedInterval(a, b).upper).toBeCloseTo(1.1);
  const reference = fixtures(), fast = fixtures("test", "candidate", 1.1), slow = fixtures("test", "candidate", 0.9);
  expect(score(reference, fast, reference).guardrailsPass).toBe(true);
  expect(score(reference, slow, reference).guardrailsPass).toBe(false);
  expect(score(reference, fast.map(r => ({ ...r, pair: undefined })), reference).guardrailsPass).toBe(false);
  expect(pairOrder(0)).toEqual(["baseline", "candidate"]); expect(pairOrder(1)).toEqual(["candidate", "baseline"]);
});

test("warmup failures and mixed identities never pass by later repetitions", () => {
  const initial = fixtures(), candidate = fixtures("test", "candidate");
  const warmup = { ...candidate[0]!, repetition: -1, warmup: true, state: "failed correctness" as const, reason: "corrupt warmup bytes" };
  expect(score(initial, candidate.concat([warmup])).cells[0]!.state).toBe("failed correctness");
  expect(score(initial.concat([{ ...warmup, role: "baseline" }]), candidate).cells[0]!.state).toBe("failed correctness");
  expect(() => score(initial, candidate.map((row, i) => i ? row : { ...row, revision: "b".repeat(40) }))).toThrow("mixes revisions");
  expect(() => score(initial, candidate.map((row, i) => i ? row : { ...row, campaign: "another-run" }))).toThrow("campaigns");
});
test("per-VFS promotion preserves initial normalization and latest accepted best", () => {
  const initial = fixtures("initial"), accepted = fixtures("paired", "baseline", 1.2);
  const comparison = score(initial, fixtures("paired", "candidate", 1.24), accepted, { indexeddb: 120 });
  expect(comparison.perVfs.indexeddb!.score).toBeCloseTo(124);
  expect(comparison.perVfs.indexeddb!.acceptedScore).toBeCloseTo(120);
  expect(comparison.perVfs.indexeddb!.scoreImprovesFivePercent).toBe(false);
  expect(score(initial, fixtures("paired", "candidate", 1.27), accepted, { indexeddb: 120 }).perVfs.indexeddb!.scoreImprovesFivePercent).toBe(true);
  expect(score(initial, fixtures("paired", "candidate", 1.27), accepted, { indexeddb: 130 }).perVfs.indexeddb!.scoreImprovesFivePercent).toBe(false);
  expect(score(initial, fixtures("paired", "candidate", 1.27), accepted).scoreImprovesFivePercent).toBe(false);
});
test("WAL unsupported assertions are mandatory for family completeness", () => {
  const all: Sample[] = [];
  for (const vfs of ["indexeddb", "opfs-memory", "opfs-safe", "opfs-wal"] as const) {
    all.push(...fixtures().map(row => ({ ...row, vfs, state: vfs === "opfs-wal" && row.browser !== "chromium" ? "unsupported as specified" as const : "eligible" as const, metrics: Object.fromEntries(primaryMetrics(row.workload, vfs).map(metric => [metric.name, 100])) })));
  }
  expect(score(all, all).family.complete).toBe(true);
  const missing = all.filter(row => row.vfs !== "opfs-wal" || row.browser === "chromium");
  expect(score(missing, missing).family.complete).toBe(false);
  expect(score(all, all.map((row, i) => i === all.length - 1 ? { ...row, state: "failed correctness" } : row)).family.complete).toBe(false);
});

test("source labels are derived, clean, and bound to the dispatcher manifest", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { sourceRevision } = await import("../tooling/vfs-benchmark.ts");
  const root = await mkdtemp(resolve(tmpdir(), "waffle-vfs-provenance-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root].concat(args));
    if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "-b", "fixture"); await Bun.write(`${root}/source.ts`, "export const fixture = 1;\n"); git("add", "source.ts");
    git("-c", "user.name=VFS Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const actual = git("rev-parse", "HEAD"); expect(sourceRevision(root)).toBe(actual);
    expect(sourceRevision(root, { source_commit: actual })).toBe(actual);
    expect(() => sourceRevision(root, { source_commit: "b".repeat(40) })).toThrow("dispatcher manifest");
    await Bun.write(`${root}/source.ts`, "edited\n"); expect(() => sourceRevision(root)).toThrow("clean and committed");
    git("checkout", "--", "source.ts"); await Bun.write(`${root}/untracked.ts`, "untracked\n");
    expect(() => sourceRevision(root)).toThrow("clean and committed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
