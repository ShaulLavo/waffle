import type { Page } from "playwright";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import {
  fairnessConnectionIds,
  validateFairnessObservation,
  validateSeededCheckpoint,
} from "./fixtures/gpu/fairness-validation.js";
import { fairnessMeasurements } from "./fixtures/gpu/fairness-observer.js";

async function checkpoint(page: Page, text: string, slot = 0) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await invoke(page, "drainTriangle", [slot, false]);
    if (result.errors.length || result.text.includes("GPU_FAIL"))
      throw new Error(`Compiled fairness guest failed: ${JSON.stringify(result)}`);
    if (result.text.includes(text)) return result;
  }
  throw new Error(`Compiled fairness checkpoint did not arrive: slot=${slot} ${text}`);
}
async function current(page: Page, settled = false) {
  const value = await invoke(page, "serviceCommand", [settled ? "fairness-settled" : "snapshot"]);
  if (!value?.fairness || value.observerError)
    throw new Error(`Missing current fairness service snapshot: ${JSON.stringify(value)}`);
  return value;
}
async function arm(page: Page) {
  await invoke(page, "openIntegration", [false, "fairness", true]);
  await invoke(page, "activateDisplay");
  await invoke(page, "launchTriangle", [[], "gpu", 0, true]);
  const control = await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
  if (
    control.workers.filter((worker: { url: string }) =>
      worker.url.includes("/gpu/service-worker.ts"),
    ).length !== 1
  )
    throw new Error("Fairness control did not use exactly one shared GPU service");
  assertTrianglePixels(await pixels(page, 0, false));
  const stopped = await invoke(page, "stopTriangle");
  assertRetired(stopped.service);
  assertCompiledExit(stopped);
  await current(page, true);
  const value = await invoke(page, "serviceCommand", ["fairness-arm"]);
  if (!value?.fairness?.armed || !value.coverage || value.observerError)
    throw new Error(
      `Fairness observer did not cover the real compiled control: ${JSON.stringify(value)}`,
    );
  if (
    !Number.isSafeInteger(value.fairness.epoch) ||
    value.fairness.epoch !== value.coverage.epoch + 1
  )
    throw new Error("Fairness arm returned an invalid observation epoch");
  return {
    coverage: value.coverage,
    epoch: value.fairness.epoch,
    baseline: {
      presents: value.presents,
      frameTexturesCreated: value.frameTexturesCreated,
      slices: value.slices,
    },
  };
}
async function largeBlobCase(page: Page) {
  try {
    const { coverage, epoch } = await arm(page);
    await invoke(page, "launchTriangle", [["--fairness-heavy"], "gpu", 0, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-heavy-ready");
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    assertTrianglePixels(await pixels(page, 1, false), "green");
    const ready = await current(page);
    if (ready.connections !== 2) throw new Error("Two real compiled GPU connections did not open");
    const connections = fairnessConnectionIds(ready.fairness);
    if (connections.length !== 2) throw new Error("Missing two observed compiled GPU identities");
    validateFairnessObservation(ready.fairness, { epoch, connections, phase: "checkpoint" });
    await invoke(page, "feedTriangle", ["\n".repeat(127) + "q", 1]);
    await invoke(page, "feedTriangle", ["\n", 0]);
    await checkpoint(page, "GPU_FAIRNESS_REPLAYED draws=200000");
    const replayed = await current(page);
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    await checkpoint(page, "GPU_STAGE closed", 1);
    const finished = await current(page, true);
    const image = await pixels(page, 0, false),
      peerImage = await pixels(page, 1, false);
    assertTrianglePixels(image);
    assertTrianglePixels(peerImage, "green");
    const measurements = fairnessMeasurements(finished.fairness, {
      epoch,
      connections,
      peerFrames: 128,
    });
    const exits = [
      await invoke(page, "stopTriangle", [false, 0]),
      await invoke(page, "stopTriangle", [false, 1, false]),
    ];
    for (const exit of exits) assertCompiledExit(exit);
    assertRetired(exits[1]!.service);
    return {
      kind: "compiled-large-blob",
      coverage,
      ready,
      replayed,
      finished,
      measurements,
      image,
      peerImage,
      exits,
    };
  } finally {
    await invoke(page, "closeIntegration");
  }
}
function assertCompiledExit(exit: Awaited<ReturnType<typeof invoke>>) {
  if (exit.exit.kind !== "exited" || exit.exit.code !== 0 || exit.text.includes("GPU_FAIL"))
    throw new Error(`Compiled fairness close failed: ${JSON.stringify(exit)}`);
  if (
    !exit.authority.length ||
    exit.authority.some(
      (report: { canaries: string[]; leaks: string[] }) =>
        report.canaries.length < 10 || report.leaks.length,
    )
  )
    throw new Error("Compiled fairness authority canaries failed");
}
const seeds = [17, 193, 8191];
const colours = ["red", "green", "blue"];
const stages = ["seed-acquired", "seed-view", "seed-encoded", "seed-submitted", "seed-presented"];
function corner(seed: number, frame: number) {
  const index = frame - 1;
  return [(seed + index * 17) % 64, (seed * 3 + index * 11) % 64, (seed * 7 + index * 5) % 64, 255];
}
function label(slot: number, frame: number, stage: number) {
  return `GPU_FAIRNESS_CHECKPOINT seed=${seeds[slot]} frame=${frame} stage=${stages[stage]}`;
}
async function advanceSeed(page: Page, slot: number, cursor: { frame: number; stage: number }) {
  if (cursor.stage === 4) {
    cursor.frame++;
    cursor.stage = 0;
  } else cursor.stage++;
  await invoke(page, "feedTriangle", ["\n", slot]);
  await checkpoint(
    page,
    cursor.frame > 3 ? "GPU_STAGE closed" : label(slot, cursor.frame, cursor.stage),
    slot,
  );
}
async function interleavedFrames(page: Page, scheduleSeed: number) {
  try {
    const { coverage, epoch, baseline } = await arm(page);
    for (let slot = 0; slot < 3; slot++) {
      await invoke(page, "launchTriangle", [
        [colours[slot], "--fairness-seed", String(seeds[slot])],
        "gpu",
        slot,
        true,
      ]);
      await checkpoint(page, label(slot, 1, 0), slot);
    }
    const opened = await current(page);
    if (opened.connections !== 3 || opened.presents !== 1)
      throw new Error(`Seeded frame connections did not synchronize: ${JSON.stringify(opened)}`);
    const connections = fairnessConnectionIds(opened.fairness);
    if (connections.length !== 3) throw new Error("Missing three observed compiled GPU identities");
    const cursors = seeds.map(() => ({ frame: 1, stage: 0 }));
    const progress = () =>
      cursors.map((cursor, slot) => ({ ...cursor, connection: connections[slot]! }));
    validateSeededCheckpoint(opened, progress(), epoch, baseline);
    let previousSlices = opened.slices;
    const presented = [0, 0, 0];
    const checkpoints = [];
    let random = scheduleSeed;
    for (let step = 0; step < 45; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const ready = cursors
        .map((cursor, slot) => ({ ...cursor, slot }))
        .filter((cursor) => cursor.frame <= 3);
      const chosen = ready[random % ready.length]!;
      const cursor = cursors[chosen.slot]!;
      await advanceSeed(page, chosen.slot, cursor);
      const service = await current(page);
      validateSeededCheckpoint(service, progress(), epoch, baseline);
      if (service.slices < previousSlices)
        throw new Error("Fairness service visits moved backwards");
      previousSlices = service.slices;
      if (cursor.frame <= 3 && cursor.stage === 4) presented[chosen.slot] = cursor.frame;
      if (service.presents !== 1 + presented.reduce((sum, frame) => sum + frame, 0))
        throw new Error("Current correlated snapshot disagrees with seeded guest presentations");
      await assertSeededPixels(page, presented);
      checkpoints.push({
        step,
        slot: chosen.slot,
        frame: cursor.frame,
        stage: cursor.stage,
        service: {
          connections: service.connections,
          presents: service.presents,
          slices: service.slices,
          frameTexturesLive: service.frameTexturesLive,
          epoch: service.fairness.epoch,
        },
      });
    }
    const exits = [];
    for (let slot = 0; slot < 3; slot++)
      exits.push(await invoke(page, "stopTriangle", [false, slot, false]));
    for (const exit of exits) assertCompiledExit(exit);
    assertRetired(exits.at(-1)!.service);
    const final = await current(page, true);
    validateSeededCheckpoint(final, progress(), epoch, baseline, "complete");
    return {
      kind: "compiled-seeded-interleaving",
      scheduleSeed,
      seeds,
      coverage,
      checkpoints,
      final,
      exits,
    };
  } finally {
    await invoke(page, "closeIntegration");
  }
}
async function assertSeededPixels(page: Page, presented: readonly number[]) {
  for (let slot = 0; slot < presented.length; slot++) {
    if (!presented[slot]) continue;
    assertTrianglePixels(
      await pixels(page, slot, false),
      colours[slot],
      corner(seeds[slot]!, presented[slot]!),
    );
  }
}
async function unsupportedFairness(page: Page) {
  await invoke(page, "openIntegration", [false, "fairness", true]);
  await invoke(page, "activateDisplay");
  try {
    await invoke(page, "launchTriangle", [["--fairness-heavy"]]);
    const result = await invoke(page, "stopTriangle", [false, 0, false]);
    if (
      result.exit.kind !== "exited" ||
      result.exit.code !== 1 ||
      !result.text.includes("GPU_FAIL") ||
      result.text.includes("GPU_FAIRNESS_BLOB")
    )
      throw new Error("Unsupported engine invented compiled fairness acceptance");
    return { kind: "unsupported-real-compiled-guest", result };
  } finally {
    await invoke(page, "closeIntegration");
  }
}
async function isolatedCase<T>(source: Page, url: string, action: (page: Page) => Promise<T>) {
  const browser = source.context().browser();
  if (!browser) throw new Error("Fairness fixture needs the registered runner's browser");
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await page.goto(url);
    return await action(page);
  } finally {
    await context.close();
  }
}
export async function fairnessCases(page: Page, url: string, available: boolean) {
  if (!available) return [await isolatedCase(page, url, unsupportedFairness)];
  const large = await isolatedCase(page, url, largeBlobCase);
  console.log(
    JSON.stringify({ stage: "compiled-fairness-measurements", measurements: large.measurements }),
  );
  const results: unknown[] = [large];
  for (const seed of [0x5eed, 0xc0ffee])
    results.push(await isolatedCase(page, url, (page) => interleavedFrames(page, seed)));
  return results;
}
