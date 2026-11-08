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
  checkpoint,
  current,
  until,
  nativeCoverage,
  progress,
  peerAdvanced,
} from "./gpu-ownership-browser.js";
import {
  bracketProof,
  screenshotEnd,
  immutableRetired,
  unchangedSubmissions,
} from "./gpu-admission-browser.js";

const allowance = 67108864;
const backing = [64, 4194368, 262208, 1048576];
const openBytes = backing.reduce((sum, bytes) => sum + bytes, 0);
function proof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`GPU grant quota ${message}`);
}

async function positiveControl(page: Page) {
  await invoke(page, "launchTriangle", [[], "gpu", 0, true]);
  await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
  assertTrianglePixels(await pixels(page, 0, false));
  const controlGuest = await invoke(page, "ownershipGuest");
  const controlExit = await invoke(page, "stopTriangle");
  assertRetired(controlExit.service);
  const coverage = record(await invoke(page, "serviceCommand", ["admission-coverage"])).coverage;
  nativeCoverage(coverage);
  return { controlGuest, controlExit, coverage };
}

async function quotaCase(page: Page) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  let closed = false;
  try {
    const { controlGuest, controlExit, coverage } = await positiveControl(page);
    await invoke(page, "launchTriangle", [["green", "--fairness-peer"], "gpu", 1, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=fairness-peer frame=1", 1);
    const peerGuest = record(await invoke(page, "ownershipGuest", [1]));
    const token = crypto.randomUUID();
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
    const peer = owner(
      observed,
      entries(observed.owners).find((entry) => entry.state === "ready")!.id,
      "original peer",
    );
    await invoke(page, "ownershipPeer", [true, 40]);
    const phases: Record<string, unknown>[] = [];
    const capture = async (kind: string, cycle: number) => {
      const previous = phases.at(-1);
      const last = progress(previous ? record(previous.service) : observed, peer.id);
      const before = await until(page, (service) => peerAdvanced(service, peer.id, last));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const after = await screenshotEnd(page, peer.id, before);
      phases.push({
        kind,
        cycle,
        peerPid: peerGuest.pid,
        before,
        service: after,
        pixels: image,
        guest: await invoke(page, "ownershipGuest", [2]),
        accounting: await invoke(page, "quotaAccounting"),
      });
    };
    await invoke(page, "launchTriangle", [["--grant-quota"], "gpu", 2, true]);
    for (let cycle = 1; cycle <= 12; cycle++) {
      await quotaCycle(page, cycle, capture);
    }
    for (let refusal = 1; refusal <= 2; refusal++) {
      await checkpoint(page, `GPU_QUOTA_REFUSED index=${refusal}`, 2);
      await capture("refused", 12 + refusal);
      if (refusal === 1) await invoke(page, "feedTriangle", ["\n", 2]);
    }
    const stop = await invoke(page, "stopTriangle", [false, 2]);
    await capture("stopped", 14);
    const guest = await invoke(page, "ownershipGuest", [2]);
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const final = await current(page);
    const runtimeStop = await invoke(page, "closeIntegration", [true]);
    closed = true;
    const result = {
      kind: "grant-quota",
      token,
      peer,
      peerGuest,
      guest,
      controlGuest,
      controlExit,
      coverage,
      phases,
      stop,
      peerExit,
      final,
      runtimeStop,
    };
    try {
      return { ...result, measurements: validateGrantQuotaResult(result) };
    } catch (error) {
      console.error(JSON.stringify({ stage: "grant-quota-failed", result }));
      throw error;
    }
  } finally {
    if (!closed) await invoke(page, "closeIntegration");
  }
}
async function quotaCycle(
  page: Page,
  cycle: number,
  capture: (kind: string, cycle: number) => Promise<void>,
) {
  await checkpoint(page, "GPU_WAIT_STDIN stage=quota-open", 2);
  if (cycle <= 2) await capture("open", cycle);
  await invoke(page, "feedTriangle", ["\n", 2]);
  await checkpoint(page, `GPU_QUOTA_CLOSED cycle=${cycle}`, 2);
  if (cycle === 1 || cycle === 12) {
    await until(page, (service) => service.connections === 1);
    await capture("closed", cycle);
  }
  await invoke(page, "feedTriangle", ["\n", 2]);
  if (cycle < 12) await waitCycle(page, cycle + 1);
}
async function waitCycle(page: Page, cycle: number) {
  await checkpoint(page, `GPU_QUOTA_OPEN cycle=${cycle} status=0`, 2);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const guest = record(await invoke(page, "ownershipGuest", [2]));
    proof(typeof guest.text === "string", "missing C output");
    if (guest.text.split("GPU_WAIT_STDIN stage=quota-open").length - 1 === cycle) return;
    proof(!guest.text.includes("GPU_FAIL"), "C reopen failed");
    await page.waitForTimeout(10);
  }
  throw new Error("GPU grant quota reopen checkpoint deadline");
}
export async function grantQuotaCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Grant quota proof needs the registered browser");
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await quotaCase(page);
  } finally {
    await context.close();
  }
}

