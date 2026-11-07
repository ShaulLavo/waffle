import { basename } from "node:path";

export function processMemorySample() {
  const capturedAt = new Date().toISOString();
  const result = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid=,rss=,comm="], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2000,
  });
  if (result.exitCode !== 0) return { kind: "unavailable", capturedAt, reason: "Host ps failed" };
  const processes = result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (
        !match ||
        !/Safari|WebKit|safaridriver|chrom(e|ium)|WebProcess|GPU Process/i.test(match[4]!)
      )
        return [];
      return [
        {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          rssKiB: Number(match[3]),
          name: basename(match[4]!),
        },
      ];
    });
  return { kind: "observed", capturedAt, processes };
}
export function sampleProcessMemory() {
  const samples = [processMemorySample()];
  let overflow = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (samples.length >= 1200) {
      overflow = true;
      return;
    }
    samples.push(processMemorySample());
  }, 500);
  return () => {
    clearInterval(timer);
    if (!stopped) samples.push(processMemorySample());
    stopped = true;
    return {
      samples,
      intervalMs: 500,
      overflow,
      scope:
        "Host-observed browser/WebKit process resident-set KiB. Includes pre-existing matching processes and shared pages. Not per-worker memory, physical GPU allocation, or an additive physical-memory total. Polling may perturb timing.",
      physicalGpuMemory: {
        kind: "unavailable",
        reason: "No physical GPU allocation counter exposed",
      },
    };
  };
}
