import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import { qualificationRecord as record } from "./fixtures/gpu/qualification-contract.js";
import {
  checkpoint,
  current,
  until,
  entries,
  number,
  owner,
  progress,
  peerAdvanced,
  nativeCoverage,
  importControls,
  accounting,
  timing,
} from "./gpu-ownership-browser.js";
import {
  guest,
  identity,
  live,
  retired,
  cumulative,
  noRetiredWork,
  startOwnershipPeer,
} from "./gpu-regrant-browser.js";
import { bracketProof, screenshotEnd } from "./gpu-admission-browser.js";

async function disposalCase(page: Page) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "observeActiveDisposal");
  await invoke(page, "activateDisplay");
  try {
    const { controlGuest, controlExit, peerGuest } = await startOwnershipPeer(page);
    const token = crypto.randomUUID();
    const surface = await invoke(page, "ownershipSurface", [2]);
    const observed = record(
      await invoke(page, "serviceCommand", [
        "ownership-observe",
        { token, surface, mode: "disposal" },
      ]),
    );
    const peer = number(entries(observed.owners).find((item) => item.state === "ready")!.id);
    const phases: Record<string, unknown>[] = [];
    const capture = async (name: string) => {
      const previous = phases.at(-1);
      const last = progress(previous ? record(previous.service) : observed, peer);
      const before = await until(page, (service) => peerAdvanced(service, peer, last));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const service = await screenshotEnd(page, peer, before);
      phases.push({ name, peerPid: peerGuest.pid, before, service, pixels: image });
    };
    await capture("live");
    await invoke(page, "launchTriangle", [["--fairness-heavy"], "gpu", 2, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-heavy-ready", 2);
    const victimGuest = record(await invoke(page, "ownershipGuest", [2]));
    const ready = await current(page);
    const victim = number(entries(ready.owners).find((item) => item.surface === surface)!.id);
    const armed = record(
      await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode: "disposal" }]),
    );
    if (armed.observerError) throw new Error(String(armed.observerError));
    const auditControl = await invoke(page, "activeDisposalAuditControl");
    await invoke(page, "feedTriangle", ["\n", 2]);
    await until(
      page,
      (service) => service.nativeHeld === true && owner(service, victim, "held").pending === 1,
    );
    const blockedGuest = await invoke(page, "ownershipGuest", [2]);
    await capture("held");
    const disposal = await invoke(page, "disposeActiveIntegration");
    const result = {
      kind: "active-runtime-disposal",
      token,
      peer,
      victim,
      controlGuest,
      controlExit,
      peerGuest,
      victimGuest,
      blockedGuest,
      coverage: armed.coverage,
      auditControl,
      phases,
      disposal,
    };
    try {
      return { ...result, measurements: validateDisposalResult(result) };
    } catch (error) {
      console.error(JSON.stringify({ stage: "active-disposal-failed", result }));
      throw error;
    }
  } finally {
    await invoke(page, "closeIntegration");
  }
}
export async function disposalCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Disposal proof needs the registered browser");
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await disposalCase(page);
  } finally {
    await context.close();
  }
}

