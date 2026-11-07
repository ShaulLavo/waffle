import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import { qualificationRecord as record } from "./fixtures/gpu/qualification-contract.js";
import {
  entries, number, owner, authority, importControls, peerProof, timing, accounting,
  stableRetirement, checkpoint, current, until, presentCount,
} from "./gpu-ownership-browser.js";

type Mode = "header" | "chunk" | "nesting";
const names = ["live", "ready", "armed", "retired", "released"] as const;

export function validateMalformedResult(value: unknown) {
  void value;
  return {};
}

async function malformedCase(page: Page, mode: Mode) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  try {
    const token = crypto.randomUUID();
    await invoke(page, "launchTriangle", [["--pause-acquired"], "gpu", 0, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=acquired");
    const surface = await invoke(page, "ownershipSurface", [2]);
    const incomplete = record(await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode }]));
    if (!String(incomplete.observerError).includes("coverage")) throw new Error("Missing positive coverage armed");
    await invoke(page, "feedTriangle");
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlExit = await invoke(page, "stopTriangle");
    assertRetired(controlExit.service);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    await invoke(page, "ownershipPeer", [true]);
    const observed = record(await invoke(page, "serviceCommand", ["ownership-observe", { token, surface, mode }]));
    const peer = number(entries(observed.owners).find((entry) => entry.state === "ready")!.id);
    const phases: Record<string, unknown>[] = [];
    const capture = async (name: typeof names[number]) => {
      const previous = phases.at(-1);
      await until(page, (service) => presentCount(service, peer) > presentCount(previous ? record(previous.service) : observed, peer));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const guest = name === "live" ? undefined : await invoke(page, "ownershipGuest", [2]);
      phases.push({ name, peerPid: peerGuest.pid, guest, pixels: image, service: await current(page) });
    };
    await capture("live");
    await invoke(page, "launchTriangle", [["--fairness-heavy"], "gpu", 2, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-heavy-ready", 2);
    const guest = record(await invoke(page, "ownershipGuest", [2]));
    importControls(guest);
    const victim = number(entries((await current(page)).owners).find((entry) => entry.surface === surface)!.id);
    await capture("ready");
    const armed = record(await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode }]));
    if (armed.observerError) throw new Error(String(armed.observerError));
    await invoke(page, "feedTriangle", ["\n", 2]);
    await until(page, (service) => service.held === true && number(record(owner(service, victim, "victim").commands).used) > 0);
    await capture("armed");
    await invoke(page, "serviceCommand", ["malformed-release"]);
    await until(page, (service) => owner(service, victim, "victim").retiredAck === true);
    await capture("retired");
    const stop = await invoke(page, "stopTriangle", [false, 2, false]);
    await invoke(page, "serviceCommand", ["malformed-late"]);
    await capture("released");
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const result = { kind: mode, token, peer, victim, coverage: armed.coverage, phases, stop, peerExit, controlExit, final: await current(page) };
    return { ...result, measurements: validateMalformedResult(result) };
  } finally {
    await invoke(page, "closeIntegration");
  }
}

/** Real compiled guests share one service. Byte mutations stay in its private reader closure. */
export async function malformedCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Malformed proof needs the registered browser");
  const results = [];
  for (const mode of ["header", "chunk", "nesting"] as const) {
    const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
    try {
      const page = await context.newPage();
      await navigateTestPage(page, url);
      results.push(await malformedCase(page, mode));
    } finally {
      await context.close();
    }
  }
  return results;
}
