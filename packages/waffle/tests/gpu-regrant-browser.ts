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
  checkpoint,
  current,
  until,
  nativeCoverage,
  progress,
  peerAdvanced,
} from "./gpu-ownership-browser.js";
import {
  bracketProof,
  unchangedSubmissions,
  immutableRetired,
  screenshotEnd,
} from "./gpu-admission-browser.js";

const names = ["live", "ready", "held", "replacement", "released", "retired"] as const;
function requireProof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`GPU regrant ${message}`);
}
function integer(value: unknown): number {
  const parsed = number(value);
  requireProof(Number.isSafeInteger(parsed), "invalid integer observation");
  return parsed;
}
function image(value: unknown, colour: string) {
  const item = record(value);
  requireProof(Array.isArray(item.center) && Array.isArray(item.corner), "missing pixels");
  assertTrianglePixels(
    { center: item.center.map(number), corner: item.corner.map(number) },
    colour,
  );
}
function guest(value: unknown) {
  const item = record(value);
  requireProof(
    integer(item.pid) > 0 &&
      integer(item.surface) > 0 &&
      typeof item.token === "string" &&
      item.token.length > 0,
    "missing compiled guest identity",
  );
  const events = importControls(item);
  const open = events.filter((event) => event.name === "open");
  requireProof(
    open.length === 2 &&
      open[0]!.phase === "enter" &&
      open[1]!.phase === "return" &&
      open[0]!.call === open[1]!.call &&
      open[1]!.result === 0 &&
      typeof item.text === "string" &&
      item.text.includes(`GPU_STAGE surface id=${item.surface} `) &&
      !item.text.includes("GPU_FAIL"),
    "wrong original compiled open",
  );
  return item;
}
function identity(service: Record<string, unknown>, compiled: Record<string, unknown>) {
  const matches = entries(service.attempts).filter(
    (item) =>
      item.grant !== undefined &&
      item.surface === compiled.surface &&
      entries(service.owners).some((native) => native.id === item.owner),
  );
  const candidate = matches.at(-1);
  requireProof(candidate !== undefined, "missing original open attempt");
  const native = owner(service, candidate.owner, "regrant guest");
  requireProof(
    native.surface === compiled.surface && native.grant === candidate.grant,
    "guest and service identity differ",
  );
  for (const key of ["id", "grant", "surface", "device"])
    requireProof(integer(native[key]) > 0, "missing native identity");
  return native;
}
function live(native: Record<string, unknown>, expected: Record<string, unknown>) {
  peerProof(native, expected);
  requireProof(
    native.presenter === true &&
      integer(native.presenterId) > 0 &&
      native.presenterId === expected.presenterId &&
      native.presenterDevice === expected.device &&
      typeof native.frame === "boolean" &&
      record(native.commands).terminal === 0 &&
      record(native.replies).terminal === 0 &&
      native.partial === false,
    "live presenter or device replaced",
  );
}
function retired(native: Record<string, unknown>, reason: number) {
  requireProof(
    native.state === "terminal" &&
      native.terminalReason === reason &&
      native.retiredAck === true &&
      native.readerDisposed === true &&
      native.devices === 0 &&
      native.created === 1 &&
      native.destroyed === 1 &&
      native.pending === 0 &&
      native.payloadBytes === 0 &&
      native.replayBusy === false &&
      native.partial === false &&
      native.presenter === false &&
      native.presenterId === 0 &&
      native.presenterDevice === 0 &&
      native.frame === false &&
      record(native.commands).terminal === reason &&
      record(native.replies).terminal === reason,
    "unretired owner or presenter",
  );
}
function prefix(previous: readonly unknown[], next: readonly unknown[], message: string) {
  requireProof(
    next.length >= previous.length &&
      JSON.stringify(next.slice(0, previous.length)) === JSON.stringify(previous),
    message,
  );
}
function cumulative(before: Record<string, unknown>, after: Record<string, unknown>) {
  if (before.scopeResult !== undefined)
    scopeHistory(record(before.scopeResult), record(after.scopeResult));
  prefix(entries(before.lifecycle), entries(after.lifecycle), "lifecycle history rewritten");
  const a = record(before.fairness),
    b = record(after.fairness);
  for (const key of ["presents", "slices"])
    prefix(entries(a[key]), entries(b[key]), "native observation history rewritten");
  const queued = entries(a.queue),
    next = entries(b.queue);
  requireProof(next.length >= queued.length, "queue observation history dropped");
  unchangedSubmissions(queued, next.slice(0, queued.length), number(before.at));
  for (const kind of ["records", "native"]) {
    const old = record(a[kind]),
      current = record(b[kind]);
    for (const [key, value] of Object.entries(old))
      aggregateHistory(record(value), record(current[key]));
  }
}
function aggregateHistory(before: Record<string, unknown>, after: Record<string, unknown>) {
  requireProof(
    integer(after.count) >= integer(before.count) &&
      number(after.totalMs) >= number(before.totalMs) &&
      number(after.maxMs) >= number(before.maxMs),
    "native aggregate history decreased",
  );
}
function scopeHistory(before: Record<string, unknown>, after: Record<string, unknown>) {
  requireProof(
    ["owner", "device", "kind", "at"].every((key) => before[key] === after[key]),
    "held native result identity rewritten",
  );
  if (before.releasedAt !== null)
    requireProof(before.releasedAt === after.releasedAt, "native result release stamp rewritten");
}
function activity(service: Record<string, unknown>, id: unknown) {
  const fairness = record(service.fairness);
  const owned = (name: string) => entries(fairness[name]).filter((item) => item.connection === id);
  const aggregates = (name: string) =>
    Object.fromEntries(
      Object.entries(record(fairness[name])).filter(([key]) => key.startsWith(`${id}:`)),
    );
  return {
    presents: owned("presents"),
    queue: owned("queue"),
    slices: owned("slices"),
    blobs: owned("blobs"),
    native: aggregates("native"),
    records: aggregates("records"),
  };
}
function noRetiredWork(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  id: unknown,
) {
  immutableRetired(owner(before, id, "retired"), owner(after, id, "retired"));
  stableActivity(before, after, id);
}
function stableActivity(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  id: unknown,
) {
  const a = activity(before, id),
    b = activity(after, id);
  requireProof(
    JSON.stringify(a.presents) === JSON.stringify(b.presents) &&
      JSON.stringify(a.slices) === JSON.stringify(b.slices) &&
      JSON.stringify(a.native) === JSON.stringify(b.native) &&
      JSON.stringify(a.records) === JSON.stringify(b.records) &&
      JSON.stringify(a.blobs) === JSON.stringify(b.blobs),
    "late retired replay or native work",
  );
  unchangedSubmissions(a.queue, b.queue, number(before.at));
}
function lifecycleProof(
  service: Record<string, unknown>,
  original: Record<string, unknown>,
  replacement: Record<string, unknown>,
) {
  const events = entries(service.lifecycle);
  const event = (kind: string, native: Record<string, unknown>) => {
    const found = events.filter((item) => item.kind === kind && item.owner === native.id);
    requireProof(found.length === 1, "missing or duplicate lifecycle event");
    const item = found[0]!;
    requireProof(
      item.grant === native.grant &&
        item.surface === native.surface &&
        item.device === native.device &&
        number(item.at) <= number(service.at),
      "uncorrelated lifecycle event",
    );
    return item;
  };
  const configured = event("configure", original),
    released = event("release", original),
    retired = event("retired", original),
    next = event("configure", replacement);
  requireProof(
    configured.presenter === original.presenterId &&
      released.presenter === original.presenterId &&
      next.presenter === replacement.presenterId &&
      original.presenterId !== replacement.presenterId,
    "presenter release or replacement identity differs",
  );
  requireProof(
    events.indexOf(configured) < events.indexOf(released) &&
      events.indexOf(released) < events.indexOf(retired) &&
      events.indexOf(retired) < events.indexOf(next) &&
      number(configured.at) <= number(released.at) &&
      number(released.at) <= number(retired.at) &&
      number(retired.at) <= number(next.at),
    "replacement configured before original release and retirement",
  );
}
function scopeProof(
  service: Record<string, unknown>,
  original: Record<string, unknown>,
  released: boolean,
) {
  const scope = record(service.scopeResult);
  requireProof(
    scope.owner === original.id &&
      scope.device === original.device &&
      scope.kind === "none" &&
      number(scope.at) <= number(service.at) &&
      service.nativeHeld === !released &&
      service.nativeReleased === released &&
      service.released === released,
    "missing correlated held native scope result",
  );
  requireProof(
    released
      ? number(scope.releasedAt) >= number(scope.at) &&
          number(scope.releasedAt) <= number(service.at)
      : scope.releasedAt === null,
    "wrong native result release interval",
  );
}
function stopProof(value: unknown, compiled: Record<string, unknown>, failed: boolean) {
  const stop = record(value),
    exit = record(stop.exit);
  requireProof(
    stop.pid === compiled.pid &&
      exit.kind === "exited" &&
      exit.code === Number(failed) &&
      stop.grantRetired === true &&
      stop.physicallyStopped === true &&
      typeof stop.text === "string",
    "missing compiled physical stop",
  );
  if (failed)
    requireProof(
      stop.text.includes("GPU_FAIL stage=completions status=-64"),
      "wrong revoked compiled failure",
    );
  else requireProof(!stop.text.includes("GPU_FAIL"), "positive compiled guest failed");
  authority(stop);
  return stop;
}

