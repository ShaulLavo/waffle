import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import { qualificationRecord as record } from "./fixtures/gpu/qualification-contract.js";
import {
  entries,
  number,
  owner,
  authority,
  importControls,
  peerProof,
  timing,
  accounting,
  stableRetirement,
  checkpoint,
  current,
  until,
} from "./gpu-ownership-browser.js";

type Mode = "header" | "chunk" | "nesting";
const names = ["live", "ready", "armed", "retired", "released"] as const;

function requireProof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Malformed isolation ${message}`);
}
function integer(value: unknown): number {
  const parsed = number(value);
  requireProof(Number.isSafeInteger(parsed), "invalid integer observation");
  return parsed;
}
function cleanGuest(value: unknown, expected?: Record<string, unknown>) {
  const guest = record(value);
  requireProof(
    typeof guest.token === "string" && guest.token.length > 0 && integer(guest.pid) > 0,
    "missing victim identity",
  );
  if (expected)
    requireProof(
      guest.pid === expected.pid && guest.token === expected.token,
      "replaced victim process",
    );
  const events = importControls(guest);
  const reports = events
    .filter((event) => event.phase === "enter")
    .map((event) => record(event.authority));
  authority({ ownAuthority: reports });
  for (const report of reports) {
    const labels = report.canaries;
    requireProof(
      Array.isArray(labels) &&
        labels.every((label) => typeof label === "string" && label.length > 0) &&
        new Set(labels).size === labels.length,
      "missing distinct authority canaries",
    );
  }
  if (expected) {
    const earlier = entries(expected.events);
    requireProof(
      events.length >= earlier.length &&
        JSON.stringify(events.slice(0, earlier.length)) === JSON.stringify(earlier),
      "victim authority interval rewritten or dropped",
    );
  }
  return guest;
}
/** The armed victim waits inside the compiled oversized append that the selected reader holds. */
function heldAppend(guest: Record<string, unknown>) {
  const events = entries(guest.events),
    last = events.at(-1)!;
  const entered = events.filter((event) => event.call === last.call);
  requireProof(
    last.name === "append" &&
      last.phase === "wait" &&
      Number.isSafeInteger(last.call) &&
      entered.length === 2 &&
      entered[0]!.phase === "enter" &&
      entered[0]!.connection === 1 &&
      integer(entered[0]!.length) > 4 * 1024 * 1024,
    "victim was not waiting inside the oversized append",
  );
  return integer(entered[0]!.length);
}
function nativeCoverage(value: unknown) {
  const coverage = record(value);
  for (const key of [
    "readerReads",
    "ringReads",
    "disposed",
    "destroyed",
    "nativeRequests",
    "presents",
  ])
    requireProof(integer(coverage[key]) > 0, "missing observer coverage");
  for (const key of [
    "draw",
    "finish",
    "submit",
    "transferToImageBitmap",
    "transferFromImageBitmap",
  ])
    requireProof(integer(record(coverage.native)[key]) > 0, "missing native observer coverage");
}
function retiredVictim(victim: Record<string, unknown>, mode: Mode, heap: number, held: Held) {
  requireProof(
    integer(victim.logicalBytes) === held.length,
    "assembled bytes are not the held append",
  );
  requireProof(
    victim.state === "terminal" &&
      victim.terminalReason === 2 &&
      record(victim.commands).terminal === 2 &&
      record(victim.replies).terminal === 2,
    "wrong protocol terminal reason",
  );
  requireProof(
    victim.readerDisposed === true &&
      victim.retiredAck === true &&
      victim.partial === false &&
      victim.devices === 0 &&
      victim.destroyed === 1 &&
      victim.pending === 0 &&
      victim.payloadBytes === 0 &&
      victim.replayBusy === false &&
      victim.presenter === false &&
      victim.frame === false,
    "unretired victim ownership",
  );
  requireProof(
    integer(victim[mode === "nesting" ? "protocolReplays" : "protocolReads"]) > 0,
    "missing production parser terminal observation",
  );
  if (mode !== "header")
    requireProof(
      integer(victim.peakHeap) >= heap + integer(victim.logicalBytes),
      "missing logical assembly service credit",
    );
}
/** The service stamps the victim's ring-read count at mutation, so it follows the armed hold. */
function injectionProof(value: unknown, victim: Record<string, unknown>, mode: Mode, held: Held) {
  const injection = record(value);
  const offset = mode === "header" ? 0 : mode === "chunk" ? 12 : 44;
  const before = mode === "header" ? 69636 : mode === "chunk" ? 65512 : 12;
  const after = mode === "header" ? 4294901761 : mode === "chunk" ? 65520 : 4097;
  requireProof(
    injection.owner === victim.id &&
      injection.mode === mode &&
      injection.offset === offset &&
      injection.before === before &&
      injection.after === after &&
      integer(injection.read) > held.ringReads &&
      integer(injection.read) <= integer(victim.ringReads),
    "missing correlated malformed byte observation",
  );
}
function progress(service: Record<string, unknown>, peer: unknown) {
  const fairness = record(service.fairness);
  requireProof(fairness.overflow === false, "observer overflow");
  const presents = entries(fairness.presents).filter((item) => item.connection === peer);
  const queue = entries(fairness.queue).filter(
    (item) => item.connection === peer && record(item.settlement).kind === "completed",
  );
  requireProof(presents.length > 0 && queue.length > 0, "missing native peer progress");
  for (const item of queue)
    requireProof(
      number(record(item.settlement).at) >= number(item.start),
      "invalid native queue progress",
    );
  return {
    presents: presents.length,
    queue: queue.length,
    presentAt: presents.reduce((latest, item) => Math.max(latest, number(item.at)), 0),
    queueAt: queue.reduce(
      (latest, item) => Math.max(latest, number(record(item.settlement).at)),
      0,
    ),
  };
}
function peerAdvanced(
  service: Record<string, unknown>,
  peer: unknown,
  previous: ReturnType<typeof progress>,
  since = 0,
): boolean {
  const next = progress(service, peer);
  return (
    next.presents > previous.presents &&
    next.queue > previous.queue &&
    next.presentAt >= since &&
    next.queueAt >= since
  );
}

type Sample = {
  realm: unknown;
  token: unknown;
  mode: Mode;
  index: number;
  serial: number;
  at: number;
  responses: Set<unknown>;
};
function sampleProof(service: Record<string, unknown>, state: Sample) {
  requireProof(
    service.realm === state.realm &&
      typeof service.realm === "string" &&
      service.realm.length > 0 &&
      service.token === state.token &&
      service.mode === state.mode &&
      service.armed === state.index >= 2 &&
      service.held === state.index >= 2 &&
      service.malformedReleased === state.index >= 3 &&
      state.index >= 3 === (service.injection !== undefined) &&
      state.index >= 4 === (service.late !== undefined) &&
      integer(service.serial) > state.serial &&
      number(service.at) > state.at &&
      typeof service.responseId === "string" &&
      service.responseId.length > 0 &&
      !state.responses.has(service.responseId),
    "stale or uncorrelated snapshot",
  );
  state.serial = integer(service.serial);
  state.at = number(service.at);
  state.responses.add(service.responseId);
}
type Held = { ringReads: number; length: number };
type Expected = {
  result: Record<string, unknown>;
  mode: Mode;
  baseline: number;
  readyHeap: number;
  victim: Record<string, unknown>;
  held?: Held;
};
function ownershipProof(service: Record<string, unknown>, index: number, expected: Expected) {
  const count = index === 1 || index === 2 ? 2 : 1;
  const peer = owner(service, expected.result.peer, "peer");
  requireProof(typeof peer.frame === "boolean", "missing peer frame observation");
  requireProof(peer.presenter === true, "missing peer presenter ownership");
  requireProof(
    service.connections === count &&
      service.devicesLive === count &&
      service.presentCanvasesLive === count &&
      service.frameTexturesLive === count - 1 + Number(peer.frame),
    `wrong live ownership cohort ${JSON.stringify({
      checkpoint: index,
      expectedConnections: count,
      connections: service.connections,
      devices: service.devicesLive,
      presenters: service.presentCanvasesLive,
      frames: service.frameTexturesLive,
    })}`,
  );
  requireProof(
    integer(service.heapBytes) === (count === 2 ? expected.readyHeap : expected.baseline),
    "service credit did not return to peer baseline",
  );
  // Owners also lists the earlier retired control guest, so live only proves the victim is absent.
  const victims = entries(service.owners).filter((item) => item.id === expected.result.victim);
  requireProof(index > 0 || !victims.length, "victim before launch");
  if (!index) return;
  const victim = owner(service, expected.result.victim, "victim");
  for (const key of ["id", "grant", "surface", "device", "created"])
    requireProof(
      integer(victim[key]) > 0 && victim[key] === expected.victim[key],
      "victim identity changed",
    );
  if (index >= 3) {
    requireProof(expected.held !== undefined, "retirement before the selected hold");
    retiredVictim(victim, expected.mode, expected.readyHeap, expected.held);
    injectionProof(service.injection, victim, expected.mode, expected.held);
    return;
  }
  requireProof(
    victim.state === "ready" &&
      victim.devices === 1 &&
      victim.created === 1 &&
      victim.destroyed === 0 &&
      victim.presenter === true &&
      victim.frame === true &&
      victim.readerDisposed === false &&
      victim.retiredAck === false &&
      integer(victim.readerReads) > 0 &&
      integer(victim.ringReads) > 0 &&
      record(victim.commands).terminal === 0 &&
      record(victim.replies).terminal === 0,
    "missing live victim positive coverage",
  );
  if (index === 1) requireProof(integer(victim.heldReads) === 0, "victim held before selection");
  if (index === 2)
    requireProof(
      integer(victim.heldReads) > 0 && integer(record(victim.commands).used) > 0,
      "missing selected victim gate",
    );
}
/** While held, the selected reader consumes no ring records; the mutation must come after it. */
function heldCheckpoint(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  guest: unknown,
  expected: Expected,
) {
  const start = owner(before, expected.result.victim, "victim"),
    end = owner(after, expected.result.victim, "victim");
  requireProof(
    start.ringReads === end.ringReads && integer(end.heldReads) >= integer(start.heldReads),
    "selected reader was not held across the armed checkpoint",
  );
  return { ringReads: integer(end.ringReads), length: heldAppend(record(guest)) };
}

function compiledFailure(value: unknown, mode: Mode): boolean {
  if (typeof value !== "string") return false;
  const lines = value.split("\n");
  const failures = lines.filter((line) => line.startsWith("GPU_FAIL"));
  if (failures.length !== 1) return false;
  if (mode !== "nesting") return failures[0] === "GPU_FAIL stage=fairness-append status=-64";
  const unexpected = lines.filter((line) => line.startsWith("GPU_UNEXPECTED"));
  return (
    failures[0] === "GPU_FAIL stage=unexpected-completion status=-28" &&
    unexpected.length === 1 &&
    unexpected[0] === "GPU_UNEXPECTED kind=12 token=0" &&
    lines.includes("GPU_FAIRNESS_PUBLISHED")
  );
}

/** Acceptance consumes scalar observations only and checks every screenshot bracket. */
export function validateMalformedResult(value: unknown) {
  const result = record(value),
    mode = result.kind;
  requireProof(mode === "header" || mode === "chunk" || mode === "nesting", "unknown case");
  requireProof(
    typeof result.token === "string" &&
      result.token.length > 0 &&
      integer(result.peer) > 0 &&
      integer(result.victim) > 0 &&
      result.peer !== result.victim,
    "missing case correlation",
  );
  nativeCoverage(result.coverage);
  const phases = entries(result.phases);
  requireProof(phases.length === names.length, "missing checkpoints");
  const first = record(phases[0]!.service),
    ready = record(phases[1]!.service);
  const expectedPeer = owner(first, result.peer, "peer"),
    expectedVictim = owner(ready, result.victim, "victim");
  const baseline = integer(first.heapBytes),
    readyHeap = integer(ready.heapBytes);
  requireProof(readyHeap > baseline, "missing positive victim service credit");
  const expectedGuest = cleanGuest(phases[1]!.guest);
  requireProof(phases[0]!.guest === undefined, "victim guest before launch");
  const state: Sample = {
    realm: first.realm,
    token: result.token,
    mode,
    index: 0,
    serial: 0,
    at: 0,
    responses: new Set<unknown>(),
  };
  const expected: Expected = { result, mode, baseline, readyHeap, victim: expectedVictim };
  let presents = 0,
    queue = 0,
    guest = expectedGuest;
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    requireProof(
      phase.name === names[index] &&
        integer(phase.peerPid) > 0 &&
        phase.peerPid === phases[0]!.peerPid,
      "missing or replaced peer checkpoint",
    );
    if (index) guest = cleanGuest(phase.guest, guest);
    state.index = index;
    const before = record(phase.before),
      after = record(phase.service);
    for (const service of [before, after]) {
      sampleProof(service, state);
      peerProof(owner(service, result.peer, "peer"), expectedPeer);
      ownershipProof(service, index, expected);
    }
    if (index === 2) expected.held = heldCheckpoint(before, after, phase.guest, expected);
    const start = progress(before, result.peer),
      end = progress(after, result.peer);
    requireProof(
      start.presents > presents &&
        start.queue > queue &&
        end.presents > start.presents &&
        end.queue > start.queue,
      "missing fresh native peer progress at checkpoint",
    );
    requireProof(
      end.presentAt >= number(before.at) &&
        end.presentAt <= number(after.at) &&
        end.queueAt >= number(before.at) &&
        end.queueAt <= number(after.at),
      "missing fresh native peer observation inside screenshot bracket",
    );
    presents = end.presents;
    queue = end.queue;
    const image = record(phase.pixels);
    assertTrianglePixels(
      { center: entriesOfNumbers(image.center), corner: entriesOfNumbers(image.corner) },
      "green",
    );
  }
  const retired = record(phases[3]!.service),
    released = record(phases[4]!.service);
  const retiredOwner = owner(retired, result.victim, "victim"),
    releasedOwner = owner(released, result.victim, "victim");
  stableRetirement(expectedVictim, retiredOwner, releasedOwner);
  // The late probe re-reads the retired reader, which reports reason 2 again; it may consume no ring record.
  requireProof(
    JSON.stringify(retired.injection) === JSON.stringify(released.injection) &&
      ["ringReads", "logicalBytes", "protocolReplays", "peakHeap"].every(
        (key) => integer(retiredOwner[key]) === integer(releasedOwner[key]),
      ),
    "retired victim consumed or published work after retirement",
  );
  const late = record(released.late);
  requireProof(
    late.kind === "terminal" && late.reason === 2 && late.reads === 0,
    "late original work revived",
  );
  const stop = record(result.stop),
    exit = record(stop.exit);
  requireProof(
    stop.pid === expectedGuest.pid &&
      exit.kind === "exited" &&
      exit.code === 1 &&
      stop.grantRetired === true &&
      stop.physicallyStopped === true &&
      compiledFailure(stop.text, mode),
    "missing compiled victim failure and physical retirement",
  );
  authority(stop);
  const control = record(result.controlExit),
    peerExit = record(result.peerExit);
  for (const ending of [control, peerExit]) {
    requireProof(
      record(ending.exit).kind === "exited" && record(ending.exit).code === 0,
      "positive guest failed",
    );
    authority(ending);
  }
  requireProof(peerExit.pid === phases[0]!.peerPid, "replaced peer at exit");
  accounting(stop.snapshot, 2, 2);
  accounting(peerExit.snapshot, 1, 3);
  assertRetired(result.final);
  return timing(released, result.peer);
}
function entriesOfNumbers(value: unknown): number[] {
  requireProof(Array.isArray(value), "missing pixels");
  return value.map(number);
}

async function malformedCase(page: Page, mode: Mode) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  try {
    const token = crypto.randomUUID();
    await invoke(page, "launchTriangle", [["--pause-acquired"], "gpu", 0, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=acquired");
    const surface = await invoke(page, "ownershipSurface", [2]);
    const incomplete = record(
      await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode }]),
    );
    if (!String(incomplete.observerError).includes("coverage"))
      throw new Error("Missing positive coverage armed");
    await invoke(page, "feedTriangle");
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlExit = await invoke(page, "stopTriangle");
    assertRetired(controlExit.service);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    await invoke(page, "ownershipPeer", [true]);
    const observed = record(
      await invoke(page, "serviceCommand", ["ownership-observe", { token, surface, mode }]),
    );
    const peer = number(entries(observed.owners).find((entry) => entry.state === "ready")!.id);
    const phases: Record<string, unknown>[] = [];
    const capture = async (name: (typeof names)[number]) => {
      const previous = phases.at(-1);
      const previousProgress = progress(previous ? record(previous.service) : observed, peer);
      const before = await until(page, (service) => peerAdvanced(service, peer, previousProgress));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const guest = name === "live" ? undefined : await invoke(page, "ownershipGuest", [2]);
      const start = progress(before, peer);
      const after = await until(page, (service) =>
        peerAdvanced(service, peer, start, number(before.at)),
      );
      phases.push({
        name,
        before,
        peerPid: peerGuest.pid,
        guest,
        pixels: image,
        service: after,
      });
    };
    await capture("live");
    await invoke(page, "launchTriangle", [["--fairness-heavy"], "gpu", 2, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-heavy-ready", 2);
    const guest = record(await invoke(page, "ownershipGuest", [2]));
    importControls(guest);
    const victim = number(
      entries((await current(page)).owners).find((entry) => entry.surface === surface)!.id,
    );
    await capture("ready");
    const armed = record(
      await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode }]),
    );
    if (armed.observerError) throw new Error(String(armed.observerError));
    await invoke(page, "feedTriangle", ["\n", 2]);
    await until(
      page,
      (service) =>
        service.held === true && number(record(owner(service, victim, "victim").commands).used) > 0,
    );
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
    const result = {
      kind: mode,
      token,
      peer,
      victim,
      coverage: armed.coverage,
      phases,
      stop,
      peerExit,
      controlExit,
      final: await current(page),
    };
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
