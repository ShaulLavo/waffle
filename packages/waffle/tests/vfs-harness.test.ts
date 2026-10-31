import { expect, test } from "bun:test";
import { MemFS } from "../fs/memory.ts";
import { GuestIO, guestFixture } from "../tooling/vfs-guest.ts";
import {
  content,
  hash,
  random,
  SIZES,
  w2Trace,
  w4Trace,
  w5Trace,
  W1_READ_SET,
} from "../tooling/vfs-workloads.ts";
import {
  pairedInterval,
  geometric,
  median,
  score,
  summarizeInitialBaseline,
  type Sample,
} from "../tooling/vfs-score.ts";
import {
  SCORE_PROTOCOL,
  BROWSERS,
  LANES,
  WORKLOADS,
  primaryMetrics,
  pairOrder,
} from "../tooling/vfs-score-config.ts";

test("seeded content has stable random-access chunks and trace counts", () => {
  expect(hash(content(13, 4096))).toBe(hash(content(13, 4096)));
  expect(content(13, 64, 128)).toEqual(content(13, 1024).slice(128, 192));
  const a = random(),
    b = random();
  for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  expect(new Set(W1_READ_SET).size).toBe(128);
  expect(SIZES.W1.directories).toBe(5000);
  expect(SIZES.W1.files).toBe(50000);
  const install = Array.from(w2Trace());
  expect(install.filter((op) => op.kind === "write").length).toBe(21000);
  expect(install.filter((op) => op.kind === "rename").length).toBe(2100);
  expect(install.filter((op) => op.kind === "remove").length).toBe(300);
  expect(install.filter((op) => op.kind === "barrier").length).toBe(22);
  const saves = Array.from(w4Trace());
  expect(saves.filter((op) => op.kind === "write" && op.offset !== undefined).length).toBe(1000);
  expect(saves.filter((op) => op.kind === "rename").length).toBe(100);
  expect(saves.filter((op) => op.kind === "barrier").length).toBe(1200);
  for (const writers of [1, 2] as const) {
    const mixed = Array.from(w5Trace(writers));
    expect(mixed.length).toBe(10000);
    expect(new Set(mixed.map((op) => op.actor)).size).toBe(4);
    expect(mixed[0]!.kind).toBe("pin");
    expect(mixed.filter((op) => op.kind === "unpin").length).toBe(1);
  }
});
test("prebuilt guest fixture invokes real preview1 filesystem operations", async () => {
  const fs = new MemFS(),
    guest = new GuestIO(fs, new WebAssembly.Module(guestFixture()));
  try {
    await guest.mkdir("/packages");
    await guest.mkdir("/packages/a");
    await guest.write("/packages/a/f", content(4, 70000));
    expect(await guest.stat("/packages/a/f")).toEqual({ size: 70000 });
    expect(await guest.read("/packages/a/f", 65530, 16)).toEqual(content(4, 16, 65530));
    expect(await guest.readdir("/packages/a")).toEqual(["f"]);
    await guest.write("/packages/a/f", content(5, 64), 1000);
    await guest.barrier("/packages/a/f");
    expect(await guest.read("/packages/a/f", 1000, 64)).toEqual(content(5, 64));
    await guest.rename("/packages/a", "/packages/b");
    await guest.barrier();
    expect(await guest.readdir("/packages")).toEqual(["b"]);
    await guest.remove("/packages/b");
    expect(await guest.readdir("/packages")).toEqual([]);
    await guest.write("/empty", new Uint8Array());
    expect(await guest.stat("/empty")).toEqual({ size: 0 });
  } finally {
    guest.dispose();
  }
});
function workloadLanes(browser: Sample["browser"]) {
  return WORKLOADS.flatMap((workload) => LANES.map((lane) => ({ browser, workload, lane })));
}
function fixtureMetrics(
  workload: Sample["workload"],
  factor = 1,
  vfs: Sample["vfs"] = "indexeddb",
) {
  return Object.fromEntries(
    primaryMetrics(workload, vfs).map((metric) => [
      metric.name,
      metric.direction === "lower" ? 100 / factor : 100 * factor,
    ]),
  );
}
function fixtures(
  campaign = "test",
  role: "baseline" | "candidate" = "baseline",
  factor = 1,
): Sample[] {
  const rows: Sample[] = [];
  const cells = BROWSERS.flatMap(workloadLanes);
  for (const { browser, workload, lane } of cells)
    for (let i = 0; i < 9; i++) {
      const metrics = fixtureMetrics(workload, factor);
      rows.push({
        protocol: SCORE_PROTOCOL,
        revision: "a".repeat(40),
        campaign,
        role,
        runner: "fixed",
        browser,
        browserVersion: "fixed",
        vfs: "indexeddb",
        workload,
        lane,
        repetition: i,
        pair: i,
        warmup: false,
        state: "eligible",
        metrics,
      });
    }
  return rows;
}
test("normalised geometry retains raw units and fixed missing-cell masks", () => {
  const initial = fixtures(),
    candidate = fixtures("test", "candidate", 2);
  const result = score(initial, candidate);
  expect(result.perVfs.indexeddb!.complete).toBe(true);
  expect(result.perVfs.indexeddb!.score).toBeCloseTo(200);
  expect(result.family.complete).toBe(false);
  expect(result.family.score).toBeNull();
  expect(result.cells[0]!.raw.readinessMs).toEqual({ baseline: 100, candidate: 50, unit: "ms" });
  candidate[0]!.state = "failed correctness";
  expect(score(initial, candidate).perVfs.indexeddb!.complete).toBe(false);
  expect(
    score(
      initial,
      candidate.filter((row) => row.browser !== "firefox"),
    ).perVfs.indexeddb!.complete,
  ).toBe(false);
  expect(() => score(initial, candidate.concat([candidate[10]!]))).toThrow("Duplicate repetition");
});
test("paired intervals guard accepted references, never reset initial baselines", () => {
  expect(median([1, 4, 2, 3])).toBe(2.5);
  expect(
    geometric([
      { ratio: 2, weight: 1 },
      { ratio: 0.5, weight: 1 },
    ]),
  ).toBe(1);
  expect(() => pairedInterval([1, 2], [1, 2])).toThrow("nine paired");
  const a = Array.from({ length: 9 }, () => 100),
    b = a.map((value) => value * 1.1);
  expect(pairedInterval(a, b).lower).toBeCloseTo(1.1);
  expect(pairedInterval(a, b).upper).toBeCloseTo(1.1);
  const reference = fixtures(),
    fast = fixtures("test", "candidate", 1.1),
    slow = fixtures("test", "candidate", 0.9);
  expect(score(reference, fast, reference).guardrailsPass).toBe(true);
  expect(score(reference, slow, reference).guardrailsPass).toBe(false);
  expect(
    score(
      reference,
      fast.map((r) => ({ ...r, pair: undefined })),
      reference,
    ).guardrailsPass,
  ).toBe(false);
  expect(pairOrder(0)).toEqual(["baseline", "candidate"]);
  expect(pairOrder(1)).toEqual(["candidate", "baseline"]);
});

