import {
  openIntegration,
  activateDisplay,
  launchTriangle,
  drainTriangle,
  feedTriangle,
  stopTriangle,
  closeIntegration,
  serviceCommand,
} from "./integration-page.js";
import { qualificationRecord } from "./qualification-contract.js";
import type { DesktopCaps, DesktopDraws } from "./desktop-fairness-contract.js";

async function checkpoint(text: string, slot = 0) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const value = drainTriangle(slot, false);
    if (value.errors.length || value.text.includes("GPU_FAIL"))
      throw new Error(`Desktop compiled guest failed: ${JSON.stringify(value)}`);
    if (value.text.includes(text)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Desktop compiled checkpoint deadline: ${slot} ${text}`);
}
function exit(value: Awaited<ReturnType<typeof stopTriangle>>) {
  if (value.exit.kind !== "exited" || value.exit.code !== 0 || value.text.includes("GPU_FAIL"))
    throw new Error(`Desktop compiled exit failed: ${JSON.stringify(value)}`);
  for (const item of value.authority) {
    const report = qualificationRecord(item);
    if (
      !Array.isArray(report.canaries) ||
      report.canaries.length < 10 ||
      !Array.isArray(report.leaks) ||
      report.leaks.length
    )
      throw new Error("Desktop guest authority control failed");
  }
  if (!value.authority.length) throw new Error("Missing desktop guest authority controls");
}
/** @browserEntry */
export async function openDesktopArm(caps: DesktopCaps) {
  if (caps !== "on" && caps !== "off") throw new Error("Unknown desktop caps arm");
  await openIntegration(false, `desktop-${caps}`, true);
  await activateDisplay();
  const start = performance.now();
  await launchTriangle(["--pause-acquired"], "gpu", 0, true);
  await checkpoint("GPU_WAIT_STDIN stage=acquired");
  const incomplete = qualificationRecord(await serviceCommand("fairness-arm"));
  if (!String(incomplete.observerError).includes("positive coverage"))
    throw new Error("Incomplete native observer coverage incorrectly armed");
  if (feedTriangle("\n") !== 1) throw new Error("Desktop control stdin refused");
  const frame = await checkpoint("GPU_FRAME colour=red frame=1 validation=none");
  return { firstCompiledFrameMarkerMs: performance.now() - start, incomplete, frame };
}
/** @browserEntry */
export async function armDesktopWorkload(draws: DesktopDraws, caps: DesktopCaps) {
  if (draws !== 20000 && draws !== 50000) throw new Error("Unbounded desktop draw workload");
  const controlExit = await stopTriangle();
  exit(controlExit);
  await serviceCommand("fairness-settled");
  const armed = qualificationRecord(await serviceCommand("fairness-arm"));
  if (armed.observerError || !armed.coverage || armed.desktopCaps !== caps)
    throw new Error(`Desktop native coverage/cap control failed: ${JSON.stringify(armed)}`);
  await launchTriangle(
    [draws === 20000 ? "--desktop-heavy-20k" : "--desktop-heavy-50k"],
    "gpu",
    0,
    true,
  );
  await checkpoint("GPU_WAIT_STDIN stage=fairness-heavy-ready");
  await launchTriangle(["green", "--fairness-peer"], "gpu", 1, true);
  await checkpoint("GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
  return { controlExit, armed, ready: await serviceCommand("snapshot") };
}
/** @browserEntry */
export async function runDesktopWorkload(draws: DesktopDraws) {
  if (draws !== 20000 && draws !== 50000) throw new Error("Unbounded desktop draw workload");
  if (feedTriangle("\n".repeat(127) + "q", 1) !== 128 || feedTriangle("\n", 0) !== 1)
    throw new Error("Desktop stdin did not publish every peer/heavy byte");
  await checkpoint(`GPU_FAIRNESS_REPLAYED draws=${draws}`);
  await checkpoint("GPU_FRAME colour=red frame=1 validation=none");
  await checkpoint("GPU_STAGE closed", 1);
  return serviceCommand("fairness-settled");
}
/** @browserEntry */
export async function retireDesktopArm() {
  const exits = [await stopTriangle(), await stopTriangle(false, 1, false)];
  for (const value of exits) exit(value);
  return { exits, service: await serviceCommand("fairness-settled") };
}
/** @browserEntry */
export async function closeDesktopArm() {
  return closeIntegration();
}
