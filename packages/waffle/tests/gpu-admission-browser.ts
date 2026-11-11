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
  nativeCoverage,
  progress,
  peerAdvanced,
} from "./gpu-ownership-browser.js";

const names = [
  "live",
  "saturated",
  "refused",
  "refusal-retired",
  "capacity",
  "recovered",
  "retired",
] as const;
const holders = [2, 3, 4, 5, 6, 7, 8];
const closing = [2, 3];

async function admissionCase(page: Page) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  let closed = false;
  try {
    const token = crypto.randomUUID();
    const missing = await invoke(page, "serviceCommand", ["admission-coverage"]);
    let rejected = false;
    try {
      nativeCoverage(record(missing).coverage);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Missing admission positive coverage passed");
    await invoke(page, "launchTriangle", [[], "gpu", 0, true]);
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlGuest = await invoke(page, "ownershipGuest");
    const controlExit = await invoke(page, "stopTriangle");
    assertRetired(controlExit.service);
    const coverage = record(await invoke(page, "serviceCommand", ["admission-coverage"])).coverage;
    nativeCoverage(coverage);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    await invoke(page, "ownershipPeer", [true]);
    const observed = record(
      await invoke(page, "serviceCommand", [
        "ownership-observe",
        {
          token,
          surface: peerGuest.surface,
          mode: "admission",
        },
      ]),
    );
    const peer = number(entries(observed.owners).find((entry) => entry.state === "ready")!.id);
    const phases: Record<string, unknown>[] = [];
    const capture = async (name: (typeof names)[number]) => {
      const previous = phases.at(-1);
      const last = progress(previous ? record(previous.service) : observed, peer);
      const before = await until(page, (service) => peerAdvanced(service, peer, last));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const recoveryPixels = name === "recovered" ? await pixels(page, 10, false) : undefined;
      if (recoveryPixels) assertTrianglePixels(recoveryPixels);
      const after = await screenshotEnd(page, peer, before);
      phases.push({
        name,
        peerPid: peerGuest.pid,
        before,
        service: after,
        pixels: image,
        recoveryPixels,
      });
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
    const refusedSurface = await invoke(page, "ownershipSurface", [9]);
    await until(page, (service) =>
      entries(service.attempts).some(
        (attempt) => attempt.surface === refusedSurface && attempt.status === -48,
      ),
    );
    await capture("refused");
    const refusalStop = await invoke(page, "stopTriangle", [false, 9, false]);
    const refused = await invoke(page, "ownershipGuest", [9]);
    await capture("refusal-retired");
    const selected = [];
    for (const slot of closing) selected.push(await invoke(page, "stopTriangle", [false, slot]));
    await capture("capacity");
    await invoke(page, "launchTriangle", [[], "gpu", 10, true]);
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none", 10);
    const recovered = await invoke(page, "ownershipGuest", [10]);
    await capture("recovered");
    const endings = [];
    for (const slot of holders.filter((slot) => !closing.includes(slot)).concat([10]))
      endings.push(await invoke(page, "stopTriangle", [false, slot]));
    await capture("retired");
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const final = await current(page);
    const runtimeStop = await invoke(page, "closeIntegration", [true]);
    closed = true;
    const result = {
      kind: "global-admission",
      token,
      peer,
      cap: 8,
      coverage,
      controlGuest,
      controlExit,
      cohort,
      phases,
      refused,
      refusalStop,
      selected,
      recovered,
      endings,
      peerExit,
      final,
      runtimeStop,
    };
    try {
      return { ...result, measurements: validateAdmissionResult(result) };
    } catch (error) {
      console.error(JSON.stringify({ stage: "admission-failed", result }));
      throw error;
    }
  } finally {
    if (!closed) await invoke(page, "closeIntegration");
  }
}

export async function admissionCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Admission proof needs the registered browser");
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await admissionCase(page);
  } finally {
    await context.close();
  }
}