function quota(value: unknown) {
  const state = record(value);
  proof(
    state.limit === allowance && Array.isArray(state.lengths),
    "missing bounded allocator observation",
  );
  const lengths = state.lengths.map(number);
  proof(
    lengths.every(Number.isSafeInteger) &&
      lengths.reduce((sum, size) => sum + size, 0) === state.receiptBytes &&
      state.receiptBytes === state.consumed,
    "receipt and consumed accounting differ",
  );
  return { consumed: number(state.consumed), lengths };
}
function calls(guest: Record<string, unknown>, name: string) {
  return entries(guest.events).filter((event) => event.name === name && event.phase !== "wait");
}
export function quotaImports(value: unknown) {
  const guest = record(value);
  importControls(guest);
  proof(
    typeof guest.token === "string" &&
      typeof guest.text === "string" &&
      !guest.text.includes("GPU_FAIL"),
    "unrelated C failure",
  );
  const events = entries(guest.events);
  proof(
    events.every((event) => event.token === guest.token),
    "uncorrelated import event",
  );
  const opens = calls(guest, "open");
  proof(opens.length === 28, "wrong same-incarnation open count");
  const first = quota(opens[0]!.quota);
  proof(
    first.consumed === 4 && JSON.stringify(first.lengths) === "[4]",
    "wrong actual initial controls",
  );
  let consumed = first.consumed;
  let lengths = first.lengths;
  for (let index = 0; index < 14; index++) {
    const enter = opens[index * 2]!,
      exit = opens[index * 2 + 1]!;
    proof(
      enter.phase === "enter" &&
        exit.phase === "return" &&
        enter.call === exit.call &&
        enter.connection === 0 &&
        exit.result === (index < 12 ? 0 : -48),
      "wrong open errno or call correlation",
    );
    proof(
      quota(enter.quota).consumed === consumed &&
        JSON.stringify(quota(enter.quota).lengths) === JSON.stringify(lengths),
      "close refunded consumed allowance",
    );
    const added = index < 12 ? backing : [64];
    consumed += added.reduce((sum, bytes) => sum + bytes, 0);
    lengths = lengths.concat(added);
    const after = quota(exit.quota);
    proof(
      after.consumed === consumed && JSON.stringify(after.lengths) === JSON.stringify(lengths),
      "unadmitted construction or partial-allocation debt differs",
    );
    proof(
      guest.text.includes(
        `GPU_QUOTA_OPEN cycle=${index + 1} status=${index < 12 ? 0 : -48} output=${index < 12 ? index + 1 : 3735928559}`,
      ),
      "missing exact C open stage or untouched failure output",
    );
    if (index >= 12) proof(consumed + backing[1]! > allowance, "refusal did not reach grant limit");
  }
  const closes = calls(guest, "close");
  proof(closes.length === 48, "missing normal and idempotent compiled closes");
  for (let index = 0; index < 24; index++) {
    const enter = closes[index * 2]!,
      exit = closes[index * 2 + 1]!;
    const cycle = Math.floor(index / 2) + 1;
    proof(
      enter.connection === cycle &&
        enter.phase === "enter" &&
        exit.phase === "return" &&
        enter.call === exit.call &&
        exit.result === 0 &&
        quota(enter.quota).consumed === 4 + cycle * openBytes &&
        JSON.stringify(enter.quota) === JSON.stringify(exit.quota),
      "normal close refunded quota or wrong close result",
    );
  }
  return consumed;
}
function ledger(value: unknown, liveCount: number, consumed?: number) {
  const snapshot = record(value);
  proof(record(snapshot.platform).kind === "bounded", "unbounded reservation ledger");
  const controls = entries(snapshot.holders).filter((holder) => holder.label === "guest-control");
  const live = controls.filter((holder) => holder.state === "live");
  proof(
    live.length === liveCount && live.every((holder) => record(holder.shape).length === allowance),
    "live reservation refunded before physical stop",
  );
  const expectedDebts = [5505220].concat(consumed === undefined ? [] : [consumed]);
  const debts = controls
    .filter((holder) => holder.state !== "live")
    .map((holder) => number(record(holder.shape).length));
  if (liveCount <= 1) expectedDebts.push(5505220);
  proof(
    JSON.stringify(debts) === JSON.stringify(expectedDebts),
    "unused allowance release or retained debt differs",
  );
  proof(
    controls.every((holder) => holder.declaredBytes === record(holder.shape).length),
    "reservation declared bytes differ",
  );
  if (consumed === undefined) return;
  const retired = controls.filter((holder) => holder.state !== "live");
  proof(
    retired.some((holder) => holder.state === "debt" && record(holder.shape).length === consumed),
    "consumed backing debt missing after physical retirement",
  );
  proof(
    retired.every((holder) => holder.state === "debt" || holder.state === "awaiting-collection"),
    "invalid retired ledger state",
  );
}
function retiredProof(native: Record<string, unknown>, acknowledged: boolean) {
  proof(
    native.state === "terminal" &&
      native.terminalReason === 1 &&
      native.readerDisposed === true &&
      native.devices === 0 &&
      native.created === 1 &&
      native.destroyed === 1 &&
      native.pending === 0 &&
      native.payloadBytes === 0 &&
      native.replayBusy === false &&
      native.partial === false &&
      native.presenter === false &&
      native.frame === false &&
      native.retiredAck === acknowledged,
    "normal close terminal or retirement differs",
  );
  for (const key of ["commands", "replies"])
    proof(record(native[key]).terminal === 1, "closed ring terminal differs");
}
type RetiredHistory = Map<
  unknown,
  {
    native: Record<string, unknown>;
    service: Record<string, unknown>;
    queue: Record<string, unknown>[];
    queueAt: number;
  }
