import { qualificationRecord } from "../tests/fixtures/gpu/qualification-contract.js";
import {
  desktopSchedule,
  desktopMeasurements,
} from "../tests/fixtures/gpu/desktop-fairness-contract.js";
import { desktopObservation } from "../tests/fixtures/gpu/desktop-fairness-observation.js";
import { assertRetired } from "../tests/gpu-browser-shared.js";

export interface MeasurementController {
  call: (
    module: "page" | "runtime" | "desktop",
    method: string,
    args?: unknown[],
  ) => Promise<unknown>;
  screenshot: () => Promise<string>;
  reset: () => Promise<void>;
}
async function screenshot(controller: MeasurementController, slot: number, colour: string) {
  // Service markers precede rendering updates; the screenshot is the pixel oracle.
  await Bun.sleep(100);
  return controller.call("runtime", "observeTriangleScreenshot", [
    await controller.screenshot(),
    slot,
    colour,
  ]);
}
async function runDesktopArm(
  controller: MeasurementController,
  arm: ReturnType<typeof desktopSchedule>[number],
) {
  const raw: Record<string, unknown> = { ...arm, startedAt: new Date().toISOString() };
  try {
    await controller.reset();
    raw.control = await controller.call("desktop", "openDesktopArm", [arm.caps]);
    raw.controlPixels = await screenshot(controller, 0, "red");
    raw.armed = await controller.call("desktop", "armDesktopWorkload", [arm.draws, arm.caps]);
    raw.peerReadyPixels = await screenshot(controller, 1, "green");
    raw.finished = await controller.call("desktop", "runDesktopWorkload", [arm.draws]);
    raw.measurements = desktopMeasurements(desktopObservation(raw.finished), arm.draws, arm.caps);
    raw.heavyPixels = await screenshot(controller, 0, "red");
    raw.peerPixels = await screenshot(controller, 1, "green");
    raw.retired = await controller.call("desktop", "retireDesktopArm");
    assertRetired(qualificationRecord(raw.retired).service);
    raw.kind = "measured";
  } catch (error) {
    raw.kind = "failed";
    raw.reason = String(error);
  } finally {
    try {
      raw.cleanup = await controller.call("desktop", "closeDesktopArm");
    } catch (error) {
      raw.kind = "failed";
      raw.cleanupError = String(error);
    }
    raw.finishedAt = new Date().toISOString();
  }
  return raw;
}
export async function runDesktopMeasurements(controller: MeasurementController, pairs: number) {
  const samples = [];
  for (const arm of desktopSchedule(pairs)) {
    const raw = await runDesktopArm(controller, arm);
    samples.push(raw);
    // A failed control must not lead into later timed arms. Keep all preceding raw samples.
    if (raw.kind === "failed") break;
  }
  return {
    pairsPerWorkload: pairs,
    samples,
    schedule: desktopSchedule(pairs),
    observerEffect:
      "Native calls and replay steps carry observer clocks in both arms. No uninstrumented timing claim.",
    qualification: false,
  };
}
