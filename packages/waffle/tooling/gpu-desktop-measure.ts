import {
  desktopIdentity,
  desktopControl,
  desktopPixels,
  desktopArmed,
  desktopFinished,
  desktopRetired,
  desktopCleanup,
} from "../tests/fixtures/gpu/desktop-arm-contract.js";
import {
  desktopSchedule,
  desktopMeasurements,
} from "../tests/fixtures/gpu/desktop-fairness-contract.js";

export interface MeasurementController {
  call: (
    module: "page" | "runtime" | "desktop",
    method: string,
    args?: unknown[],
  ) => Promise<unknown>;
  screenshot: () => Promise<string>;
  reset: (token: string) => Promise<void>;
}
async function screenshot(controller: MeasurementController, slot: number, colour: string) {
  // Service markers precede rendering updates; the screenshot is the pixel oracle.
  await Bun.sleep(100);
  return controller.call("desktop", "observeDesktopPixels", [
    await controller.screenshot(),
    slot,
    colour,
  ]);
}
async function runDesktopArm(
  controller: MeasurementController,
  arm: ReturnType<typeof desktopSchedule>[number],
  documents: Set<number>,
) {
  const raw: Record<string, unknown> = { ...arm, startedAt: new Date().toISOString() };
  const token = crypto.randomUUID();
  let identity: ReturnType<typeof desktopIdentity> | undefined;
  try {
    await controller.reset(token);
    raw.control = await controller.call("desktop", "openDesktopArm", [arm.caps, token]);
    identity = desktopIdentity(raw.control, token, arm.caps);
    if (documents.has(identity.document.timeOrigin)) throw new Error("Desktop reused document");
    documents.add(identity.document.timeOrigin);
    desktopControl(raw.control, identity);
    raw.controlPixels = await screenshot(controller, 0, "red");
    desktopPixels(raw.controlPixels, identity, "red");
    raw.armed = await controller.call("desktop", "armDesktopWorkload", [arm.draws, arm.caps]);
    const expected = desktopArmed(raw.armed, identity);
    raw.peerReadyPixels = await screenshot(controller, 1, "green");
    desktopPixels(raw.peerReadyPixels, identity, "green");
    raw.finished = await controller.call("desktop", "runDesktopWorkload", [arm.draws]);
    raw.measurements = desktopMeasurements(
      desktopFinished(raw.finished, identity),
      arm.draws,
      arm.caps,
      expected,
    );
    raw.heavyPixels = await screenshot(controller, 0, "red");
    desktopPixels(raw.heavyPixels, identity, "red");
    raw.peerPixels = await screenshot(controller, 1, "green");
    desktopPixels(raw.peerPixels, identity, "green");
    raw.retired = await controller.call("desktop", "retireDesktopArm");
    desktopRetired(raw.retired, identity);
    raw.kind = "measured";
  } catch (error) {
    raw.kind = "failed";
    raw.reason = String(error);
  } finally {
    try {
      raw.cleanup = await controller.call("desktop", "closeDesktopArm");
      if (identity) desktopCleanup(raw.cleanup, identity);
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
  const documents = new Set<number>();
  for (const arm of desktopSchedule(pairs)) {
    const raw = await runDesktopArm(controller, arm, documents);
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