>;
function retiredHistory(
  service: Record<string, unknown>,
  native: Record<string, unknown>,
  history: RetiredHistory,
) {
  const prior = history.get(native.id);
  const queue = entries(record(service.fairness).queue).filter(
    (work) => work.connection === native.id,
  );
  if (!prior) {
    history.set(native.id, { native, service, queue, queueAt: number(service.at) });
    return;
  }
  immutableRetired(prior.native, native);
  const before = record(prior.service.fairness),
    after = record(service.fairness);
  const owned = (source: Record<string, unknown>, key: string) =>
    entries(source[key]).filter((item) => item.connection === native.id);
  for (const key of ["presents", "slices", "blobs"])
    proof(
      JSON.stringify(owned(before, key)) === JSON.stringify(owned(after, key)),
      "late retired native or completed-blob work",
    );
  const nativeCalls = (source: Record<string, unknown>) =>
    Object.entries(record(source.native)).filter(([key]) => key.startsWith(`${native.id}:`));
  proof(
    JSON.stringify(nativeCalls(before)) === JSON.stringify(nativeCalls(after)),
    "late retired native calls",
  );
  unchangedSubmissions(prior.queue, queue, prior.queueAt);
  prior.queue = queue;
  prior.queueAt = number(service.at);
}
function admittedIdentity(
  native: Record<string, unknown>,
  history: Map<unknown, Record<string, unknown>>,
) {
  const previous = history.get(native.id) ?? native;
  for (const key of ["id", "grant", "surface", "device", "created"])
    proof(
      Number.isSafeInteger(native[key]) && number(native[key]) > 0 && native[key] === previous[key],
      "admitted native identity changed",
    );
  history.set(native.id, previous);
}
function cycleRendering(service: Record<string, unknown>, owner: Record<string, unknown>) {
  const id = owner.id;
  const observed = record(service.fairness),
    native = record(observed.native),
    at = number(service.at);
  for (const name of [
    "draw",
    "finish",
    "submit",
    "transferToImageBitmap",
    "transferFromImageBitmap",
  ])
    proof(
      native[`${id}:${name}`] !== undefined && number(record(native[`${id}:${name}`]).count) > 0,
      "missing per-cycle native rendering",
    );
  proof(
    entries(observed.presents).some((item) => item.connection === id && number(item.at) <= at) &&
      entries(observed.slices).some(
        (item) => item.connection === id && number(item.draws) > 0 && number(item.end) <= at,
      ) &&
      entries(observed.queue).some(
        (item) =>
          item.connection === id &&
          number(item.start) <= at &&
          ((owner.state === "ready" && record(item.settlement).kind === "pending") ||
            (record(item.settlement).kind === "completed" &&
              number(item.start) <= number(record(item.settlement).at) &&
              number(record(item.settlement).at) <= at)),
      ),
    "missing per-cycle native rendering",
  );
}

