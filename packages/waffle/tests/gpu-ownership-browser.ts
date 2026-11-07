import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import { qualificationRecord as record } from "./fixtures/gpu/qualification-contract.js";

type Mode = "append" | "completions";
type PhaseName = "live" | "armed" | "blocked" | "retired" | "released";
const phaseNames: readonly PhaseName[] = ["live", "armed", "blocked", "retired", "released"];
export function entries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Missing ownership observation array");
  return value.map(record);
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid ownership observation number");
  return value;
}
export function owner(service: Record<string, unknown>, id: unknown, label: string) {
  const found = entries(service.owners).filter((item) => item.id === id);
  if (found.length !== 1) throw new Error(`Missing or duplicate ownership ${label}`);
  return found[0]!;
}
export function authority(value: Record<string, unknown>) {
  const reports = entries(value.ownAuthority);
  if (!reports.length) throw new Error("Missing own-guest authority report");
  for (const report of reports) {
    if (
      !Array.isArray(report.canaries) ||
      report.canaries.length < 33 ||
      !Array.isArray(report.leaks) ||
      report.leaks.length
    )
      throw new Error("Ownership authority canaries failed");
  }
}
export function importControls(phase: Record<string, unknown>) {
  const events = entries(phase.events);
  if (!events.length || events.some((event) => event.token !== phase.token))
    throw new Error("Missing correlated ownership import observations");
  for (const name of ["append", "completions"]) {
    const control = events.find(
      (event) => event.name === name && event.phase === "return" && event.result === 0,
    );
    if (
      !control ||
      !events.some(
        (event) => event.name === name && event.call === control.call && event.phase === "enter",
      )
    )
      throw new Error("Ownership import positive control missing in victim process");
  }
  return events;
}
function importProof(phase: Record<string, unknown>, mode: Mode) {
  const events = importControls(phase);
  const last = events.at(-1)!;
  const entered = events.find((event) => event.call === last.call && event.phase === "enter");
  if (
    last.name !== mode ||
    last.phase !== "wait" ||
    !entered ||
    entered.connection !== 1 ||
    !Number.isSafeInteger(last.call)
  )
    throw new Error("Kill was not inside the selected actual import");
  if (events.filter((event) => event.call === last.call).length !== 2)
    throw new Error("Selected import already returned or threw");
  if (mode === "append" && number(entered.length) <= 4 * 1024 * 1024)
    throw new Error("Blocked append was not the compiled oversized blob");
}
function blockedProof(
  service: Record<string, unknown>,
  victim: Record<string, unknown>,
  mode: Mode,
) {
  if (service.held !== true || victim.state !== "ready")
    throw new Error("Victim gate did not hold a live import");
  const commands = record(victim.commands),
    replies = record(victim.replies);
  if (commands.terminal !== 0 || replies.terminal !== 0)
    throw new Error("Import already terminal before kill");
  if (mode === "append") {
    if (
      victim.partial !== true ||
      victim.frame !== true ||
      victim.presenter !== true ||
      victim.devices !== 1 ||
      number(victim.heldReads) < 1 ||
      number(victim.ringReads) < 1 ||
      commands.writer !== 1 ||
      number(commands.capacity) - number(commands.used) >= number(victim.chunkBytes) ||
      number(victim.chunkBytes) === 0 ||
      number(victim.logicalBytes) <= number(commands.capacity) + number(victim.chunkBytes)
    )
      throw new Error("Blocked append lacks held partial consumption and a full writer ring");
    return;
  }
  if (
    service.nativeHeld !== true ||
    victim.pending !== 1 ||
    victim.created !== 1 ||
    victim.destroyed !== 0 ||
    replies.used !== 0 ||
    victim.devices !== 0
  )
    throw new Error("Blocked completion lacks an empty reply ring and held native result");
}
function retiredProof(victim: Record<string, unknown>, mode: Mode, late: boolean) {
  if (
    victim.state !== "terminal" ||
    victim.retiredAck !== true ||
    victim.readerDisposed !== true ||
    victim.partial !== false ||
    victim.devices !== 0 ||
    victim.pending !== 0 ||
    victim.payloadBytes !== 0 ||
    victim.replayBusy !== false ||
    victim.presenter !== false ||
    victim.frame !== false ||
    number(record(victim.commands).terminal) === 0 ||
    number(record(victim.replies).terminal) === 0
  )
    throw new Error("Victim resources did not retire");
  const expected = mode === "append" || late ? victim.created : 0;
  if (victim.destroyed !== expected)
    throw new Error(
      late ? "Late native result survived release" : "Victim native device did not retire",
    );
}
export function peerProof(value: Record<string, unknown>, expected: Record<string, unknown>) {
  if (
    ["id", "grant", "surface", "device"].some(
      (key) =>
        value[key] !== expected[key] ||
        !Number.isSafeInteger(value[key]) ||
        number(value[key]) === 0,
    ) ||
    value.state !== "ready" ||
    value.devices !== 1 ||
    value.created !== 1 ||
    value.destroyed !== 0 ||
    value.retiredAck !== false ||
    value.readerDisposed !== false
  )
    throw new Error("Ownership peer disappeared or was replaced");
}
export function timing(service: Record<string, unknown>, peer: unknown) {
  const observed = record(service.fairness);
  if (observed.overflow !== false) throw new Error("Ownership observer overflow");
  const slices = entries(observed.slices).map((slice) => ({
    ...slice,
    ms: number(slice.end) - number(slice.start),
  }));
  const presents = entries(observed.presents).filter((present) => present.connection === peer);
  const gaps = presents
    .slice(1)
    .map((present, index) => number(present.at) - number(presents[index]!.at));
  if (!slices.length || slices.some((slice) => slice.ms < 0) || gaps.some((gap) => gap < 0))
    throw new Error("Invalid ownership timing observations");
  const maxSliceMs = Math.max(...slices.map((slice) => slice.ms));
  const maxPeerGapMs = Math.max(0, ...gaps);
  return {
    targets: { sliceMs: 8, peerGapMs: 100 },
    maxSliceMs,
    maxPeerGapMs,
    sliceTargetMet: maxSliceMs <= 8,
    peerGapTargetMet: maxPeerGapMs <= 100,
    targetStatus: maxSliceMs <= 8 && maxPeerGapMs <= 100 ? "met" : "not-met",
    slices,
    gaps,
    hardwareQualified: false,
  };
}
function validatePhases(result: Record<string, unknown>, mode: Mode) {
  const phases = entries(result.phases);
  if (phases.length !== phaseNames.length) throw new Error("Missing ownership phases");
  const live = record(phases[0]!.service),
    expectedPeer = owner(live, result.peer, "peer");
  let serial = 0,
    at = 0,
    presents = 0;
  const responses = new Set<unknown>();
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!,
      service = record(phase.service);
    if (
      phase.name !== phaseNames[index] ||
      (index >= 2 && phase.pid !== phases[2]!.pid) ||
      phase.peerPid !== phases[0]!.peerPid ||
      service.realm !== live.realm ||
      typeof service.realm !== "string" ||
      !service.realm ||
      service.armed !== index >= 1 ||
      service.token !== result.token ||
      service.mode !== mode ||
      number(service.serial) <= serial ||
      number(service.at) <= at ||
      typeof service.responseId !== "string" ||
      responses.has(service.responseId)
    )
      throw new Error("Stale or uncorrelated ownership snapshot");
    serial = number(service.serial);
    at = number(service.at);
    responses.add(service.responseId);
    peerProof(owner(service, result.peer, "peer"), expectedPeer);
    const nextPresents = entries(record(service.fairness).presents).filter(
      (present) => present.connection === result.peer,
    ).length;
    if (nextPresents <= presents)
      throw new Error("Same peer did not produce new native presents across every phase");
    presents = nextPresents;
    const image = record(phase.pixels);
    assertTrianglePixels(
      { center: numericArray(image.center), corner: numericArray(image.corner) },
      "green",
    );
    if (index >= 3) retiredProof(owner(service, result.victim, "victim"), mode, index === 4);
  }
  return phases;
}
export function accounting(value: unknown, liveCount: number, retiredCount: number) {
  const snapshot = record(value);
  const controls = entries(snapshot.holders).filter((holder) => holder.label === "guest-control");
  const live = controls.filter((holder) => holder.state === "live");
  const retired = controls.filter((holder) => holder.state !== "live");
  if (
    record(snapshot.platform).kind !== "bounded" ||
    live.length !== liveCount ||
    retired.length !== retiredCount ||
    live.some((holder) => record(holder.shape).length !== 64 * 1024 * 1024)
  )
    throw new Error("Ownership shared-control live accounting changed");
  if (
    retired.some(
      (holder) =>
        (holder.state !== "debt" && holder.state !== "awaiting-collection") ||
        record(holder.shape).length !== 5_505_220,
    )
  )
    throw new Error("Ownership shared-control monotonic debt was reset or mischarged");
}
export function stableRetirement(
  blocked: Record<string, unknown>,
  retired: Record<string, unknown>,
  released: Record<string, unknown>,
) {
  for (const key of ["grant", "surface", "device", "created"]) {
    const expected = number(blocked[key]);
    if (
      !Number.isSafeInteger(expected) ||
      expected === 0 ||
      retired[key] !== expected ||
      released[key] !== expected
    )
      throw new Error("Victim ownership changed across retirement");
  }
  for (const name of ["commands", "replies"]) {
    const before = record(retired[name]),
      after = record(released[name]);
    for (const key of ["head", "tail", "terminal"]) {
      number(before[key]);
      number(after[key]);
    }
    if (["head", "tail", "terminal"].some((key) => before[key] !== after[key]))
      throw new Error("Late work published to retired victim rings");
  }
}
function heapCreditProof(
  phases: readonly Record<string, unknown>[],
  victim: Record<string, unknown>,
  mode: Mode,
) {
  const heap = phases.map((phase) => number(record(phase.service).heapBytes));
  if (heap.some((bytes) => !Number.isSafeInteger(bytes)))
    throw new Error("Invalid service heap credit byte count");
  const peer = heap[1]!;
  if (heap[0] !== peer || heap[3] !== peer || heap[4] !== peer)
    throw new Error("Victim service heap credit did not return to the stable peer baseline");
  const partial = mode === "append" ? number(victim.logicalBytes) : 0;
  if (heap[2]! - peer < partial)
    throw new Error("Blocked partial assembly service credit is missing");
}
/** Independent, fail-closed validation. Timings retain unchanged targets, not a hardware verdict. */
export function validateOwnershipResult(value: unknown) {
  const result = record(value),
    coverage = record(result.coverage);
  for (const name of [
    "draw",
    "finish",
    "submit",
    "transferToImageBitmap",
    "transferFromImageBitmap",
  ]) {
    if (number(record(coverage.native)[name]) < 1)
      throw new Error("Ownership native positive coverage missing");
  }
  const mode = result.kind;
  if (mode !== "append" && mode !== "completions") throw new Error("Unknown ownership case");
  if (
    ["readerReads", "ringReads", "disposed", "destroyed", "nativeRequests", "presents"].some(
      (key) => number(coverage[key]) < 1,
    )
  )
    throw new Error("Ownership positive coverage missing");
  if (
    !Number.isSafeInteger(result.peer) ||
    !Number.isSafeInteger(result.victim) ||
    result.peer === result.victim
  )
    throw new Error("Ownership peer and victim identities missing or aliased");
  const phases = validatePhases(result, mode);
  const blocked = phases[2]!,
    blockedService = record(blocked.service);
  importProof(blocked, mode);
  authority({
    ownAuthority: entries(blocked.events)
      .filter((event) => event.phase === "enter")
      .map((event) => event.authority),
  });
  const blockedVictim = owner(blockedService, result.victim, "victim");
  blockedProof(blockedService, blockedVictim, mode);
  heapCreditProof(phases, blockedVictim, mode);
  const released = record(phases[4]!.service);
  if (
    released.released !== true ||
    (mode === "completions" && (released.nativeReleased !== true || released.nativeHeld !== false))
  )
    throw new Error("Late release did not settle");
  const stop = record(result.stop),
    exit = record(stop.exit);
  if (
    exit.kind !== "signaled" ||
    exit.code !== 9 ||
    stop.pid !== blocked.pid ||
    stop.grantRetired !== true ||
    stop.physicallyStopped !== true
  )
    throw new Error("Ownership SIGKILL physical stop or grant acknowledgement missing");

  const controlExit = record(result.controlExit);
  const controlOutcome = record(controlExit.exit);
  if (controlOutcome.kind !== "exited" || controlOutcome.code !== 0)
    throw new Error("Ownership compiled positive control did not close normally");
  authority(controlExit);
  const peerExit = record(result.peerExit),
    peerOutcome = record(peerExit.exit);
  if (
    peerExit.pid !== phases[0]!.peerPid ||
    peerOutcome.kind !== "exited" ||
    peerOutcome.code !== 0
  )
    throw new Error("Ownership peer did not close normally");
  authority(peerExit);
  accounting(stop.snapshot, 2, 2);
  accounting(peerExit.snapshot, 1, 3);
  const retired = record(phases[3]!.service);
  stableRetirement(
    blockedVictim,
    owner(retired, result.victim, "victim"),
    owner(released, result.victim, "victim"),
  );
  if (
    retired.connections !== 1 ||
    released.connections !== 1 ||
    retired.devicesLive !== 1 ||
    released.devicesLive !== 1
  )
    throw new Error("Victim retirement changed the live peer cohort");
  assertRetired(result.final);
  return timing(released, result.peer);
}
function numericArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("Missing ownership pixels");
  return value.map(number);
}
export async function checkpoint(page: Page, marker: string, slot = 0) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await invoke(page, "drainTriangle", [slot, false]);
    if (value.errors.length || value.text.includes("GPU_FAIL"))
      throw new Error(`Ownership guest failed: ${JSON.stringify(value)}`);
    if (value.text.includes(marker)) return;
  }
  throw new Error(`Ownership guest checkpoint deadline: ${marker}`);
}
export async function current(page: Page) {
  const value = record(await invoke(page, "serviceCommand", ["ownership-snapshot"]));
  if (value.observerError) throw new Error(String(value.observerError));
  return value;
}
export async function until(page: Page, ready: (value: Record<string, unknown>) => boolean) {
  const deadline = Date.now() + 15000;
  let last: unknown;
  while (Date.now() < deadline) {
    const value = await current(page);
    last = value;
    if (ready(value)) return value;
  }
  throw new Error(
    `Ownership correlated service checkpoint deadline: ${JSON.stringify(last && { ...record(last), fairness: undefined })}`,
  );
}
async function phase(
  page: Page,
  details: {
    name: PhaseName;
    token: string;
    mode: Mode;
    peer: number;
    previousPresents: number;
    peerPid: number;
  },
) {
  const { name, token, mode, peer, previousPresents, peerPid } = details;
  await until(
    page,
    (service) =>
      entries(record(service.fairness).presents).filter((present) => present.connection === peer)
        .length > previousPresents,
  );
  const image = await pixels(page, 1, false);
  assertTrianglePixels(image, "green");
  const service = await current(page);
  if (service.token !== token || service.mode !== mode)
    throw new Error("Ownership phase selection missing");
  const guest =
    name === "live" || name === "armed" ? {} : record(await invoke(page, "ownershipGuest", [2]));
  return { name, ...guest, peerPid, pixels: image, service };
}
async function ownershipCase(page: Page, mode: Mode) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  try {
    const surface = await invoke(page, "ownershipSurface");
    const token = crypto.randomUUID();
    await invoke(page, "launchTriangle", [["--pause-acquired"], "gpu", 0, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=acquired");
    const incomplete = record(
      await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode }]),
    );
    if (!String(incomplete.observerError).includes("coverage"))
      throw new Error("Missing observer proof incorrectly armed");
    const control = record(await invoke(page, "ownershipGuest"));
    importControls(control);
    await invoke(page, "feedTriangle");
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlExit = await invoke(page, "stopTriangle");
    authority(record(controlExit));
    assertRetired(controlExit.service);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    await invoke(page, "ownershipPeer", [true]);
    const victimSurface = await invoke(page, "ownershipSurface", [2]);
    const beforeArm = record(
      await invoke(page, "serviceCommand", [
        "ownership-observe",
        { token, surface: victimSurface, mode },
      ]),
    );
    const peerOwner = entries(beforeArm.owners).find((entry) => entry.state === "ready");
    if (!peerOwner) throw new Error("Ownership live peer missing");
    const peer = number(peerOwner.id);
    const phases: Awaited<ReturnType<typeof phase>>[] = [];
    const capture = async (name: PhaseName) => {
      const previous = phases.at(-1)?.service ?? beforeArm;
      const value = await phase(page, {
        name,
        token,
        mode,
        peer,
        peerPid: number(peerGuest.pid),
        previousPresents: presentCount(previous, peer),
      });
      phases.push(value);
    };
    await capture("live");
    const armed = record(
      await invoke(page, "serviceCommand", [
        "ownership-arm",
        { token, surface: victimSurface, mode },
      ]),
    );
    if (armed.observerError) throw new Error(String(armed.observerError));
    await capture("armed");
    await invoke(page, "launchTriangle", [
      mode === "append" ? ["--fairness-heavy"] : [],
      "gpu",
      2,
      true,
    ]);
    if (mode === "append") {
      await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-heavy-ready", 2);
      await invoke(page, "feedTriangle", ["\n", 2]);
    }
    const held = await until(page, (service) => {
      const victim = entries(service.owners).find((entry) => entry.surface === victimSurface);
      if (!victim || service.held !== true) return false;
      const ring = record(victim.commands);
      return mode === "append"
        ? victim.partial === true &&
            ring.writer === 1 &&
            number(ring.capacity) - number(ring.used) < number(victim.chunkBytes)
        : service.nativeHeld === true && record(victim.replies).used === 0;
    });
    const victim = number(
      entries(held.owners).find((entry) => entry.surface === victimSurface)!.id,
    );
    const blockedGuest = record(await invoke(page, "ownershipGuest", [2]));
    importProof(blockedGuest, mode);
    await capture("blocked");
    const stop = await invoke(page, "stopTriangle", [true, 2]);
    await capture("retired");
    await invoke(page, "serviceCommand", ["ownership-release"]);
    await until(
      page,
      (service) =>
        mode === "append" ||
        (service.nativeReleased === true && owner(service, victim, "victim").destroyed === 1),
    );
    await capture("released");
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const diagnostics = await invoke(page, "drainTriangle", [2, false]);
    if (diagnostics.errors.length || diagnostics.text.includes("GPU_FAIL"))
      throw new Error(`Ownership guest diagnostics failed: ${JSON.stringify(diagnostics.errors)}`);
    const result = {
      authorityScope:
        "Victim entry checkpoint covers its prior completed imports, with poisoned intrinsics reinstalled before the blocked call. Physical stop can preclude a final authority report.",
      kind: mode,
      token,
      peer,
      victim,
      coverage: armed.coverage,
      beforeArm,
      phases,
      stop,
      peerExit,
      controlExit,
      final: await current(page),
    };
    const measurements = validateOwnershipResult(result);
    return { ...result, measurements };
  } finally {
    await invoke(page, "closeIntegration");
  }
}
function presentCount(service: Record<string, unknown>, peer: number) {
  return entries(record(service.fairness).presents).filter((present) => present.connection === peer)
    .length;
}
/** Always called by the existing blocking compiled runner. Unsupported engines invent no proof. */
export async function ownershipCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Ownership proof needs the registered browser");
  const results = [];
  for (const mode of ["append", "completions"] as const) {
    const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
    try {
      const page = await context.newPage();
      await navigateTestPage(page, url);
      results.push(await ownershipCase(page, mode));
    } finally {
      await context.close();
    }
  }
  return results;
}