function requireProof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`GPU admission ${message}`);
}
function integer(value: unknown): number {
  const parsed = number(value);
  requireProof(Number.isSafeInteger(parsed), "invalid integer observation");
  return parsed;
}
function distinct(values: readonly unknown[], label: string) {
  requireProof(new Set(values).size === values.length, `aliased ${label}`);
}
function attemptFor(service: Record<string, unknown>, surface: unknown) {
  const attempts = entries(service.attempts).filter((attempt) => attempt.surface === surface);
  requireProof(attempts.length === 1, "missing or duplicate original open attempt");
  return attempts[0]!;
}
function guestProof(value: unknown, refused = false) {
  const guest = record(value);
  requireProof(
    integer(guest.pid) > 0 &&
      integer(guest.surface) > 0 &&
      typeof guest.token === "string" &&
      guest.token.length > 0 &&
      typeof guest.text === "string",
    "missing compiled guest identity",
  );
  const events = entries(guest.events);
  requireProof(
    events.every((event) => event.token === guest.token),
    "uncorrelated import events",
  );
  const open = events.filter((event) => event.name === "open");
  requireProof(
    open.length === 2 &&
      open[0]!.call === 1 &&
      open[1]!.call === 1 &&
      open[0]!.phase === "enter" &&
      open[0]!.connection === 0 &&
      open[1]!.phase === "return" &&
      open[1]!.result === (refused ? -48 : 0),
    "wrong original open import outcome",
  );
  const lines = guest.text.split("\n");
  requireProof(
    lines.some((line) => line.startsWith(`GPU_STAGE surface id=${guest.surface} `)),
    "compiled guest surface correlation missing",
  );
  if (refused) {
    requireProof(
      events.length === 2 &&
        lines.filter((line) => line.startsWith("GPU_FAIL")).join("\n") ===
          "GPU_FAIL stage=open status=-48" &&
        !lines.includes("GPU_STAGE open"),
      "wrong compiled refusal stage or errno",
    );
    return guest;
  }
  importControls(guest);
  requireProof(
    !guest.text.includes("GPU_FAIL") && guest.text.includes("GPU_STAGE device"),
    "admitted compiled guest failed",
  );
  return guest;
}
interface Identity {
  readonly guest: Record<string, unknown>;
  readonly native: Record<string, unknown>;
}
function identity(guest: Record<string, unknown>, service: Record<string, unknown>): Identity {
  const attempt = attemptFor(service, guest.surface);
  const native = owner(service, attempt.owner, "admitted guest");
  requireProof(
    native.surface === guest.surface && native.grant === attempt.grant,
    "wrong guest/service correlation",
  );
  for (const key of ["id", "grant", "surface", "device"])
    requireProof(integer(native[key]) > 0, "missing native cohort identity");
  progress(service, native.id);
  return { guest, native };
}
function normalStop(value: unknown, guest: Record<string, unknown>) {
  const stop = record(value),
    exit = record(stop.exit);
  requireProof(
    stop.pid === guest.pid &&
      exit.kind === "exited" &&
      exit.code === 0 &&
      stop.grantRetired === true &&
      stop.physicallyStopped === true &&
      typeof stop.text === "string" &&
      !stop.text.includes("GPU_FAIL"),
    "admitted guest did not physically retire normally",
  );
  authority(stop);
  return stop;
}
function retired(native: Record<string, unknown>) {
  requireProof(
    native.state === "terminal" &&
      native.terminalReason === 1 &&
      native.readerDisposed === true &&
      native.retiredAck === true &&
      native.devices === 0 &&
      native.created === 1 &&
      native.destroyed === 1 &&
      native.pending === 0 &&
      native.payloadBytes === 0 &&
      native.replayBusy === false &&
      native.partial === false &&
      native.presenter === false &&
      native.frame === false &&
      record(native.commands).terminal === 1 &&
      record(native.replies).terminal === 1,
    "unretired admitted owner",
  );
}
export function immutableRetired(previous: Record<string, unknown>, next: Record<string, unknown>) {
  stableRetirement(previous, previous, next);
  for (const key of [
    "readerReads",
    "ringReads",
    "logicalBytes",
    "created",
    "destroyed",
    "protocolReads",
    "protocolReplays",
    "peakHeap",
  ])
    requireProof(integer(previous[key]) === integer(next[key]), "late retired owner work");
}
function refusedAttempt(
  service: Record<string, unknown>,
  guest: Record<string, unknown>,
  heap: number,
) {
  const attempt = attemptFor(service, guest.surface);
  requireProof(
    attempt.owner === null &&
      attempt.connection === 1 &&
      integer(attempt.grant) > 0 &&
      attempt.status === -48 &&
      attempt.reason === 3 &&
      attempt.arenaTerminal === 3 &&
      attempt.beforeConnections === 8 &&
      attempt.afterConnections === 8 &&
      attempt.beforeHeap === heap &&
      attempt.afterHeap === heap &&
      attempt.beforeNativeRequests === 9 &&
      attempt.afterNativeRequests === 9,
    "wrong correlated service cap or refusal",
  );
  for (const name of ["commands", "replies"]) {
    const ring = record(attempt[name]);
    requireProof(
      ring.terminal === 3 &&
        ring.head === 0 &&
        ring.tail === 0 &&
        ring.used === 0 &&
        ring.writer === 0,
      "refused open published or changed terminal",
    );
  }
  requireProof(
    !entries(service.owners).some(
      (native) => native.grant === attempt.grant || native.surface === guest.surface,
    ),
    "refused open acquired native ownership",
  );
  return attempt;
}
type Observation = {
  readonly token: unknown;
  readonly realm: unknown;
  serial: number;
  at: number;
  readonly responses: Set<unknown>;
};
function snapshotProof(service: Record<string, unknown>, observed: Observation) {
  requireProof(
    typeof service.realm === "string" &&
      service.realm.length > 0 &&
      service.realm === observed.realm &&
      service.token === observed.token &&
      service.mode === "admission" &&
      service.armed === false &&
      service.held === false &&
      service.released === false &&
      service.nativeHeld === false &&
      integer(service.serial) > observed.serial &&
      number(service.at) > observed.at &&
      typeof service.responseId === "string" &&
      service.responseId.length > 0 &&
      !observed.responses.has(service.responseId),
    "stale or uncorrelated snapshot",
  );
  observed.serial = integer(service.serial);
  observed.at = number(service.at);
  observed.responses.add(service.responseId);
}
export function bracketProof(
  phase: Record<string, unknown>,
  peer: unknown,
  previous: { presents: number; queue: number },
) {
  const before = record(phase.before),
    after = record(phase.service);
  const start = progress(before, peer),
    end = progress(after, peer);
  requireProof(
    start.presents > previous.presents &&
      start.queue > previous.queue &&
      end.presents > start.presents &&
      end.queue > start.queue,
    "missing fresh in-bracket native work",
  );
  const fairness = record(after.fairness);
  const newQueue = entries(fairness.queue)
    .filter((item) => item.connection === peer)
    .slice(start.queue);
  requireProof(
    newQueue.some(
      (item) =>
        record(item.settlement).kind === "completed" &&
        number(item.start) >= number(before.at) &&
        number(record(item.settlement).at) >= number(item.start) &&
        number(record(item.settlement).at) <= number(after.at),
    ),
    "stale in-bracket queue work",
  );
  requireProof(
    end.presentAt >= number(before.at) && end.presentAt <= number(after.at),
    "missing new in-bracket present",
  );
  const image = record(phase.pixels);
  requireProof(Array.isArray(image.center) && Array.isArray(image.corner), "missing pixels");
  assertTrianglePixels(
    { center: image.center.map(number), corner: image.corner.map(number) },
    "green",
  );
  return end;
}
function retiredActivity(service: Record<string, unknown>, id: unknown) {
  const observed = record(service.fairness);
  requireProof(observed.overflow === false, "retired native observation overflow");
  const owned = (name: string) => entries(observed[name]).filter((item) => item.connection === id);
  const queue = owned("queue"),
    presents = owned("presents");
  requireProof(
    presents.length > 0 && queue.some((work) => record(work.settlement).kind === "completed"),
    "missing native peer progress",
  );
  for (const work of queue) {
    const settlement = record(work.settlement),
      start = number(work.start);
    requireProof(
      settlement.kind === "pending" ||
        settlement.kind === "completed" ||
        settlement.kind === "rejected",
      "invalid retired queue settlement",
    );
    if (settlement.kind !== "pending")
      requireProof(number(settlement.at) >= start, "invalid retired queue settlement");
  }
  const calls = Object.fromEntries(
    Object.entries(record(observed.native))
      .filter(([key]) => key.startsWith(`${id}:`))
      .map(([key, value]) => [key, integer(record(value).count)]),
  );
  requireProof(Object.keys(calls).length > 0, "missing retired native call observations");
  return { at: number(service.at), presents, queue, slices: owned("slices"), calls };
}
export function unchangedSubmissions(
  previous: readonly Record<string, unknown>[],
  current: readonly Record<string, unknown>[],
  previousAt: number,
) {
  requireProof(current.length === previous.length, "late retired native work");
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!,
      after = current[index]!;
    requireProof(
      before.connection === after.connection && number(before.start) === number(after.start),
      "late retired native work",
    );
    if (record(before.settlement).kind === "pending") {
      const settled = record(after.settlement);
      requireProof(
        settled.kind === "pending" || number(settled.at) >= previousAt,
        "retired queue settlement predates its pending observation",
      );
      continue;
    }
    requireProof(
      JSON.stringify(before.settlement) === JSON.stringify(after.settlement),
      "retired queue settlement changed after completion",
    );
  }
}
interface Cohort {
  readonly all: readonly Identity[];
  readonly live: readonly Identity[];
  readonly heapUnit: number;
  readonly retired: Map<
    unknown,
    { native: Record<string, unknown>; activity: ReturnType<typeof retiredActivity> }
  >;
}
function retiredProgress(
  service: Record<string, unknown>,
  native: Record<string, unknown>,
  history: Cohort["retired"],
) {
  const previous = history.get(native.id),
    activity = retiredActivity(service, native.id);
  if (previous) {
    immutableRetired(previous.native, native);
    requireProof(
      JSON.stringify(activity.presents) === JSON.stringify(previous.activity.presents) &&
        JSON.stringify(activity.slices) === JSON.stringify(previous.activity.slices) &&
        JSON.stringify(activity.calls) === JSON.stringify(previous.activity.calls),
      "late retired native work",
    );
    unchangedSubmissions(previous.activity.queue, activity.queue, previous.activity.at);
  }
  history.set(native.id, { native, activity });
}