test("warmup failures and mixed identities never pass by later repetitions", () => {
  const initial = fixtures(),
    candidate = fixtures("test", "candidate");
  const warmup = {
    ...candidate[0]!,
    repetition: -1,
    warmup: true,
    state: "failed correctness" as const,
    reason: "corrupt warmup bytes",
  };
  expect(score(initial, candidate.concat([warmup])).cells[0]!.state).toBe("failed correctness");
  expect(score(initial.concat([{ ...warmup, role: "baseline" }]), candidate).cells[0]!.state).toBe(
    "failed correctness",
  );
  expect(() =>
    score(
      initial,
      candidate.map((row, i) => (i ? row : { ...row, revision: "b".repeat(40) })),
    ),
  ).toThrow("mixes revisions");
  expect(() =>
    score(
      initial,
      candidate.map((row, i) => (i ? row : { ...row, campaign: "another-run" })),
    ),
  ).toThrow("campaigns");
});
test("per-VFS promotion preserves initial normalization and latest accepted best", () => {
  const initial = fixtures("initial"),
    accepted = fixtures("paired", "baseline", 1.2);
  const comparison = score(initial, fixtures("paired", "candidate", 1.24), accepted, {
    indexeddb: 120,
  });
  expect(comparison.perVfs.indexeddb!.score).toBeCloseTo(124);
  expect(comparison.perVfs.indexeddb!.acceptedScore).toBeCloseTo(120);
  expect(comparison.perVfs.indexeddb!.scoreImprovesFivePercent).toBe(false);
  expect(
    score(initial, fixtures("paired", "candidate", 1.27), accepted, { indexeddb: 120 }).perVfs
      .indexeddb!.scoreImprovesFivePercent,
  ).toBe(true);
  expect(
    score(initial, fixtures("paired", "candidate", 1.27), accepted, { indexeddb: 130 }).perVfs
      .indexeddb!.scoreImprovesFivePercent,
  ).toBe(false);
  expect(
    score(initial, fixtures("paired", "candidate", 1.27), accepted).scoreImprovesFivePercent,
  ).toBe(false);
});
test("WAL unsupported assertions are mandatory for family completeness", () => {
  const all: Sample[] = [];
  for (const vfs of ["indexeddb", "opfs-memory", "opfs-safe", "opfs-wal"] as const) {
    all.push(
      ...fixtures().map((row) => ({
        ...row,
        vfs,
        state:
          vfs === "opfs-wal" && row.browser !== "chromium"
            ? ("unsupported as specified" as const)
            : ("eligible" as const),
        metrics: fixtureMetrics(row.workload, 1, vfs),
      })),
    );
  }
  expect(score(all, all).family.complete).toBe(true);
  const composedInitial = all.map((row) =>
    row.vfs === "opfs-safe" || row.vfs === "opfs-wal"
      ? { ...row, campaign: "later-initial-baselines", revision: "b".repeat(40) }
      : row,
  );
  expect(score(composedInitial, all).family.complete).toBe(true);
  expect(() => score(composedInitial, composedInitial)).toThrow("mixes revisions");
  const missing = all.filter((row) => row.vfs !== "opfs-wal" || row.browser === "chromium");
  expect(score(missing, missing).family.complete).toBe(false);
  expect(
    score(
      all,
      all.map((row, i) => (i === all.length - 1 ? { ...row, state: "failed correctness" } : row)),
    ).family.complete,
  ).toBe(false);
});

