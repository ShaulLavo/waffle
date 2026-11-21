const [log, arm, rawRepetitions] = process.argv.slice(2);
const repetitions = Number(rawRepetitions);
const prefix = "VFS_EVIDENCE ";
const bytes = 64 * 1024 ** 2;
const chunk = 64 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a benchmark evidence record");
  return Object.fromEntries(Object.entries(value));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (!log || (arm !== "prototype" && arm !== "control") || !Number.isInteger(repetitions))
  throw new Error("Expected log, arm and repetition count");

const rows = (await Bun.file(log).text())
  .split("\n")
  .filter((line) => line.startsWith(prefix))
  .map((line) => object(JSON.parse(line.slice(prefix.length))));
const samples = rows.filter((row) => row.kind === "sample").map((row) => object(row.sample));
assert(
  rows.at(-1)?.kind === "finished" && samples.length === repetitions + 1,
  "Incomplete benchmark",
);
const metadata = object(rows.find((row) => row.kind === "metadata")?.metadata);

const results = samples.map((sample) => {
  const observations = object(sample.observations);
  const probe = object(observations.checkpointProbe);
  const lease = observations.leaseSideEffects ? object(observations.leaseSideEffects) : undefined;
  assert(sample.state === "eligible" || sample.state === "invalid environment", "Sample failed");
  assert(observations.checkpointOffset === 46_077_343, "Wrong fixture offset");
  assert(
    observations.verifiedBytes === bytes && observations.reopenedPayload === probe.key,
    "Reopen did not recover the complete committed file",
  );
  assert(probe.durability === "strict", "Wrong native transaction durability");
  if (lease) {
    assert(
      lease.joined &&
        lease.verifiedBothVersions &&
        lease.pinnedBytes === bytes &&
        lease.cowBytes === 4096 &&
        lease.usedBytesAfterRelease === bytes,
      "Joined lease did not preserve and then release exactly one old page",
    );
  } else assert(observations.directWriteBytes === 1024, "Expected 1 KiB direct WASI write");
  if (arm === "control") {
    assert(
      probe.snapshotBytes === bytes &&
        probe.batchBytes === bytes &&
        probe.sliceBytes === bytes &&
        probe.digestBytes === bytes &&
        probe.putBytes === bytes &&
        probe.puts === 1024,
      "Unexpected whole-file checkpoint counts",
    );
  } else {
    const map = object(observations.reopenedMap);
    assert(
      probe.copied === chunk &&
        probe.payloadBytesHashed === chunk &&
        probe.payloadBytesCommitted === chunk &&
        probe.chunkPuts === 1 &&
        probe.reused === 1023 &&
        probe.mapPuts === 2 &&
        probe.manifestPuts === 1 &&
        probe.payloadReads === 0 &&
        map.reused === 1023 &&
        map.newNodes === 2,
      "Unexpected incremental checkpoint counts",
    );
  }
  const environment = object(observations.environment);
  return {
    repetition: sample.repetition,
    warmup: sample.warmup,
    state: sample.state,
    reason: sample.reason,
    metrics: sample.metrics,
    checkpointOffset: observations.checkpointOffset,
    directWriteBytes: observations.directWriteBytes,
    verifiedBytes: observations.verifiedBytes,
    reopenedGeneration: observations.reopenedGeneration,
    reopenedPayload: observations.reopenedPayload,
    reopenedMap: observations.reopenedMap,
    ready: observations.ready,
    after: observations.after,
    lease,
    probe,
    pressure: [object(environment.before).memoryPressure, object(environment.after).memoryPressure],
  };
});
console.log(
  JSON.stringify(
    {
      arm,
      revision: metadata.revision,
      experimentRevision: process.env.WAFFLE_CHECKPOINT_EXPERIMENT_REVISION,
      chromium: samples[0]?.browserVersion,
      samples: results,
    },
    null,
    2,
  ),
);