function phaseGuest(value: unknown, guest: Record<string, unknown>, kind: string, cycle: number) {
  const captured = record(value);
  proof(
    captured.pid === guest.pid &&
      captured.token === guest.token &&
      captured.surface === guest.surface &&
      typeof captured.text === "string" &&
      typeof guest.text === "string" &&
      guest.text.startsWith(captured.text),
    "same-grant C incarnation changed",
  );
  const prefix = entries(captured.events);
  proof(
    JSON.stringify(prefix) === JSON.stringify(entries(guest.events).slice(0, prefix.length)),
    "import history changed",
  );
  proof(
    calls(captured, "open").length === cycle * 2 &&
      calls(captured, "close").length === Math.min(kind === "open" ? cycle - 1 : cycle, 12) * 4,
    "later import substituted for C checkpoint",
  );
  const marker =
    kind === "open" ? "quota-open" : kind === "closed" ? "quota-close" : "quota-refused";
  proof(captured.text.includes(`GPU_WAIT_STDIN stage=${marker}`), "actual C checkpoint missing");
  const last = prefix.at(-1)!;
  if (kind === "open") return;
  proof(
    last.phase === "return" &&
      last.name === (kind === "closed" ? "close" : "open") &&
      last.result === (kind === "closed" ? 0 : -48),
    "uncorrelated terminal import result",
  );
}