function requireProof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`GPU active disposal ${message}`);
}
function equal(before: unknown, after: unknown, message: string) {
  requireProof(JSON.stringify(before) === JSON.stringify(after), message);
}
function activeImport(value: unknown, expected: Record<string, unknown>) {
  const item = record(value);
  requireProof(
    item.pid === expected.pid && item.token === expected.token && item.surface === expected.surface,
    "selected compiled guest replaced",
  );
  const events = importControls(item),
    last = events.at(-1)!;
  const selected = events.filter((event) => event.call === last.call);
  requireProof(
    last.name === "completions" &&
      last.phase === "wait" &&
      selected.length === 2 &&
      selected[0]!.phase === "enter" &&
      selected[0]!.connection === 1,
    "not held inside actual completions import",
  );
  const authority = record(selected[0]!.authority);
  requireProof(
    Array.isArray(authority.canaries) &&
      authority.canaries.length >= 33 &&
      Array.isArray(authority.leaks) &&
      authority.leaks.length === 0,
    "guest authority control failed",
  );
  return last;
}
function heldNative(service: Record<string, unknown>, victim: Record<string, unknown>) {
  const scope = record(service.scopeResult),
    completion = record(service.heldCompletion);
  requireProof(
    completion.owner === victim.id && number(completion.token) > 0,
    "missing original held completion identity",
  );
  requireProof(
    service.armed === true &&
      service.held === true &&
      service.nativeHeld === true &&
      service.nativeReleased === false &&
      scope.owner === victim.id &&
      scope.device === victim.device &&
      scope.kind === "none" &&
      scope.releasedAt === null &&
      number(scope.at) <= number(service.at) &&
      victim.pending === 1 &&
      victim.frame === true &&
      victim.devices === 1 &&
      victim.presenter === true,
    "missing active held native resources",
  );
  const blobs = entries(record(service.fairness).blobs).filter(
    (blob) => blob.connection === victim.id,
  );
  requireProof(
    blobs.length === 1 &&
      number(blobs[0]!.bytes) > number(blobs[0]!.commandRingBytes) &&
      blobs[0]!.draws === 200000 &&
      blobs[0]!.end !== null &&
      number(blobs[0]!.end) <= number(scope.at),
    "missing completed compiled blob before native hold",
  );
}
function lifecycle(service: Record<string, unknown>, expected: Record<string, unknown>) {
  const events = entries(service.lifecycle).filter((event) => event.owner === expected.id);
  const configured = events.find((event) => event.kind === "configure");
  requireProof(
    configured !== undefined &&
      number(configured.presenter) > 0 &&
      (expected.state === "terminal" || configured.presenter === expected.presenterId),
    "missing original presenter correlation",
  );
  for (const kind of ["configure", "release", "retired"]) {
    const matches = events.filter((event) => event.kind === kind);
    requireProof(matches.length === 1, "missing owner lifecycle retirement");
    const event = matches[0]!;
    requireProof(
      event.grant === expected.grant &&
        event.surface === expected.surface &&
        event.device === expected.device &&
        event.presenter === (kind === "retired" ? 0 : configured.presenter),
      "owner lifecycle identity changed",
    );
  }
  requireProof(
    events.map((event) => event.kind).join(",") === "configure,release,retired" &&
      number(events[0]!.at) <= number(events[1]!.at) &&
      number(events[1]!.at) <= number(events[2]!.at) &&
      number(events[2]!.at) <= number(service.at),
    "owner lifecycle order changed",
  );
  return events[2]!;
}
function terminalControls(value: unknown, expected: readonly Record<string, unknown>[]) {
  const controls = entries(value);
  requireProof(controls.length === expected.length, "missing retained open controls");
  for (const native of expected) {
    const matches = controls.filter((control) => control.grant === native.grant);
    requireProof(matches.length === 1, "missing correlated open controls");
    const control = matches[0]!,
      reason = native.state === "terminal" ? 1 : 4;
    requireProof(
      control.connection === 1 &&
        control.status === -64 &&
        control.reason === reason &&
        control.arenaTerminal === reason &&
        record(control.commands).terminal === reason &&
        record(control.replies).terminal === reason,
      "open waiter or ring not terminal",
    );
  }
}
function physicalProof(disposal: Record<string, unknown>) {
  const before = entries(disposal.workersBefore),
    stopped = record(disposal.stopped),
    after = record(disposal.after);
  requireProof(
    before.length >= 4 && entries(stopped.workers).length === before.length,
    "missing physical worker inventory",
  );
  const ids = before.map((worker) => worker.id);
  requireProof(
    new Set(ids).size === before.length && ids.every((id) => number(id) > 0),
    "aliased physical worker identity",
  );
  requireProof(
    before.filter(
      (worker) => String(worker.url).includes("/gpu/service-worker.ts") && worker.stopped === false,
    ).length === 1 &&
      before.some((worker) => worker.url === "/fs-worker.js" && worker.stopped === false),
    "wrong service topology or early filesystem stop",
  );
  const stops = entries(disposal.workerStops);
  requireProof(stops.length === before.length, "missing physical stop calls");
  for (const worker of before) {
    const matches = stops.filter((stop) => stop.id === worker.id && stop.url === worker.url);
    const finished = entries(stopped.workers).filter(
      (item) => item.id === worker.id && item.url === worker.url,
    );
    requireProof(
      matches.length === 1 && finished.length === 1 && finished[0]!.stopped === true,
      "worker not physically stopped",
    );
    const at = number(matches[0]!.at);
    requireProof(
      at <= number(disposal.finishedAt) &&
        (worker.stopped === true || at >= number(disposal.startedAt)),
      "active worker stopped outside disposal boundary",
    );
  }
  const serviceStop = stops.find((stop) => String(stop.url).includes("/gpu/service-worker.ts"));
  const filesystemStop = stops.find((stop) => stop.url === "/fs-worker.js");
  requireProof(
    serviceStop !== undefined &&
      filesystemStop !== undefined &&
      number(serviceStop.at) <= number(filesystemStop.at) &&
      stops
        .filter((stop) => stop.url === "/gpu-guest.js")
        .every((stop) => number(stop.at) <= number(serviceStop.at)),
    "owned worker shutdown order changed",
  );
  equal(stopped.workers, after.workers, "workers revived after disposal");
  requireProof(
    stopped.disposed === true && number(disposal.finishedAt) >= number(disposal.startedAt),
    "runtime disposal did not finish",
  );
}
function exitProof(
  disposal: Record<string, unknown>,
  guests: readonly Record<string, unknown>[],
  blocked: Record<string, unknown>,
) {
  const exits = entries(disposal.exits);
  requireProof(exits.length === guests.length, "owned guest omitted from shutdown");
  for (const [index, compiled] of guests.entries()) {
    const matches = exits.filter(
      (exit) =>
        exit.pid === compiled.pid &&
        exit.token === compiled.token &&
        exit.surface === compiled.surface,
    );
    requireProof(matches.length === 1, "missing original guest exit");
    const observed = matches[0]!,
      exit = record(observed.exit);
    requireProof(
      observed.grantRetired === true &&
        exit.kind === (index === 0 ? "exited" : "signaled") &&
        exit.code === (index === 0 ? 0 : 9) &&
        exit.status === (index === 0 ? 0 : 137),
      "wrong original guest exit or launch grant retirement",
    );
  }
  const exit = exits.find((item) => item.pid === blocked.pid)!;
  const last = entries(blocked.events).at(-1)!;
  const events = entries(exit.events);
  equal(
    entries(blocked.events),
    events.slice(0, entries(blocked.events).length),
    "guest import history rewritten",
  );
  requireProof(
    events.some(
      (event) =>
        event.call === last.call &&
        event.name === "completions" &&
        event.phase === "return" &&
        event.result === -64,
    ),
    "held import waiter did not return terminal error",
  );
}
function retiredHistory(
  service: Record<string, unknown>,
  history: Map<unknown, Record<string, unknown>>,
) {
  for (const [id, before] of history) noRetiredWork(before, service, id);
  for (const native of entries(service.owners)) {
    if (native.state !== "terminal") continue;
    retiredStarts(service, native);
    history.set(native.id, service);
  }
}
function retiredStarts(service: Record<string, unknown>, native: Record<string, unknown>) {
  const retiredAt = number(lifecycle(service, native).at),
    fairness = record(service.fairness);
  for (const [field, stamp] of Object.entries({
    queue: "start",
    slices: "start",
    blobs: "start",
    presents: "at",
  })) {
    const owned = entries(fairness[field]).filter((work) => work.connection === native.id);
    requireProof(
      owned.every((work) => number(work[stamp]) <= retiredAt),
      "native work started after owner retirement",
    );
  }
}
/** Validates observations, never infers native zeroes from a terminated service. */
export function validateDisposalResult(value: unknown) {
  const result = record(value),
    phases = entries(result.phases);
  requireProof(
    result.kind === "active-runtime-disposal" &&
      typeof result.token === "string" &&
      result.token.length > 0 &&
      phases.length === 2 &&
      phases[0]!.name === "live" &&
      phases[1]!.name === "held",
    "missing case identity or original checkpoints",
  );
  nativeCoverage(result.coverage);
  const controlGuest = guest(result.controlGuest),
    peerGuest = guest(result.peerGuest),
    victimGuest = guest(result.victimGuest);
  const guests = [controlGuest, peerGuest, victimGuest];
  for (const key of ["pid", "token", "surface"])
    requireProof(
      new Set(guests.map((item) => item[key])).size === 3,
      "aliased original compiled guest",
    );
  const controlExit = record(result.controlExit),
    first = record(phases[0]!.before),
    held = record(phases[1]!.service);
  const controlService = record(controlExit.service);
  requireProof(
    controlService.realm === first.realm && number(controlService.serial) < number(first.serial),
    "positive control service replaced",
  );
  cumulative(controlService, first);
  const control = identity(controlService, controlGuest),
    peer = identity(first, peerGuest),
    victim = identity(held, victimGuest);
  const natives = [control, peer, victim];
  for (const key of ["id", "grant", "device"])
    requireProof(new Set(natives.map((item) => item[key])).size === 3, "aliased native ownership");
  requireProof(
    result.peer === peer.id && result.victim === victim.id,
    "wrong selected native owner",
  );
  const auditControl = record(result.auditControl),
    armedAudit = record(auditControl.service);
  requireProof(
    auditControl.name === "armed" &&
      armedAudit.realm === first.realm &&
      armedAudit.token === result.token &&
      armedAudit.mode === "disposal" &&
      number(armedAudit.serial) > number(record(phases[0]!.service).serial) &&
      number(armedAudit.serial) < number(record(phases[1]!.before).serial) &&
      armedAudit.nativeHeld === false,
    "shared disposal audit positive control missing",
  );
  activeImport(result.blockedGuest, victimGuest);
  let previous: Record<string, unknown> | undefined;
  let serial = 0,
    at = 0,
    bracket = { presents: 0, queue: 0 };
  const responses = new Set<unknown>();
  const retiredOwners = new Map<unknown, Record<string, unknown>>([[control.id, controlService]]);
  const observe = (service: Record<string, unknown>) => {
    requireProof(
      service.realm === first.realm &&
        typeof first.realm === "string" &&
        first.realm.length > 0 &&
        service.token === result.token &&
        service.mode === "disposal" &&
        number(service.serial) > serial &&
        number(service.at) >= at &&
        typeof service.responseId === "string" &&
        service.responseId.length > 0 &&
        !responses.has(service.responseId) &&
        record(service.fairness).overflow === false,
      "uncorrelated service observation",
    );
    if (previous) cumulative(previous, service);
    retiredHistory(service, retiredOwners);
    previous = service;
    serial = number(service.serial);
    at = number(service.at);
    responses.add(service.responseId);
  };
  for (const [index, phase] of phases.entries()) {
    requireProof(phase.peerPid === peerGuest.pid, "original green peer replaced");
    for (const service of [record(phase.before), record(phase.service)]) {
      observe(service);
      livePhase(service, index, peer, control, victim);
    }
    bracket = bracketProof(phase, peer.id, bracket);
    if (index === 0) observe(armedAudit);
  }
  const heldCompletion = record(record(phases[1]!.before).heldCompletion);
  equal(
    heldCompletion,
    held.heldCompletion,
    "held completion identity changed during held observation",
  );
  const audits = terminalDisposal(result, guests, natives);
  requireProof(
    audits.length === 2 && audits[0]!.name === "retired" && audits[1]!.name === "late",
    "missing actual pre-termination disposal audits",
  );
  for (const audit of audits) {
    const service = record(audit.service);
    observe(service);
    assertRetired(service);
    requireProof(entries(service.owners).length === 3, "owned GPU service connection omitted");
    for (const native of natives) {
      retired(owner(service, native.id, "disposed guest"), native === control ? 1 : 4);
      lifecycle(service, native);
    }
  }
  lateResult(audits, victim, natives, heldCompletion);
  return timing(held, peer.id);
}

