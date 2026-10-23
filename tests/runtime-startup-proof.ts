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
  if (!seen.every(([, timestamp], index) => index === 0 || timestamp >= seen[index - 1]![1]))
    throw new Error("milestone clocks follow operation order");
}