export function validateGrantQuotaResult(value: unknown) {
  const result = record(value),
    guest = record(result.guest),
    peerGuest = record(result.peerGuest);
  proof(
    result.kind === "grant-quota" && typeof result.token === "string" && result.token.length > 0,
    "wrong case identity",
  );
  nativeCoverage(result.coverage);
  proof(typeof guest.text === "string", "missing terminal C output");
  const consumed = quotaImports(guest),
    expectedPeer = record(result.peer);
  importControls(peerGuest);
  proof(peerGuest.surface === expectedPeer.surface, "original peer guest surface differs");
  proof(
    guest.pid !== peerGuest.pid &&
      guest.token !== peerGuest.token &&
      guest.surface !== peerGuest.surface,
    "guest incarnation or surface replaced",
  );
  const phases = entries(result.phases);
  proof(phases.length === 7, "missing close/reopen brackets");
  const realm = record(phases[0]!.before).realm;
  proof(typeof realm === "string" && realm.length > 0, "missing service realm");
  const retired: RetiredHistory = new Map();
  const identities = new Map<unknown, Record<string, unknown>>();
  admittedIdentity(expectedPeer, identities);
  const controlExit = record(result.controlExit),
    controlService = record(controlExit.service);
  proof(
    record(controlExit.exit).kind === "exited" &&
      record(controlExit.exit).code === 0 &&
      controlExit.physicallyStopped === true,
    "positive control did not retire",
  );
  proof(controlService.realm === realm, "positive control belongs to another service realm");
  authority(controlExit);
  for (const native of entries(controlService.owners)) {
    retiredProof(native, true);
    admittedIdentity(native, identities);
    retiredHistory(controlService, native, retired);
  }
  const responses = new Set<unknown>();
  let serial = 0,
    at = 0,
    previous = { presents: 0, queue: 0 };
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    const cycle = [1, 1, 2, 12, 13, 14, 14][index]!;
    const kind = ["open", "closed", "open", "closed", "refused", "refused", "stopped"][index]!;
    proof(
      phase.kind === kind && phase.cycle === cycle && phase.peerPid === peerGuest.pid,
      "wrong phase order or peer pid",
    );
    phaseGuest(phase.guest, guest, kind, cycle);
    ledger(phase.accounting, kind === "stopped" ? 2 : 3, kind === "stopped" ? consumed : undefined);
    for (const service of [record(phase.before), record(phase.service)]) {
      proof(
        service.realm === realm &&
          service.token === result.token &&
          service.mode === "admission" &&
          service.armed === false &&
          number(service.serial) > serial &&
          number(service.at) > at &&
          typeof service.responseId === "string" &&
          !responses.has(service.responseId),
        "stale or cross-realm service observation",
      );
      serial = number(service.serial);
      at = number(service.at);
      responses.add(service.responseId);
      validateService(service, {
        expectedPeer,
        guest,
        cycle: Math.min(cycle, 12),
        kind,
        retired,
        identities,
      });
    }
    previous = bracketProof(phase, expectedPeer.id, previous);
  }
  return retirementResult(result, {
    guest,
    peerGuest,
    expectedPeer,
    phases,
    consumed,
    realm,
    retired,
    identities,
    serial,
    at,
    responses,
  });
}
function retirementResult(
  result: Record<string, unknown>,
  expected: {
    guest: Record<string, unknown>;
    peerGuest: Record<string, unknown>;
    expectedPeer: Record<string, unknown>;
    phases: Record<string, unknown>[];
    consumed: number;
    realm: string;
    retired: RetiredHistory;
    identities: Map<unknown, Record<string, unknown>>;
    serial: number;
    at: number;
    responses: Set<unknown>;
  },
) {
  const {
    guest,
    peerGuest,
    expectedPeer,
    phases,
    consumed,
    realm,
    retired,
    identities,
    serial,
    at,
    responses,
  } = expected;
  const stop = record(result.stop),
    exit = record(stop.exit);
  proof(
    stop.pid === guest.pid &&
      exit.kind === "exited" &&
      exit.code === 0 &&
      stop.text === guest.text &&
      stop.grantRetired === true &&
      stop.physicallyStopped === true,
    "missing actual C physical stop",
  );
  authority(stop);
  ledger(stop.snapshot, 2, consumed);
  const controlTotal = (value: unknown) =>
    entries(record(value).holders)
      .filter((holder) => holder.label === "guest-control")
      .reduce((sum, holder) => sum + number(record(holder.shape).length), 0);
  proof(
    controlTotal(phases[5]!.accounting) - controlTotal(stop.snapshot) === allowance - consumed,
    "released consumed backing or retained unused allowance",
  );
  const peerExit = record(result.peerExit);
  proof(
    peerExit.pid === peerGuest.pid &&
      record(peerExit.exit).kind === "exited" &&
      record(peerExit.exit).code === 0 &&
      peerExit.physicallyStopped === true &&
      peerExit.grantRetired === true,
    "original peer failed normal retirement",
  );
  authority(peerExit);
  ledger(peerExit.snapshot, 1, consumed);
  let previous = record(phases.at(-1)!.service),
    previousSerial = serial,
    previousAt = at;
  for (const terminal of [record(peerExit.service), record(result.final)]) {
    proof(
      terminal.realm === realm &&
        terminal.token === result.token &&
        terminal.mode === "admission" &&
        terminal.armed === false &&
        number(terminal.serial) > previousSerial &&
        number(terminal.at) > previousAt &&
        typeof terminal.responseId === "string" &&
        !responses.has(terminal.responseId),
      "terminal realm replaced or snapshot stale",
    );
    proof(
      entries(terminal.owners).length === 14 && entries(terminal.attempts).length === 14,
      "terminal owners or opens missing",
    );
    terminalCohort(terminal, previous);
    assertRetired(terminal);
    for (const native of entries(terminal.owners)) {
      retiredProof(native, true);
      admittedIdentity(native, identities);
      retiredHistory(terminal, native, retired);
    }
    responses.add(terminal.responseId);
    previousSerial = number(terminal.serial);
    previousAt = number(terminal.at);
    previous = terminal;
  }
  const runtime = record(result.runtimeStop);
  proof(
    Array.isArray(runtime.errors) &&
      runtime.errors.length === 0 &&
      entries(runtime.workers).length > 0 &&
      entries(runtime.workers).every((worker) => worker.stopped === true),
    "runtime worker stop audit missing",
  );
  proof(
    entries(runtime.workers).filter(
      (worker) => typeof worker.url === "string" && worker.url.includes("/gpu/service-worker.ts"),
    ).length === 1,
    "GPU service topology changed",
  );
  ledger(runtime.snapshot, 0, consumed);
  return timing(record(phases.at(-1)!.service), expectedPeer.id);
}
function terminalCohort(final: Record<string, unknown>, previous: Record<string, unknown>) {
  const known = entries(previous.owners);
  proof(
    new Set(entries(final.owners).map((native) => native.id)).size === known.length,
    "terminal native cohort duplicated",
  );
  proof(
    final.nativeRequests === previous.nativeRequests &&
      entries(final.owners).every((native) => known.some((prior) => prior.id === native.id)),
    "terminal native cohort changed",
  );
  for (const native of entries(final.owners)) {
    const prior = owner(previous, native.id, "terminal predecessor");
    for (const key of ["grant", "surface", "device", "created"])
      proof(native[key] === prior[key], "terminal native identity changed");
    retiredProof(native, true);
  }
  const attempts = entries(previous.attempts);
  for (const attempt of entries(final.attempts)) {
    const prior = attempts.find((entry) => entry.owner === attempt.owner);
    proof(
      prior !== undefined &&
        ["grant", "surface", "connection"].every((key) => attempt[key] === prior[key]) &&
        attempt.status === -64 &&
        attempt.reason === 1 &&
        attempt.arenaTerminal === 1 &&
        attempt.retiredAck === true,
      "terminal open history changed",
    );
  }
}