function cohortProof(service: Record<string, unknown>, cohort: Cohort) {
  const natives = entries(service.owners);
  const known = new Set(cohort.all.map((entry) => entry.native.id));
  const observed = record(service.fairness);
  for (const name of ["presents", "queue", "slices"])
    requireProof(
      entries(observed[name]).every((item) => known.has(item.connection)),
      "unowned native producer observation",
    );
  requireProof(
    natives.length === cohort.all.length &&
      service.connections === cohort.live.length &&
      service.devicesLive === cohort.live.length &&
      service.presentCanvasesLive === cohort.live.length &&
      integer(service.nativeRequests) === cohort.all.length,
    "wrong global live cohort or native producer count",
  );
  distinct(
    natives.map((native) => native.id),
    "service owners",
  );
  let frames = 0;
  for (const expected of cohort.all) {
    const native = owner(service, expected.native.id, "cohort member");
    for (const key of ["grant", "surface", "device", "created"])
      requireProof(native[key] === expected.native[key], "cohort identity replaced");
    if (!cohort.live.includes(expected)) {
      retired(native);
      retiredProgress(service, native, cohort.retired);
      continue;
    }
    peerProof(native, expected.native);
    requireProof(
      native.presenter === true &&
        typeof native.frame === "boolean" &&
        native.partial === false &&
        record(native.commands).terminal === 0 &&
        record(native.replies).terminal === 0 &&
        integer(native.readerReads) > 0 &&
        integer(native.ringReads) > 0,
      "missing live cohort positive coverage or presenter",
    );
    frames += Number(native.frame);
  }
  requireProof(service.frameTexturesLive === frames, "frame ownership count differs");
  requireProof(
    integer(service.heapBytes) === cohort.heapUnit * cohort.live.length,
    "unretired service heap credit",
  );
}
function admittedAttempts(
  service: Record<string, unknown>,
  all: readonly Identity[],
  live: readonly Identity[],
) {
  for (const expected of all) {
    const attempt = attemptFor(service, expected.guest.surface);
    const active = live.includes(expected),
      reason = active ? 0 : 1;
    requireProof(
      attempt.owner === expected.native.id &&
        attempt.grant === expected.native.grant &&
        attempt.connection === 1 &&
        attempt.status === (active ? 1 : -64) &&
        attempt.reason === reason &&
        attempt.arenaTerminal === reason &&
        attempt.retiredAck === !active &&
        record(attempt.commands).terminal === reason &&
        record(attempt.replies).terminal === reason &&
        integer(attempt.afterConnections) === integer(attempt.beforeConnections) + 1 &&
        integer(attempt.beforeConnections) < 8 &&
        integer(attempt.afterHeap) > integer(attempt.beforeHeap) &&
        attempt.afterNativeRequests === attempt.beforeNativeRequests,
      "wrong admitted original open observation",
    );
  }
}
function validateStops(
  result: Record<string, unknown>,
  cohort: readonly Identity[],
  recovery: Identity,
) {
  const refusal = record(result.refusalStop),
    exit = record(refusal.exit),
    guest = record(result.refused);
  requireProof(
    refusal.pid === guest.pid &&
      exit.kind === "exited" &&
      exit.code === 1 &&
      refusal.grantRetired === true &&
      refusal.physicallyStopped === true &&
      refusal.text === guest.text,
    "refused guest physical retirement missing",
  );
  authority(refusal);
  accounting(refusal.snapshot, 9, 2);
  const selected = entries(result.selected);
  requireProof(selected.length === 2, "wrong selected holder retirement count");
  selected.forEach((stop, index) => {
    normalStop(stop, cohort[index + 1]!.guest);
    accounting(stop.snapshot, 8 - index, 3 + index);
  });
  const endings = entries(result.endings),
    remaining = cohort.slice(3).concat([recovery]);
  requireProof(endings.length === remaining.length, "missing final cohort stops");
  endings.forEach((stop, index) => {
    normalStop(stop, remaining[index]!.guest);
    accounting(stop.snapshot, 7 - index, 5 + index);
  });
  const peerExit = normalStop(result.peerExit, cohort[0]!.guest);
  accounting(peerExit.snapshot, 1, 11);
}
function disposalProof(value: unknown) {
  const disposed = record(value),
    workers = entries(disposed.workers);
  requireProof(
    Array.isArray(disposed.errors) &&
      disposed.errors.length === 0 &&
      workers.length > 0 &&
      workers.every((worker) => worker.stopped === true),
    "runtime retained workers or errors",
  );
  accounting(disposed.snapshot, 0, 11);
  requireProof(
    entries(record(disposed.snapshot).holders).every((holder) => holder.state !== "live"),
    "runtime retained live shared admission",
  );
}

