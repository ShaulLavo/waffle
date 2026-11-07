import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import { qualificationRecord as record } from "./fixtures/gpu/qualification-contract.js";
import {
  entries, number, owner, authority, importControls, peerProof, timing, accounting,
  stableRetirement, checkpoint, current, until, nativeCoverage, progress, peerAdvanced,
} from "./gpu-ownership-browser.js";

const names = ["live", "saturated", "refused", "capacity", "recovered", "retired"] as const;
const holders = [2, 3, 4, 5, 6, 7, 8];
const closing = [2, 3];

async function admissionCase(page: Page) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  try {
    const token = crypto.randomUUID();
    const missing = await invoke(page, "serviceCommand", ["admission-coverage"]);
    let rejected = false;
    try { nativeCoverage(record(missing).coverage); } catch { rejected = true; }
    if (!rejected) throw new Error("Missing admission positive coverage passed");
    await invoke(page, "launchTriangle", [[], "gpu", 0, true]);
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlExit = await invoke(page, "stopTriangle");
    assertRetired(controlExit.service);
    const coverage = record(await invoke(page, "serviceCommand", ["admission-coverage"])).coverage;
    nativeCoverage(coverage);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    await invoke(page, "ownershipPeer", [true]);
    const observed = record(await invoke(page, "serviceCommand", ["ownership-observe", {
      token, surface: peerGuest.surface, mode: "admission",
    }]));
    const peer = number(entries(observed.owners).find((entry) => entry.state === "ready")!.id);
    const phases: Record<string, unknown>[] = [];
    const capture = async (name: typeof names[number]) => {
      const previous = phases.at(-1);
      const last = progress(previous ? record(previous.service) : observed, peer);
      const before = await until(page, (service) => peerAdvanced(service, peer, last));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const start = progress(before, peer);
      const after = await until(page, (service) => peerAdvanced(service, peer, start, number(before.at)));
      phases.push({ name, peerPid: peerGuest.pid, before, service: after, pixels: image });
    };
    await capture("live");
    const cohort: unknown[] = [peerGuest];
    for (const slot of holders) {
      await invoke(page, "launchTriangle", [[], "gpu", slot, true]);
      await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none", slot);
      const guest = record(await invoke(page, "ownershipGuest", [slot]));
      importControls(guest);
      cohort.push(guest);
    }
    await capture("saturated");
    await invoke(page, "launchTriangle", [[], "gpu", 9, true]);
    const refusalGuest = await invoke(page, "ownershipGuest", [9]);
    const refusalStop = await invoke(page, "stopTriangle", [false, 9, false]);
    const refused = await invoke(page, "ownershipGuest", [9]);
    await capture("refused");
    const selected = [];
    for (const slot of closing) selected.push(await invoke(page, "stopTriangle", [false, slot]));
    await capture("capacity");
    await invoke(page, "launchTriangle", [[], "gpu", 10, true]);
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none", 10);
    assertTrianglePixels(await pixels(page, 10, false));
    const recovered = await invoke(page, "ownershipGuest", [10]);
    await capture("recovered");
    const endings = [];
    for (const slot of holders.filter((slot) => !closing.includes(slot)).concat([10]))
      endings.push(await invoke(page, "stopTriangle", [false, slot]));
    await capture("retired");
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const result = {
      kind: "global-admission", token, peer, cap: 8, coverage, controlExit, cohort,
      phases, refusalGuest, refused, refusalStop, selected, recovered, endings, peerExit,
      final: await current(page),
    };
    return { ...result, measurements: validateAdmissionResult(result) };
  } finally {
    await invoke(page, "closeIntegration");
  }
}

export function validateAdmissionResult(value: unknown) {
  const result = record(value);
  nativeCoverage(result.coverage);
  assertRetired(result.final);
  return timing(record(entries(result.phases).at(-1)!.service), result.peer);
}

/** The original C producer reaches the unmodified shared service's global admission policy. */
export async function admissionCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Admission proof needs the registered browser");
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await admissionCase(page);
  } finally { await context.close(); }
}