function validateService(
  service: Record<string, unknown>,
  expected: {
    expectedPeer: Record<string, unknown>;
    guest: Record<string, unknown>;
    cycle: number;
    kind: string;
    retired: RetiredHistory;
    identities: Map<unknown, Record<string, unknown>>;
  },
) {
  const { expectedPeer, guest, cycle, kind, retired, identities } = expected;
  const peer = owner(service, expectedPeer.id, "original peer");
  peerProof(peer, expectedPeer);
  proof(
    peer.presenter === true &&
      peer.presenterId === expectedPeer.presenterId &&
      peer.presenterDevice === expectedPeer.device,
    "original peer presenter replaced",
  );
  const all = entries(service.owners),
    victims = all.filter((native) => native.surface === guest.surface);
  proof(
    all.length === cycle + 2 &&
      victims.length === cycle &&
      service.connections === (kind === "open" ? 2 : 1) &&
      service.nativeRequests === cycle + 2,
    "global service cap or unadmitted activation interfered",
  );
  for (const native of all) admittedIdentity(native, identities);
  for (const native of all.filter(
    (entry) => entry.surface !== guest.surface && entry.id !== peer.id,
  )) {
    retiredProof(native, true);
    retiredHistory(service, native, retired);
  }
  const firstGrant = victims[0]!.grant;
  proof(
    firstGrant !== peer.grant && victims.every((native) => native.grant === firstGrant),
    "guest grant replaced across opens",
  );
  const attempts = entries(service.attempts);
  proof(
    attempts.length === cycle + 2 &&
      new Set(victims.map((native) => native.id)).size === cycle &&
      new Set(victims.map((native) => native.device)).size === cycle,
    "duplicate owners or failed open reached service",
  );
  for (let index = 0; index < victims.length; index++) {
    const native = victims[index]!;
    cycleRendering(service, native);
    const attempt = attempts.find((entry) => entry.owner === native.id);
    proof(
      attempt !== undefined &&
        attempt.grant === firstGrant &&
        attempt.surface === guest.surface &&
        attempt.connection === index + 1 &&
        attempt.beforeConnections === 1 &&
        attempt.afterConnections === 2 &&
        attempt.beforeNativeRequests === attempt.afterNativeRequests,
      "wrong same-grant service admission",
    );
    if (kind === "open" && index === cycle - 1) {
      proof(native.state === "ready" && attempt.status === 1, "reopen did not activate normally");
      continue;
    }
    retiredProof(native, kind === "stopped");
    proof(
      attempt.status === -64 &&
        attempt.reason === 1 &&
        attempt.arenaTerminal === 1 &&
        attempt.retiredAck === (kind === "stopped"),
      "normal close terminal mirrors differ",
    );
    retiredHistory(service, native, retired);
  }
  const known = new Set(all.map((native) => native.id));
  for (const key of ["presents", "queue", "slices", "blobs"])
    proof(
      entries(record(service.fairness)[key]).every((entry) => known.has(entry.connection)),
      "unowned native work",
    );
  proof(
    service.devicesLive === (kind === "open" ? 2 : 1) &&
      service.presentCanvasesLive === (kind === "open" ? 2 : 1),
    "native ownership count differs",
  );
}