type PhaseProof = Cohort & {
  readonly observed: Observation;
  readonly refused: Record<string, unknown>;
  readonly index: number;
};
function phaseSnapshotProof(service: Record<string, unknown>, expected: PhaseProof) {
  snapshotProof(service, expected.observed);
  cohortProof(service, expected);
  admittedAttempts(service, expected.all, expected.live);
  requireProof(
    entries(service.attempts).length === expected.all.length + Number(expected.index >= 2),
    "unexpected service open attempts",
  );
  if (expected.index < 2) return;
  const refusal = refusedAttempt(service, expected.refused, expected.heapUnit * 8);
  requireProof(expected.index < 3 || refusal.retiredAck === true, "refused grant did not retire");
}

export function validateAdmissionResult(value: unknown) {
  const result = record(value);
  requireProof(
    result.kind === "global-admission" &&
      result.cap === 8 &&
      typeof result.token === "string" &&
      result.token.length > 0,
    "wrong case or global cap",
  );
  nativeCoverage(result.coverage);
  const phases = entries(result.phases);
  requireProof(phases.length === names.length, "missing checkpoint brackets");
  const saturated = record(phases[1]!.service),
    recovered = record(phases[5]!.service);
  const guests = entries(result.cohort).map((guest) => guestProof(guest));
  requireProof(guests.length === 8, "wrong admitted cohort size");
  const cohort = guests.map((guest) => identity(guest, saturated));
  const recovery = identity(guestProof(result.recovered), recovered);
  const control = identity(
    guestProof(result.controlGuest),
    record(record(result.controlExit).service),
  );
  const refused = guestProof(result.refused, true);
  const all = [control].concat(cohort, [recovery]);
  for (const key of ["pid", "surface", "token"])
    distinct(all.map((entry) => entry.guest[key]).concat([refused[key]]), `guest ${key}`);
  for (const key of ["id", "grant", "device"])
    distinct(
      all.map((entry) => entry.native[key]),
      `native ${key}`,
    );
  const first = record(phases[0]!.service),
    heapUnit = integer(first.heapBytes);
  requireProof(
    heapUnit > 0 && cohort[0]!.native.id === result.peer,
    "missing original peer baseline",
  );
  normalStop(result.controlExit, control.guest);
  accounting(record(result.controlExit).snapshot, 1, 1);
  const observed: Observation = {
    token: result.token,
    realm: first.realm,
    serial: 0,
    at: 0,
    responses: new Set(),
  };
  const retiredOwners: Cohort["retired"] = new Map();
  const peerOnly = [cohort[0]!],
    capacity = peerOnly.concat(cohort.slice(3));
  const liveCohorts = [
    peerOnly,
    cohort,
    cohort,
    cohort,
    capacity,
    capacity.concat([recovery]),
    peerOnly,
  ];
  let previous = { presents: 0, queue: 0 };
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    requireProof(
      phase.name === names[index] && phase.peerPid === cohort[0]!.guest.pid,
      "missing or replaced peer checkpoint",
    );
    const seen = index === 0 ? [control, cohort[0]!] : index >= 5 ? all : [control].concat(cohort);
    const live = liveCohorts[index]!;
    for (const service of [record(phase.before), record(phase.service)]) {
      phaseSnapshotProof(service, {
        all: seen,
        live,
        heapUnit,
        retired: retiredOwners,
        observed,
        refused,
        index,
      });
    }
    previous = bracketProof(phase, result.peer, previous);
    if (index === 5) {
      const image = record(phase.recoveryPixels);
      requireProof(
        Array.isArray(image.center) && Array.isArray(image.corner),
        "missing recovery pixels",
      );
      assertTrianglePixels({ center: image.center.map(number), corner: image.corner.map(number) });
    }
  }
  const final = record(result.final);
  snapshotProof(final, observed);
  cohortProof(final, { all, live: [], heapUnit, retired: retiredOwners });
  admittedAttempts(final, all, []);
  requireProof(entries(final.attempts).length === all.length + 1, "unexpected final open attempts");
  requireProof(
    refusedAttempt(final, refused, heapUnit * 8).retiredAck === true,
    "final refused grant live",
  );
  assertRetired(final);
  validateStops(result, cohort, recovery);
  disposalProof(result.runtimeStop);
  return timing(record(phases.at(-1)!.service), result.peer);
}

export async function screenshotEnd(page: Page, peer: unknown, before: Record<string, unknown>) {
  const start = progress(before, peer);
  return until(
    page,
    (service) =>
      peerAdvanced(service, peer, start, number(before.at)) &&
      entries(record(service.fairness).queue).some(
        (work) =>
          work.connection === peer &&
          number(work.start) >= number(before.at) &&
          record(work.settlement).kind === "completed",
      ),
  );
}