type RegrantIdentity = ReturnType<typeof identityProof>;
type Observation = {
  previous: Record<string, unknown> | undefined;
  serial: number;
  at: number;
  responses: Set<unknown>;
  retiredOwners: Map<unknown, Record<string, unknown>>;
};
function identityProof(
  result: Record<string, unknown>,
  phases: readonly Record<string, unknown>[],
) {
  const controlGuest = guest(result.controlGuest),
    peerGuest = guest(result.peerGuest),
    oldGuest = guest(result.oldGuest),
    replacementGuest = guest(result.replacementGuest);
  requireProof(
    oldGuest.surface === replacementGuest.surface && oldGuest.surface !== peerGuest.surface,
    "replacement did not reuse the original canvas surface",
  );
  for (const key of ["pid", "token"])
    requireProof(
      new Set([controlGuest, peerGuest, oldGuest, replacementGuest].map((item) => item[key]))
        .size === 4,
      "aliased compiled guest identity",
    );
  const first = record(phases[0]!.service),
    ready = record(phases[1]!.service),
    replaced = record(phases[3]!.service);
  const control = identity(record(record(result.controlExit).service), controlGuest),
    peer = identity(first, peerGuest),
    original = identity(ready, oldGuest),
    replacement = identity(replaced, replacementGuest);
  requireProof(
    result.peer === peer.id &&
      result.victim === original.id &&
      result.replacement === replacement.id,
    "wrong selected native owners",
  );
  for (const key of ["id", "grant", "device", "presenterId"])
    requireProof(
      new Set([peer, original, replacement].map((item) => item[key])).size === 3,
      "aliased native ownership",
    );
  const request = record(result.regrant);
  requireProof(
    request.oldPid === oldGuest.pid &&
      request.replacementPid === replacementGuest.pid &&
      request.surface === oldGuest.surface &&
      request.retiredBeforeGrant === false,
    "replacement grant waited for retirement or changed guest",
  );
  const baseline = integer(first.heapBytes),
    readyHeap = integer(ready.heapBytes);
  requireProof(baseline > 0 && readyHeap > baseline, "missing live service credit");

  return {
    controlGuest,
    peerGuest,
    oldGuest,
    replacementGuest,
    first,
    ready,
    replaced,
    control,
    peer,
    original,
    replacement,
    baseline,
    readyHeap,
  };
}
function snapshotProof(
  service: Record<string, unknown>,
  state: Observation,
  expected: { first: Record<string, unknown>; token: unknown },
  index: number,
) {
  requireProof(
    service.realm === expected.first.realm &&
      typeof expected.first.realm === "string" &&
      expected.first.realm.length > 0 &&
      service.token === expected.token &&
      service.mode === "regrant" &&
      service.armed === index >= 2 &&
      integer(service.serial) > state.serial &&
      number(service.at) > state.at &&
      typeof service.responseId === "string" &&
      !state.responses.has(service.responseId) &&
      record(service.fairness).overflow === false,
    "stale or uncorrelated service snapshot",
  );
  state.serial = integer(service.serial);
  state.at = number(service.at);
  state.responses.add(service.responseId);
  if (state.previous) cumulative(state.previous, service);
  state.previous = service;
}
function queueProof(work: Record<string, unknown>, at: number) {
  const settlement = record(work.settlement);
  requireProof(
    number(work.start) <= at &&
      ["pending", "completed", "rejected"].includes(String(settlement.kind)),
    "invalid native queue settlement",
  );
  if (settlement.kind !== "pending")
    requireProof(
      number(settlement.at) >= number(work.start) && number(settlement.at) <= at,
      "invalid native queue settlement interval",
    );
}
function knownProducers(service: Record<string, unknown>, ids: readonly unknown[]) {
  const observed = record(service.fairness);
  for (const work of entries(observed.queue)) queueProof(work, number(service.at));
  for (const key of ["presents", "queue", "slices", "blobs"])
    requireProof(
      entries(observed[key]).every((item) => ids.includes(item.connection)),
      "unowned native producer",
    );
  for (const name of ["native", "records"])
    requireProof(
      Object.keys(record(observed[name])).every((key) =>
        ids.some((id) => key.startsWith(`${id}:`)),
      ),
      "unowned native aggregate",
    );
}
function cohortProof(
  service: Record<string, unknown>,
  expected: RegrantIdentity,
  state: Observation,
  index: number,
) {
  const { control, peer, original, replacement, baseline, readyHeap } = expected;
  const retiredOwners = state.retiredOwners;
  live(owner(service, peer.id, "original peer"), peer);
  const count = index === 0 || index === 5 ? 1 : 2;
  const natives = entries(service.owners);
  const expectedIds = [control.id, peer.id].concat(
    index >= 1 ? [original.id] : [],
    index >= 3 ? [replacement.id] : [],
  );
  knownProducers(service, expectedIds);
  requireProof(
    natives.length === expectedIds.length &&
      new Set(natives.map((item) => item.id)).size === natives.length &&
      natives.every((item) => expectedIds.includes(item.id)) &&
      service.nativeRequests === natives.length &&
      service.connections === count &&
      service.devicesLive === count &&
      service.presentCanvasesLive === count,
    "wrong native ownership cohort or topology",
  );
  requireProof(
    integer(service.heapBytes) === (count === 1 ? baseline : readyHeap),
    "service credit not released before replacement",
  );
  requireProof(
    service.frameTexturesLive === natives.filter((item) => item.frame === true).length,
    "frame ownership count differs",
  );
  requireProof(
    entries(service.attempts).length === natives.length,
    "unexpected original open attempt",
  );
  for (const native of natives) attemptProof(service, native);
  checkOwners(service, {
    index,
    control,
    original,
    replacement,
    retiredOwners,
  });
}
function heldProof(
  result: Record<string, unknown>,
  phases: readonly Record<string, unknown>[],
  expected: RegrantIdentity,
) {
  const { original, oldGuest } = expected;
  const held = record(phases[2]!.service),
    heldOwner = owner(held, original.id, "held owner");
  requireProof(
    heldOwner.pending === 1 && heldOwner.frame === true && held.held === true,
    "original native result was not pending with its owned frame",
  );
  const blobs = entries(record(held.fairness).blobs).filter(
    (blob) => blob.connection === original.id,
  );
  requireProof(
    blobs.length === 1 &&
      blobs[0]!.draws === 200000 &&
      number(blobs[0]!.bytes) > number(blobs[0]!.commandRingBytes) &&
      blobs[0]!.end !== null &&
      number(blobs[0]!.end) <= number(record(held.scopeResult).at) &&
      integer(record(record(record(held.fairness).native)[`${original.id}:draw`]).count) === 200000,
    "missing compiled oversized replay workload",
  );
  const blocked = record(result.blockedGuest),
    events = importControls(blocked),
    last = events.at(-1)!;
  requireProof(
    blocked.pid === oldGuest.pid &&
      blocked.token === oldGuest.token &&
      last.name === "completions" &&
      last.phase === "wait" &&
      events.filter((item) => item.call === last.call).length === 2,
    "old guest was not blocked in the real completions import",
  );
  prefix(entries(oldGuest.events), events, "old guest import history rewritten");
  authority({
    ownAuthority: events.filter((event) => event.phase === "enter").map((event) => event.authority),
  });
}
function lateResultProof(phases: readonly Record<string, unknown>[], expected: RegrantIdentity) {
  const { replaced, replacement } = expected;
  const released = record(phases[4]!.service),
    scopeBefore = record(replaced.scopeResult),
    scopeAfter = record(released.scopeResult);
  requireProof(
    ["owner", "device", "kind", "at"].every((key) => scopeBefore[key] === scopeAfter[key]),
    "held native result identity rewritten",
  );
  requireProof(
    number(scopeAfter.releasedAt) >= number(replaced.at),
    "native result released before replacement proof",
  );
  const firstPresent = entries(record(replaced.fairness).presents).find(
    (item) => item.connection === replacement.id,
  );
  const configured = entries(replaced.lifecycle).find(
    (item) => item.kind === "configure" && item.owner === replacement.id,
  );
  requireProof(
    firstPresent !== undefined &&
      configured !== undefined &&
      number(firstPresent.at) >= number(configured.at),
    "replacement presented before configure",
  );
}
function replacementResults(
  phases: readonly Record<string, unknown>[],
  replacement: Record<string, unknown>,
) {
  const before = record(phases[3]!.service),
    baseline = owner(before, replacement.id, "replacement");
  for (const service of [record(phases[4]!.before), record(phases[4]!.service)]) {
    const next = owner(service, replacement.id, "replacement");
    requireProof(
      next.pending === 0 &&
        next.payloadBytes === 0 &&
        next.replayBusy === false &&
        next.frame === false,
      "replacement gained results or work after original release",
    );
    for (const name of ["commands", "replies"])
      requireProof(
        ["head", "tail", "terminal"].every(
          (key) => integer(record(next[name])[key]) === integer(record(baseline[name])[key]),
        ),
        "late original result mutated replacement rings",
      );
    stableActivity(before, service, replacement.id);
  }
}
function finalProof(
  result: Record<string, unknown>,
  expected: RegrantIdentity,
  state: Observation,
) {
  const { first, peer, original, oldGuest, replacementGuest, peerGuest, controlGuest } = expected;
  const { previous, retiredOwners, serial, at, responses } = state;
  const final = record(result.final);
  requireProof(previous !== undefined, "missing final checkpoint");
  cumulative(previous, final);
  for (const [id, before] of retiredOwners) noRetiredWork(before, final, id);
  requireProof(
    final.realm === first.realm &&
      final.token === result.token &&
      final.mode === "regrant" &&
      integer(final.serial) > serial &&
      number(final.at) > at &&
      typeof final.responseId === "string" &&
      !responses.has(final.responseId) &&
      record(final.fairness).overflow === false &&
      entries(final.owners).length === 4 &&
      final.nativeRequests === 4 &&
      entries(final.attempts).length === 4,
    "wrong final correlated cohort",
  );
  knownProducers(final, [expected.control.id, peer.id, original.id, expected.replacement.id]);
  scopeProof(final, original, true);
  const finalPeer = owner(final, peer.id, "final peer");
  for (const key of ["grant", "surface", "device", "created"])
    requireProof(finalPeer[key] === peer[key], "final peer identity changed");
  assertRetired(final);
  for (const native of entries(final.owners)) {
    retired(native, native.id === original.id ? 4 : 1);
    attemptProof(final, native);
  }
  const oldStop = stopProof(result.oldStop, oldGuest, true),
    nextStop = stopProof(result.replacementStop, replacementGuest, false),
    peerStop = stopProof(result.peerExit, peerGuest, false);
  stopProof(result.controlExit, controlGuest, false);
  accounting(record(result.controlExit).snapshot, 1, 1);
  accounting(oldStop.snapshot, 3, 2);
  accounting(nextStop.snapshot, 2, 3);
  accounting(peerStop.snapshot, 1, 4);
  const disposed = record(result.runtimeStop),
    workers = entries(disposed.workers);
  requireProof(
    Array.isArray(disposed.errors) &&
      disposed.errors.length === 0 &&
      workers.length > 0 &&
      workers.every((worker) => worker.stopped === true) &&
      workers.filter((worker) => String(worker.url).includes("/gpu/service-worker.ts")).length ===
        1,
    "runtime retained workers or changed single-service topology",
  );
  accounting(disposed.snapshot, 0, 4);
}
export function validateRegrantResult(value: unknown) {
  const result = record(value);
  requireProof(
    result.kind === "surface-regrant" &&
      typeof result.token === "string" &&
      result.token.length > 0,
    "missing case identity",
  );
  nativeCoverage(result.coverage);
  const phases = entries(result.phases);
  requireProof(phases.length === names.length, "missing checkpoint brackets");
  const expected = identityProof(result, phases);
  const state: Observation = {
    previous: undefined,
    serial: 0,
    at: 0,
    responses: new Set(),
    retiredOwners: new Map(),
  };
  let priorProgress = { presents: 0, queue: 0 };
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    requireProof(
      phase.name === names[index] && phase.peerPid === expected.peerGuest.pid,
      "replaced peer checkpoint",
    );
    for (const service of [record(phase.before), record(phase.service)]) {
      snapshotProof(service, state, { first: expected.first, token: result.token }, index);
      cohortProof(service, expected, state, index);
      if (index >= 2) scopeProof(service, expected.original, index >= 4);
      if (index >= 3) lifecycleProof(service, expected.original, expected.replacement);
    }
    priorProgress = bracketProof(phase, expected.peer.id, priorProgress);
    if (index >= 3) image(phase.replacementPixels, "blue");
  }
  heldProof(result, phases, expected);
  lateResultProof(phases, expected);
  replacementResults(phases, expected.replacement);
  finalProof(result, expected, state);
  return timing(record(phases.at(-1)!.service), expected.peer.id);
}
function attemptProof(service: Record<string, unknown>, native: Record<string, unknown>) {
  const attempts = entries(service.attempts).filter((item) => item.owner === native.id);
  requireProof(attempts.length === 1, "missing or duplicate original open attempt");
  const attempt = attempts[0]!,
    terminal = native.state === "terminal",
    reason = terminal ? native.terminalReason : 0;
  requireProof(
    attempt.grant === native.grant &&
      attempt.surface === native.surface &&
      attempt.connection === 1 &&
      attempt.status === (terminal ? -64 : 1) &&
      attempt.reason === reason &&
      attempt.arenaTerminal === reason &&
      attempt.retiredAck === terminal &&
      record(attempt.commands).terminal === reason &&
      record(attempt.replies).terminal === reason &&
      attempt.beforeNativeRequests === attempt.afterNativeRequests &&
      integer(attempt.afterConnections) === integer(attempt.beforeConnections) + 1,
    "uncorrelated original open attempt",
  );
}
type Owners = {
  index: number;
  control: Record<string, unknown>;
  original: Record<string, unknown>;
  replacement: Record<string, unknown>;
  retiredOwners: Map<unknown, Record<string, unknown>>;
};
function checkOwners(service: Record<string, unknown>, expected: Owners) {
  const { index, control, original, replacement, retiredOwners } = expected;
  for (const native of [control].concat(
    index >= 1 ? [original] : [],
    index >= 3 ? [replacement] : [],
  )) {
    const current = owner(service, native.id, "cohort member");
    for (const key of ["grant", "surface", "device", "created"])
      requireProof(current[key] === native[key], "owner identity changed");
    const done = native === control || (native === original ? index >= 3 : index >= 5);
    if (!done) {
      live(current, native);
      continue;
    }
    retired(current, native === original ? 4 : 1);
    const before = retiredOwners.get(native.id);
    if (before) noRetiredWork(before, service, native.id);
    retiredOwners.set(native.id, service);
  }
}

