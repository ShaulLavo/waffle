import type { RuntimeStartupStage } from "../fs/startup.js";

export function assertRuntimeStartupTrace(
  seen: readonly (readonly [RuntimeStartupStage, number])[],
  expected: readonly RuntimeStartupStage[],
  timeOrigin: number,
): void {
  if (JSON.stringify(seen.map(([stage]) => stage)) !== JSON.stringify(expected))
    throw new Error(`unexpected startup sequence: ${JSON.stringify(seen)}`);
  if (!seen.every(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= timeOrigin))
    throw new Error("comparable epoch clocks");
  const previous = new Map<"runtime" | "filesystem-worker", number>();
  for (const [stage, timestamp] of seen) {
    const realm =
      stage === "filesystem-worker-created" || stage === "filesystem-connect-requested"
        ? "runtime"
        : "filesystem-worker";
    const last = previous.get(realm);
    if (last !== undefined && timestamp < last)
      throw new Error(
        `milestone clocks follow operation order within ${realm}: ${JSON.stringify(seen)}`,
      );
    previous.set(realm, timestamp);
  }
}
