/** Frozen v1 protocol. Change these weights/masks only with a reviewed contract change. */
export const SCORE_PROTOCOL = "waffle-vfs-1";
export const FIXTURE_SEED = 0x57414646;
export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export const VFS_NAMES = ["indexeddb", "opfs-memory", "opfs-safe", "opfs-wal"] as const;
export const WORKLOADS = ["W1", "W2", "W3", "W4", "W5"] as const;
export const LANES = ["host", "guest"] as const;
export type BrowserName = (typeof BROWSERS)[number];
export type VfsName = (typeof VFS_NAMES)[number];
export type Workload = (typeof WORKLOADS)[number];
export type Lane = (typeof LANES)[number];
export type Eligibility =
  | "eligible"
  | "failed correctness"
  | "unsupported as specified"
  | "deferred/not measured"
  | "invalid environment";
export interface Metric {
  name: string;
  direction: "lower" | "higher";
  unit: "ms" | "MiB/s" | "ops/s";
  weight: number;
}
const latency = (name: string): Metric => ({ name, direction: "lower", unit: "ms", weight: 1 });
const rate = (name: string, unit: "MiB/s" | "ops/s"): Metric => ({
  name,
  direction: "higher",
  unit,
  weight: 1,
});
export function primaryMetrics(workload: Workload, vfs: VfsName): readonly Metric[] {
  switch (workload) {
    case "W1":
      return [latency("readinessMs"), latency("firstUseMs")];
    case "W2":
      return [latency("durableInstallMs")];
    case "W3":
      return [rate("durableWriteMiBs", "MiB/s"), rate("readMiBs", "MiB/s")];
    case "W4":
      return [rate("durableSavesPerSecond", "ops/s"), latency("saveP95Ms")];
    case "W5":
      return vfs === "opfs-wal"
        ? [rate("durableOpsPerSecond", "ops/s"), latency("readerP95Ms"), latency("writerP95Ms")]
        : vfs === "indexeddb"
          ? [latency("handoffMs"), latency("revocationMs")]
          : [latency("handoffMs")];
  }
}
export const SAMPLING = {
  screening: { warmups: 2, repetitions: 5 },
  promotion: { warmups: 3, repetitions: 9 },
} as const;
/** A pair is always adjacent; both revisions must implement this same protocol. */
export function pairOrder(pair: number): readonly ("baseline" | "candidate")[] {
  return pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
}
export function expectedState(
  browser: BrowserName,
  vfs: VfsName,
): "supported" | "unsupported as specified" {
  return vfs === "opfs-wal" && browser !== "chromium" ? "unsupported as specified" : "supported";
}
export const MINIMUM_GAIN = 1.05;
export const MAXIMUM_REGRESSION = 1.05;