function terminalDisposal(
  result: Record<string, unknown>,
  guests: readonly Record<string, unknown>[],
  natives: readonly Record<string, unknown>[],
) {
  const disposal = record(result.disposal),
    synchronous = record(disposal.synchronous);
  requireProof(
    Array.isArray(disposal.errors) && disposal.errors.length === 0 && synchronous.disposed === true,
    "runtime disposal error or missing synchronous revocation",
  );
  const memory = entries(disposal.memoryBefore);
  requireProof(
    memory.length === 2 &&
      guests
        .slice(1)
        .every((compiled) =>
          memory.some((item) => item.pid === compiled.pid && number(item.bytes) > 0),
        ),
    "original compiled workers not active at disposal",
  );
  for (const native of natives.slice(1)) {
    const before = entries(disposal.controlsBefore).find((item) => item.grant === native.grant);
    requireProof(
      before !== undefined &&
        before.status === 1 &&
        before.reason === 0 &&
        record(before.commands).terminal === 0 &&
        record(before.replies).terminal === 0,
      "original open already stopped before disposal",
    );
  }
  terminalControls(synchronous.controls, natives);
  const revocations = entries(synchronous.revocations);
  requireProof(
    revocations.length === 3 &&
      guests.every((compiled) =>
        revocations.some((entry) => entry.pid === compiled.pid && entry.value === 1),
      ),
    "launch-wide revocation missing",
  );
  for (const compiled of guests.slice(1)) {
    const matches = entries(disposal.workersBefore).filter(
      (worker) =>
        worker.pid === compiled.pid &&
        worker.token === compiled.token &&
        worker.surface === compiled.surface &&
        worker.stopped === false,
    );
    requireProof(
      matches.length === 1 && matches[0]!.url === "/gpu-guest.js",
      "missing original physical guest worker",
    );
  }
  physicalProof(disposal);
  exitProof(disposal, guests, record(result.blockedGuest));
  const stopped = record(disposal.stopped),
    after = record(disposal.after);
  terminalControls(stopped.controls, natives);
  equal(synchronous.controls, stopped.controls, "publication changed after synchronous disposal");
  equal(stopped.controls, after.controls, "late publication changed terminated shared controls");
  equal(stopped.audits, after.audits, "service work continued after worker termination");
  for (const state of [stopped, after]) accounting(state.snapshot, 0, 3);
  return entries(stopped.audits);
}

