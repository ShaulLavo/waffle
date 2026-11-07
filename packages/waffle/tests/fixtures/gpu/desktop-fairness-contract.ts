import type { FairnessSnapshot } from "./fairness-observer.js";
import {
  validateFairnessObservation,
  wireCount,
  type ObservationExpectation,
} from "./fairness-validation.js";
import { distribution } from "./measurement-contract.js";

export type DesktopCaps = "on" | "off";
export type DesktopDraws = 20000 | 50000;
export function desktopSchedule(pairs: number) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 5)
    throw new Error("Desktop fairness requires 1..5 pairs per workload");
  return Array.from({ length: pairs }, (_, pair) => {
    const arms: DesktopCaps[] = pair % 2 ? ["off", "on"] : ["on", "off"];
    return arms.flatMap((caps) =>
      ([20000, 50000] as const).map((draws) => ({ pair, caps, draws })),
    );
  }).flat();
}
export function desktopMeasurements(
  snapshot: FairnessSnapshot,
  draws: DesktopDraws,
  caps: DesktopCaps,
  expected: Omit<ObservationExpectation, "phase">,
) {
  const connections = Array.from(expected.connections);
  const totals = validateFairnessObservation(snapshot, {
    epoch: expected.epoch,
    connections,
    phase: "complete",
  });
  const [blob] = snapshot.blobs;
  if (
    connections.length !== 2 ||
    snapshot.blobs.length !== 1 ||
    !blob ||
    blob.end === null ||
    blob.draws !== draws ||
    blob.bytes !== draws * 24 + 184 ||
    blob.commandRingBytes !== 4 * 1024 * 1024
  )
    throw new Error("Incomplete bounded desktop compiled workload");
  const peer = connections.find((id) => id !== blob.connection)!;
  if (
    totals.get(blob.connection)?.records !== draws + 23 ||
    totals.get(peer)?.records !== 7 + 20 * 128 ||
    totals.get(peer)?.draws !== 128 ||
    wireCount(snapshot, peer, 6) !== 128 ||
    wireCount(snapshot, blob.connection, 6) !== 1
  )
    throw new Error("Desktop compiled workload/peer record counts differ");
  const slices = snapshot.slices.filter(
    (slice) => slice.connection === blob.connection && slice.draws > 0,
  );
  if (
    slices.reduce((sum, slice) => sum + slice.draws, 0) !== draws ||
    (caps === "off" && slices.length !== 1)
  )
    throw new Error("Desktop cap arm did not execute the expected draw visits");
  const peerPresents = snapshot.presents.filter((present) => present.connection === peer);
  const heavyPresent = snapshot.presents.find((present) => present.connection === blob.connection)!;
  const before = peerPresents.findLastIndex((present) => present.at <= blob.start);
  const after = peerPresents.findIndex((present) => present.at >= heavyPresent.at);
  if (before < 0 || after <= before)
    throw new Error("Desktop peer did not bracket heavy presentation");
  const gaps = peerPresents
    .slice(before + 1, after + 1)
    .map((present, index) => present.at - peerPresents[before + index]!.at);
  const cpuReplayMs = slices.reduce((sum, slice) => sum + slice.end - slice.start, 0);
  const allSliceMs = snapshot.slices.map((slice) => slice.end - slice.start);
  const nativeDraw = snapshot.native[`${blob.connection}:draw`]!;
  return {
    draws,
    caps,
    logicalBytes: blob.bytes,
    commandRingBytes: blob.commandRingBytes,
    drawSlices: slices.length,
    cpuReplayMs,
    cpuReplayMsPerDraw: cpuReplayMs / draws,
    nativeDrawMs: nativeDraw.totalMs,
    nativeDrawMsPerDraw: nativeDraw.totalMs / draws,
    replaySpanMs: blob.end - blob.start,
    peerPresentGaps: distribution(gaps),
    replaySliceDurations: distribution(allSliceMs),
    peerPresentsDuringReplay: peerPresents.filter((present) => present.otherLargeDraws.length > 0)
      .length,
    targets: { sliceMs: 8, peerGapMs: 100 },
    targetStatus:
      allSliceMs.every((ms) => ms <= 8) && gaps.every((ms) => ms <= 100) ? "met" : "not-met",
    queueCompletionIntervals: snapshot.queue.map((sample) => ({
      ...sample,
      ms: sample.settlement.kind === "pending" ? null : sample.settlement.at - sample.start,
    })),
    nativeQueueExecutionMeasured: false,
    scope:
      "Instrumented CPU replay visits and native API durations. Queue promise intervals include queue backlog and worker scheduling. Peer service presents are not compositor latency.",
  };
}