async function regrantCase(page: Page) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  let closed = false;
  try {
    const token = crypto.randomUUID();
    await invoke(page, "launchTriangle", [[], "gpu", 0, true]);
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlGuest = await invoke(page, "ownershipGuest");
    const controlExit = await invoke(page, "stopTriangle");
    assertRetired(controlExit.service);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    await invoke(page, "ownershipPeer", [true]);
    const surface = await invoke(page, "ownershipSurface", [2]);
    const observed = record(
      await invoke(page, "serviceCommand", [
        "ownership-observe",
        { token, surface, mode: "regrant" },
      ]),
    );
    const peer = number(entries(observed.owners).find((item) => item.state === "ready")!.id);
    const phases: Record<string, unknown>[] = [];
    const capture = async (name: (typeof names)[number]) => {
      const previous = phases.at(-1);
      const last = progress(previous ? record(previous.service) : observed, peer);
      const before = await until(page, (service) => peerAdvanced(service, peer, last));
      const peerPixels = await pixels(page, 1, false);
      assertTrianglePixels(peerPixels, "green");
      const replacementPixels = ["replacement", "released", "retired"].includes(name)
        ? await pixels(page, 2, false)
        : undefined;
      if (replacementPixels) assertTrianglePixels(replacementPixels, "blue");
      const after = await screenshotEnd(page, peer, before);
      phases.push({
        name,
        peerPid: peerGuest.pid,
        before,
        service: after,
        pixels: peerPixels,
        replacementPixels,
      });
    };
    await capture("live");
    await invoke(page, "launchTriangle", [["--fairness-heavy"], "gpu", 2, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-heavy-ready", 2);
    const oldGuest = record(await invoke(page, "ownershipGuest", [2]));
    const ready = await current(page);
    const victim = identity(ready, oldGuest).id;
    await capture("ready");
    const armed = record(
      await invoke(page, "serviceCommand", ["ownership-arm", { token, surface, mode: "regrant" }]),
    );
    if (armed.observerError) throw new Error(String(armed.observerError));
    await invoke(page, "feedTriangle", ["\n", 2]);
    await until(
      page,
      (service) => service.nativeHeld === true && owner(service, victim, "old").pending === 1,
    );
    const blockedGuest = await invoke(page, "ownershipGuest", [2]);
    await capture("held");
    const regrant = await invoke(page, "regrantTriangle");
    await checkpoint(page, "GPU_FRAME colour=blue frame=1 validation=none", 3);
    const replacementGuest = record(await invoke(page, "ownershipGuest", [3]));
    const replacement = identity(await current(page), replacementGuest).id;
    const oldStop = await invoke(page, "stopTriangle", [false, 2, false]);
    await capture("replacement");
    await invoke(page, "serviceCommand", ["ownership-release"]);
    await until(page, (service) => service.nativeReleased === true);
    await capture("released");
    const replacementStop = await invoke(page, "stopTriangle", [false, 3]);
    await capture("retired");
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const final = await current(page);
    const runtimeStop = await invoke(page, "closeIntegration", [true]);
    closed = true;
    const result = {
      kind: "surface-regrant",
      token,
      peer,
      victim,
      replacement,
      coverage: armed.coverage,
      controlGuest,
      controlExit,
      peerGuest,
      oldGuest,
      blockedGuest,
      replacementGuest,
      regrant,
      phases,
      oldStop,
      replacementStop,
      peerExit,
      final,
      runtimeStop,
    };
    try {
      return { ...result, measurements: validateRegrantResult(result) };
    } catch (error) {
      console.error(JSON.stringify({ stage: "regrant-failed", result }));
      throw error;
    }
  } finally {
    if (!closed) await invoke(page, "closeIntegration");
  }
}
export async function regrantCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Regrant proof needs the registered browser");
  const context = await browser.newContext({
    viewport: { width: 320, height: 240 },
  });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await regrantCase(page);
  } finally {
    await context.close();
  }
}