function lateResult(
  audits: readonly Record<string, unknown>[],
  victim: Record<string, unknown>,
  natives: readonly Record<string, unknown>[],
  heldCompletion: Record<string, unknown>,
) {
  const beforeLate = record(audits[0]!.service),
    late = record(audits[1]!.service),
    scope = record(late.scopeResult);
  requireProof(late.lateCallback !== undefined, "original canceled native callback did not run");
  const callback = record(late.lateCallback),
    completion = record(beforeLate.heldCompletion);
  equal(heldCompletion, completion, "held completion identity changed at disposal");
  equal(completion, late.heldCompletion, "held completion identity changed after disposal");
  requireProof(
    record(beforeLate.scopeResult).releasedAt === null &&
      beforeLate.nativeHeld === true &&
      beforeLate.nativeReleased === false &&
      late.nativeHeld === false &&
      late.nativeReleased === true &&
      scope.owner === victim.id &&
      scope.device === victim.device &&
      scope.kind === "none" &&
      number(scope.releasedAt) >= number(lifecycle(beforeLate, victim).at) &&
      number(scope.releasedAt) <= number(late.at),
    "late native result not released after owner retirement",
  );
  requireProof(
    beforeLate.lateCallback === undefined &&
      callback.owner === victim.id &&
      callback.device === victim.device &&
      callback.token === completion.token &&
      completion.owner === victim.id &&
      callback.kind === "none" &&
      number(callback.at) >= number(scope.releasedAt) &&
      number(callback.at) <= number(late.at),
    "original canceled native callback did not run",
  );
  for (const native of natives) noRetiredWork(beforeLate, late, native.id);
}

function livePhase(
  service: Record<string, unknown>,
  index: number,
  peer: Record<string, unknown>,
  control: Record<string, unknown>,
  victim: Record<string, unknown>,
) {
  live(owner(service, peer.id, "green peer"), peer);
  retired(owner(service, control.id, "positive control"), 1);
  if (index !== 1) return;
  live(owner(service, victim.id, "held guest"), victim);
  heldNative(service, owner(service, victim.id, "held guest"));
}