test("composed initial summaries normalize without relaxing candidate or ratchet identity", () => {
  const initial = fixtures().map((row) =>
    row.browser === "firefox"
      ? { ...row, revision: "b".repeat(40), campaign: "missing-cell-continuation" }
      : row,
  );
  const result = summarizeInitialBaseline(initial);
  expect(result.kind).toBe("initial-baseline summary");
  expect(result.perVfs.indexeddb!.complete).toBe(true);
  expect(result.perVfs.indexeddb!.score).toBeCloseTo(100);
  expect(result.cells[0]!.raw.readinessMs).toEqual({ baseline: 100, candidate: 100, unit: "ms" });
  expect(result.family.score).toBeNull();
  expect(result.perVfs["opfs-safe"]!.score).toBeNull();
  expect(result.guardrailsPass).toBe(false);
  expect(result.scoreImprovesFivePercent).toBe(false);
  for (const value of Object.values(result.perVfs)) {
    expect(value.acceptedScore).toBeNull();
    expect(value.ratchetScore).toBeNull();
    expect(value.scoreImprovesFivePercent).toBe(false);
  }
  expect(() => score(initial, initial)).toThrow("mixes revisions");
  expect(() => score(initial, fixtures(), initial)).toThrow("mixes revisions");
  expect(() => summarizeInitialBaseline(initial.concat([initial[0]!]))).toThrow("Duplicate");
  expect(() =>
    summarizeInitialBaseline(
      initial.map((row, i) => (i === 0 ? { ...row, revision: "c".repeat(40) } : row)),
    ),
  ).toThrow("mixes revisions");
  expect(() =>
    summarizeInitialBaseline(
      initial.map((row, i) => (i === 0 ? { ...row, campaign: "other" } : row)),
    ),
  ).toThrow("campaigns");
  expect(() =>
    summarizeInitialBaseline(
      initial.map((row) => ({ ...row, protocol: "wrong" as typeof SCORE_PROTOCOL })),
    ),
  ).toThrow("protocol");
});
test("initial summary retains correctness, sample-count, metric and unsupported gates", () => {
  const initial = fixtures();
  for (const state of ["failed correctness", "invalid environment"] as const)
    for (const warmup of [true, false]) {
      const row: Sample = { ...initial[0]!, state, warmup, repetition: warmup ? -1 : 0 };
      const input = warmup ? initial.concat([row]) : [row].concat(initial.slice(1));
      expect(summarizeInitialBaseline(input).perVfs.indexeddb!.complete).toBe(false);
    }
  expect(
    summarizeInitialBaseline(initial.filter((row) => row.repetition < 4)).perVfs.indexeddb!
      .complete,
  ).toBe(false);
  for (const value of [0, -1, NaN, Infinity, undefined]) {
    const input = initial.map((row, i) =>
      i
        ? row
        : { ...row, metrics: value === undefined ? {} : { ...row.metrics, readinessMs: value } },
    );
    expect(summarizeInitialBaseline(input).perVfs.indexeddb!.complete).toBe(false);
  }
  const wal = initial.map((row) => ({
    ...row,
    vfs: "opfs-wal" as const,
    state:
      row.browser === "chromium" ? ("eligible" as const) : ("unsupported as specified" as const),
    metrics: Object.fromEntries(
      primaryMetrics(row.workload, "opfs-wal").map((metric) => [metric.name, 100]),
    ),
  }));
  expect(summarizeInitialBaseline(wal).perVfs["opfs-wal"]!.complete).toBe(true);
  expect(
    summarizeInitialBaseline(wal.filter((row) => row.browser === "chromium")).perVfs["opfs-wal"]!
      .complete,
  ).toBe(false);
  for (const state of ["failed correctness", "eligible"] as const)
    expect(
      summarizeInitialBaseline(
        wal.map((row) => (row.browser === "firefox" ? { ...row, state } : row)),
      ).perVfs["opfs-wal"]!.complete,
    ).toBe(false);
});
test("initial-summary CLI rejects comparison arguments before loading input", () => {
  for (const args of [
    ["--initial-summary"],
    ["--initial-summary", "/missing-baseline.json", "extra"],
  ]) {
    const result = Bun.spawnSync(
      [process.execPath, `${import.meta.dir}/../tooling/vfs-score.ts`].concat(args),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no comparison or ratchet arguments");
  }
});

test("source labels are derived, clean, and bound to the dispatcher manifest", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { sourceRevision } = await import("../tooling/vfs-benchmark.ts");
  const root = await mkdtemp(resolve(tmpdir(), "waffle-vfs-provenance-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root].concat(args));
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "-b", "fixture");
    await Bun.write(`${root}/source.ts`, "export const fixture = 1;\n");
    git("add", "source.ts");
    git(
      "-c",
      "user.name=VFS Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
    const actual = git("rev-parse", "HEAD");
    expect(sourceRevision(root)).toBe(actual);
    expect(sourceRevision(root, { source_commit: actual })).toBe(actual);
    expect(() => sourceRevision(root, { source_commit: "b".repeat(40) })).toThrow(
      "dispatcher manifest",
    );
    await Bun.write(`${root}/source.ts`, "edited\n");
    expect(() => sourceRevision(root)).toThrow("clean and committed");
    git("checkout", "--", "source.ts");
    await Bun.write(`${root}/untracked.ts`, "untracked\n");
    expect(() => sourceRevision(root)).toThrow("clean and committed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IndexedDB open and later tree readiness are independent startup intervals", async () => {
  const { indexeddbStartupIntervals } = await import("../tooling/vfs-startup.ts");
  expect(
    indexeddbStartupIntervals({
      "indexeddb-open-requested": 100,
      "indexeddb-open-resolved": 1240,
      "filesystem-ready": 1265,
    }),
  ).toEqual({ indexeddbOpenMs: 1140, treeReadyAfterIndexeddbMs: 25 });
  expect(
    indexeddbStartupIntervals({
      "indexeddb-open-requested": 0,
      "indexeddb-open-resolved": 0,
      "filesystem-ready": 0,
    }),
  ).toEqual({ indexeddbOpenMs: 0, treeReadyAfterIndexeddbMs: 0 });
  expect(() => indexeddbStartupIntervals({})).toThrow("Missing");
  expect(() =>
    indexeddbStartupIntervals({
      "indexeddb-open-requested": 10,
      "indexeddb-open-resolved": 5,
      "filesystem-ready": 12,
    }),
  ).toThrow("Non-monotonic");
});
