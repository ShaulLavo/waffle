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
  progress,
  peerAdvanced,
  checkpoint,
  current,
  until,
  nativeCoverage,
} from "./gpu-ownership-browser.js";

import {
  bracketProof,
  screenshotEnd,
  immutableRetired,
  unchangedSubmissions,
} from "./gpu-admission-browser.js";
import { cumulative, identity, live, retired } from "./gpu-regrant-browser.js";

function proof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`GPU payload pressure ${message}`);
}
async function payloadCase(page: Page) {
  await invoke(page, "openIntegration", [false, "ownership", true]);
  await invoke(page, "activateDisplay");
  let closed = false;
  try {
    await invoke(page, "launchTriangle", [["--pause-acquired"], "gpu", 0, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=acquired");
    const uncovered = record(await invoke(page, "serviceCommand", ["admission-coverage"]));
    let rejected = false;
    try {
      nativeCoverage(uncovered.coverage);
    } catch {
      rejected = true;
    }
    proof(rejected, "uncovered native observer passed");
    await invoke(page, "feedTriangle");
    await checkpoint(page, "GPU_FRAME colour=red frame=1 validation=none");
    assertTrianglePixels(await pixels(page, 0, false));
    const controlGuest = await invoke(page, "ownershipGuest");
    const controlExit = await invoke(page, "stopTriangle");
    assertRetired(controlExit.service);
    const controlCoverage = record(await invoke(page, "serviceCommand", ["admission-coverage"]));
    nativeCoverage(controlCoverage.coverage);
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
    const peer = identity(observed, peerGuest);
    await invoke(page, "ownershipPeer", [true]);
    const phases: Record<string, unknown>[] = [];
    const capture = async (kind: string) => {
      const last = progress(phases.length ? record(phases.at(-1)!.service) : observed, peer.id);
      const before = await until(page, (service) => peerAdvanced(service, peer.id, last));
      const image = await pixels(page, 1, false);
      assertTrianglePixels(image, "green");
      const service = await screenshotEnd(page, peer.id, before);
      phases.push({
        kind,
        before,
        service,
        pixels: image,
        peerPid: peerGuest.pid,
        peerGuest: await invoke(page, "ownershipGuest", [1]),
        guest: kind === "live" ? undefined : await invoke(page, "ownershipGuest", [2]),
        accounting: await invoke(page, "quotaAccounting"),
      });
    };
    await capture("live");
    await invoke(page, "launchTriangle", [["--payload-pressure"], "gpu", 2, true]);
    const launchedGuest = record(await invoke(page, "ownershipGuest", [2]));
    const firstReady = await until(page, (service) =>
      entries(service.owners).some(
        (native) =>
          native.surface === launchedGuest.surface &&
          native.state === "ready" &&
          number(native.device) > 0,
      ),
    );
    await checkpoint(page, "GPU_WAIT_STDIN stage=payload-last-committed", 2);
    const committedGuest = record(await invoke(page, "ownershipGuest", [2]));
    const match = String(committedGuest.text).match(/GPU_PAYLOAD_REQUESTED index=64 token=(\d+)/);
    if (!match) throw new Error("Missing compiled last payload token");
    const lastToken = Number(match[1]);
    const committed = await until(page, (service) =>
      entries(record(service.payloadPressure).publications).some(
        (entry) => entry.token === lastToken && entry.published === true,
      ),
    );
    await capture("committed");
    await invoke(page, "feedTriangle", ["\n", 2]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=payload-refusal-requested", 2);
    const terminal = await until(page, (service) =>
      entries(record(service.payloadPressure).allocations).some(
        (entry) => entry.outcome === "refused" && entry.terminalReason === 3,
      ),
    );
    await capture("terminal");
    await invoke(page, "feedTriangle", ["\n", 2]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=payload-terminal", 2);
    const drained = await current(page);
    await capture("drained");
    await invoke(page, "feedTriangle", ["\n", 2]);
    const stop = await invoke(page, "stopTriangle", [false, 2, false]);
    const guest = await invoke(page, "ownershipGuest", [2]);
    await capture("stopped");
    await invoke(page, "ownershipPeer", [false]);
    await invoke(page, "feedTriangle", ["q", 1]);
    const peerExit = await invoke(page, "stopTriangle", [false, 1, false]);
    const final = await current(page);
    const runtimeStop = await invoke(page, "closeIntegration", [true]);
    closed = true;
    const result = {
      kind: "payload-pressure",
      token,
      observed,
      firstReady,
      peer,
      peerGuest,
      controlGuest,
      controlExit,
      uncovered,
      controlCoverage,
      committedGuest,
      committed,
      terminal,
      guest,
      drained,
      stop,
      phases,
      peerExit,
      final,
      runtimeStop,
    };
    try {
      return { ...result, measurements: validatePayloadPressureResult(result) };
    } catch (error) {
      console.error(JSON.stringify({ stage: "payload-pressure-failed", result }));
      throw error;
    }
  } finally {
    if (!closed) await invoke(page, "closeIntegration");
  }
}
export async function payloadPressureCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Payload pressure proof needs the registered browser");
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await payloadCase(page);
  } finally {
    await context.close();
  }
}

function equal(a: unknown, b: unknown, message: string) {
  proof(JSON.stringify(a) === JSON.stringify(b), message);
}
function prefix(a: readonly unknown[], b: readonly unknown[], message: string) {
  equal(a, b.slice(0, a.length), message);
}
function integer(value: unknown) {
  const parsed = number(value);
  proof(Number.isSafeInteger(parsed), "invalid integer");
  return parsed;
}
function text(guest: Record<string, unknown>) {
  proof(
    typeof guest.text === "string" && !/GPU_FAIL|GPU_UNEXPECTED/.test(guest.text),
    "unrelated C failure",
  );
  return guest.text;
}
function rows(source: string, pattern: RegExp, keys: readonly string[]) {
  return Array.from(source.matchAll(pattern), (match) =>
    Object.fromEntries(keys.map((key, index) => [key, Number(match[index + 1])])),
  );
}
function guestPrefix(before: unknown, after: Record<string, unknown>) {
  const captured = record(before);
  for (const key of ["pid", "surface", "token"])
    proof(captured[key] === after[key], "compiled incarnation changed");
  proof(text(after).startsWith(text(captured)), "C output history changed");
  proof(entries(captured.events).length > 0, "missing import event prefix");
  prefix(entries(captured.events), entries(after.events), "import event prefix changed");
}
export function payloadImports(value: unknown) {
  const guest = record(value),
    output = text(guest);
  importControls(guest);
  const events = entries(guest.events);
  const entered = events.filter((event) => event.phase === "enter");
  authority({ ownAuthority: entered.map((event) => event.authority) });
  let prior = 0;
  for (const enter of entered) {
    proof(integer(enter.call) > prior, "import call order changed");
    prior = integer(enter.call);
    const group = events.filter((event) => event.call === enter.call);
    proof(
      group.length >= 2 &&
        group[0] === enter &&
        group.every((event) => event.name === enter.name && event.token === guest.token),
      "uncorrelated import call",
    );
    proof(
      group.at(-1)!.phase === "return" &&
        group.slice(1, -1).every((event) => event.phase === "wait"),
      "compiled import threw or never returned",
    );
    if (enter.name !== "open") proof(enter.connection === 1, "original connection changed");
  }
  const calls = (name: string) => entered.filter((event) => event.name === name);
  const returns = (name: string) =>
    events.filter((event) => event.name === name && event.phase === "return");
  proof(
    returns("append").length === 68 && returns("append").every((event) => event.result === 0),
    "compiled payload appends failed or missing",
  );
  proof(
    calls("open").length === 1 && returns("open")[0]!.result === 0,
    "wrong original compiled open",
  );
  proof(
    calls("close").length === 2 && returns("close").every((event) => event.result === 0),
    "missing normal and idempotent close",
  );
  const requested = rows(output, /^GPU_PAYLOAD_REQUESTED index=(\d+) token=(\d+)$/gm, [
    "index",
    "token",
  ]);
  const results = rows(
    output,
    /^GPU_PAYLOAD_RESULT index=(\d+) token=(\d+) handle=(\d+) generation=(\d+) length=(\d+) read=0 phase=(?:ready|terminal)$/gm,
    ["index", "token", "handle", "generation", "length"],
  );
  proof(requested.length === 65 && results.length === 64, "wrong compiled payload count");
  for (let index = 0; index < requested.length; index++) {
    const request = requested[index]!;
    proof(
      request.index === index + 1 &&
        integer(request.token) > (index ? integer(requested[index - 1]!.token) : 0),
      "compiled payload token order",
    );
  }
  proof(new Set(results.map((entry) => entry.handle)).size === 64, "reused payload slot");
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    proof(
      result.index === index + 1 &&
        result.token === requested[index]!.token &&
        integer(result.handle) > 0 &&
        integer(result.handle) <= 64 &&
        integer(result.generation) > 0 &&
        result.length === 8,
      "wrong C payload handle or result",
    );
    proof(
      output.includes(
        `GPU_PAYLOAD_RESULT index=${result.index} token=${result.token} handle=${result.handle} generation=${result.generation} length=8 read=0 phase=${index === 63 ? "terminal" : "ready"}\n`,
      ),
      "wrong C payload phase",
    );
  }
  proof(
    output.includes(
      `GPU_PAYLOAD_READY connection=1 surface=${guest.surface} shader=6 slots=64\n`,
    ) &&
      output.includes(
        "GPU_PAYLOAD_TERMINAL reason=3 records=2 successes=1 closed=1 status=-48\n",
      ) &&
      output.endsWith("GPU_STAGE closed\n"),
    "wrong exact compiled terminal stage",
  );
  const last = results[63]!;
  proof(
    output.includes(
      `GPU_PAYLOAD_AFTER_TERMINAL token=${last.token} handle=${last.handle} generation=${last.generation} read=-48\n`,
    ),
    "held handle revived after closure",
  );
  const payloads = calls("payload"),
    payloadReturns = returns("payload");
  proof(
    payloads.length === 1 && payloadReturns.length === 1 && payloadReturns[0]!.result === -48,
    "payload import consumed early or revived",
  );
  equal(
    payloads[0]!.payload,
    { handle: last.handle, generation: last.generation },
    "payload import used another handle",
  );
  const completions = returns("completions");
  proof(
    completions.length === 68 &&
      completions.filter((event) => event.result !== 0).length === 1 &&
      completions.at(-1)!.result === -48,
    "completion terminal errno differs",
  );
  const records = completions
    .filter((event) => event.result === 0)
    .flatMap((event) => entries(event.records));
  const payloadRecords = records.filter((entry) => entry.kind === 17);
  proof(payloadRecords.length === 64, "missing real compiled completion records");
  for (let index = 0; index < payloadRecords.length; index++) {
    const reply = payloadRecords[index]!,
      result = results[index]!;
    proof(
      reply.bytes === 40 && reply.status === 0 && reply.token === result.token,
      "compiled completion correlation differs",
    );
    equal(
      reply.words,
      [1, 0, result.handle, result.generation, 8, 0],
      "compiled completion payload differs",
    );
  }
  const terminalRecords = entries(completions.at(-2)!.records);
  equal(
    terminalRecords,
    [payloadRecords[63], { kind: 12, bytes: 24, token: 0, status: 0, words: [3, 0] }],
    "last committed success not drained before closed",
  );
  proof(
    integer(payloads[0]!.call) > integer(completions.at(-1)!.call) &&
      integer(calls("close")[0]!.call) > integer(payloads[0]!.call),
    "payload/close call order differs",
  );
  return { guest, requested, results };
}

function pressure(service: Record<string, unknown>) {
  const value = record(service.payloadPressure);
  proof(
    value.dropped === 0 && value.uncorrelatedCompilations === 0,
    "payload observer lost native coverage",
  );
  return value;
}
function subject(entry: Record<string, unknown>, native: Record<string, unknown>, at: number) {
  proof(
    entry.owner === native.id &&
      entry.grant === native.grant &&
      entry.device === native.device &&
      entry.connection === 1 &&
      integer(entry.order) > 0 &&
      number(entry.at) <= at,
    "uncorrelated native payload observation",
  );
}
function payloadNative(
  service: Record<string, unknown>,
  native: Record<string, unknown>,
  results: Record<string, number>[],
  requested: Record<string, number>[],
  terminal: boolean,
) {
  const captured = pressure(service);
  const compilations = entries(captured.compilations),
    allocations = entries(captured.allocations),
    publications = entries(captured.publications);
  proof(
    compilations.length === (terminal ? 65 : 64) &&
      allocations.length === compilations.length &&
      publications.length === 64,
    "wrong native payload operation count",
  );
  const at = number(service.at);
  for (let index = 0; index < compilations.length; index++) {
    const compilation = compilations[index]!,
      allocation = allocations[index]!;
    subject(compilation, native, at);
    subject(allocation, native, at);
    proof(
      compilation.call === index + 1 &&
        compilation.settled === "fulfilled" &&
        number(compilation.settledAt) >= number(compilation.at) &&
        number(compilation.settledAt) <= number(allocation.at) &&
        compilation.pending === 1 &&
        allocation.pendingBefore === 0,
      "native compilation unsettled or pending limit interfered",
    );
    proof(
      allocation.length === 8 &&
        allocation.readyBefore === Math.min(index, 64) &&
        allocation.readyAfter === Math.min(index + 1, 64) &&
        allocation.repliesUsedBefore === (index === 64 ? 40 : 0),
      "payload slots or reply storage selected another limit",
    );
    proof(
      integer(compilation.order) < integer(allocation.order) &&
        (index === 0 || integer(publications[index - 1]!.order) < integer(compilation.order)),
      "native request/allocation order differs",
    );
    if (index === 64) {
      proof(
        allocation.outcome === "refused" &&
          allocation.handle === 0 &&
          allocation.generation === 0 &&
          allocation.terminalReason === 3 &&
          allocation.failure === "Payload credit exhausted",
        "wrong payload resource refusal",
      );
      continue;
    }
    successfulPayload(
      publications[index]!,
      allocation,
      results[index]!,
      requested[index]!,
      native,
      at,
    );
  }
  proof(publications[63]!.repliesUsed === 40, "last success was not retained unread");
  const terminations = entries(captured.terminations).filter((entry) => entry.owner === native.id);
  if (!terminal) {
    proof(terminations.length === 0, "payload connection closed before refusal");
    return;
  }
  proof(
    terminations.length >= 1 &&
      terminations.every((entry) => entry.requested === 3 && entry.selected === 3),
    "wrong original termination reason",
  );
  for (const termination of terminations) subject(termination, native, at);
  proof(
    terminations[0]!.terminalBefore === 0 &&
      integer(terminations[0]!.order) > integer(compilations[64]!.order) &&
      integer(terminations[0]!.order) < integer(allocations[64]!.order) &&
      terminations.slice(1).every((entry) => entry.terminalBefore === 3),
    "resource closure was injected or selected earlier",
  );
}
function successfulPayload(
  publication: Record<string, unknown>,
  allocation: Record<string, unknown>,
  result: Record<string, number>,
  request: Record<string, number>,
  native: Record<string, unknown>,
  at: number,
) {
  subject(publication, native, at);
  proof(
    allocation.outcome === "handle" &&
      allocation.terminalReason === 0 &&
      allocation.failure === null &&
      allocation.handle === result.handle &&
      allocation.generation === result.generation,
    "native payload allocation differs from C",
  );
  proof(
    publication.token === request.token &&
      publication.status === 0 &&
      publication.handle === result.handle &&
      publication.generation === result.generation &&
      publication.length === result.length &&
      publication.published === true &&
      (publication.repliesUsed === 0 || publication.repliesUsed === 40) &&
      integer(publication.order) > integer(allocation.order),
    "missing committed original payload publication",
  );
}
function payloadHistory(before: Record<string, unknown>, after: Record<string, unknown>) {
  const a = pressure(before),
    b = pressure(after);
  for (const key of ["allocations", "publications", "terminations"])
    prefix(entries(a[key]), entries(b[key]), "native payload event prefix changed");
  const previous = entries(a.compilations),
    next = entries(b.compilations);
  proof(next.length >= previous.length, "native compilation history dropped");
  for (const [index, call] of previous.entries()) {
    const changed = next[index]!;
    for (const key of ["order", "owner", "grant", "connection", "device", "at", "call", "pending"])
      proof(call[key] === changed[key], "native compilation identity changed");
    if (call.settled !== "pending") {
      equal(call, changed, "native compilation settlement changed");
      continue;
    }
    proof(
      changed.settled === "pending" ||
        ((changed.settled === "fulfilled" || changed.settled === "rejected") &&
          number(changed.settledAt) >= number(before.at)),
      "native compilation settlement predates pending capture",
    );
  }
}
function terminalOwner(native: Record<string, unknown>, reason: number, acknowledged: boolean) {
  proof(
    native.state === "terminal" &&
      native.terminalReason === reason &&
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
      native.retiredAck === acknowledged &&
      record(native.commands).terminal === reason &&
      record(native.replies).terminal === reason,
    "connection resources did not retire locally",
  );
}
function frozen(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  id: unknown,
  draining: boolean,
) {
  const a = owner(before, id, "earliest terminal"),
    b = owner(after, id, "retired");
  const oldReply = record(a.replies),
    newReply = record(b.replies);
  if (draining) {
    proof(
      oldReply.head === newReply.head &&
        oldReply.terminal === newReply.terminal &&
        newReply.writer === 0 &&
        (newReply.tail === oldReply.tail || newReply.tail === newReply.head),
      "late retired reply publication",
    );
    // The one admitted C drain may advance only the reply tail, never native work or the head.
    immutableRetired({ ...a, replies: b.replies }, b);
  } else immutableRetired(a, b);
  const old = record(before.fairness),
    next = record(after.fairness);
  const owned = (source: Record<string, unknown>, name: string) =>
    entries(source[name]).filter((entry) => entry.connection === id);
  for (const key of ["presents", "slices", "blobs"])
    equal(owned(old, key), owned(next, key), "late retired native or completed-blob work");
  for (const key of ["records", "native"]) {
    const selected = (source: Record<string, unknown>) =>
      Object.entries(record(source[key])).filter(([name]) => name.startsWith(`${id}:`));
    equal(selected(old), selected(next), "late retired native calls");
  }
  unchangedSubmissions(owned(old, "queue"), owned(next, "queue"), number(before.at));
}
function controls(
  service: Record<string, unknown>,
  native: Record<string, unknown>,
  reason: number,
) {
  const matches = entries(service.attempts).filter((attempt) => attempt.owner === native.id);
  proof(matches.length === 1, "missing original open controls");
  const attempt = matches[0]!;
  proof(
    attempt.grant === native.grant &&
      attempt.surface === native.surface &&
      attempt.connection === 1 &&
      attempt.status === (reason === 0 ? 1 : reason === 3 ? -48 : -64) &&
      attempt.reason === reason &&
      attempt.arenaTerminal === reason &&
      attempt.retiredAck === native.retiredAck,
    "original control/ring/arena reason differs",
  );
  equal(attempt.commands, native.commands, "command control snapshot differs");
  equal(attempt.replies, native.replies, "reply control snapshot differs");
}
function topology(service: Record<string, unknown>, connections: number, heap: number) {
  proof(
    service.connections === connections &&
      service.devicesLive === connections &&
      service.presentCanvasesLive === Math.min(connections, 1) &&
      service.nativeRequests === entries(service.owners).length &&
      integer(service.heapBytes) <= 64 * 1024 * 1024,
    "shared service topology or bounded credit differs",
  );
  const frames = entries(service.owners).filter((native) => native.frame === true).length;
  proof(
    service.frameTexturesLive === frames && frames <= 1,
    "frame accounting differs from original peer",
  );
  if (connections === 1)
    proof(service.heapBytes === heap, "service credit did not return to peer-only baseline");
}
function physical(stop: unknown, guest: Record<string, unknown>) {
  const value = record(stop),
    outcome = record(value.exit);
  proof(
    value.pid === guest.pid &&
      outcome.kind === "exited" &&
      outcome.code === 0 &&
      value.grantRetired === true &&
      value.physicallyStopped === true &&
      !/GPU_FAIL|GPU_UNEXPECTED/.test(String(value.text)),
    "compiled physical stop or grant acknowledgement missing",
  );
  authority(value);
  return value;
}
export function validatePayloadPressureResult(value: unknown) {
  const result = record(value);
  proof(
    result.kind === "payload-pressure" &&
      typeof result.token === "string" &&
      result.token.length > 0,
    "wrong case identity",
  );
  const { guest, requested, results } = payloadImports(result.guest);
  const peerGuest = record(result.peerGuest),
    controlGuest = record(result.controlGuest),
    peer = record(result.peer);
  importControls(peerGuest);
  importControls(controlGuest);
  proof(
    new Set([guest.pid, peerGuest.pid, controlGuest.pid]).size === 3 &&
      new Set([guest.token, peerGuest.token, controlGuest.token]).size === 3 &&
      new Set([guest.surface, peerGuest.surface, controlGuest.surface]).size === 3,
    "guest identities alias",
  );
  proof(peerGuest.surface === peer.surface, "original peer guest/native surface mismatch");
  const controlExit = physical(result.controlExit, controlGuest),
    controlService = record(controlExit.service);
  assertRetired(controlService);
  accounting(controlExit.snapshot, 1, 1);
  const coverage = record(result.controlCoverage),
    uncovered = record(result.uncovered);
  proof(
    entries(uncovered.owners).length === 1 &&
      entries(uncovered.attempts).length === 1 &&
      uncovered.connections === 1,
    "missing native uncovered control",
  );
  nativeCoverage(coverage.coverage);
  proof(
    record(record(uncovered.coverage).native).draw === 0,
    "native uncovered control already covered",
  );
  proof(
    identity(controlService, controlGuest).surface === controlGuest.surface,
    "positive control guest/native identity mismatch",
  );
  rendered(coverage, identity(coverage, controlGuest).id);
  const observed = record(result.observed),
    firstReady = record(result.firstReady);
  equal(identity(observed, peerGuest), peer, "original peer identity substituted");
  const victim = identity(firstReady, guest);
  proof(
    victim.state === "ready" && victim.created === 1 && victim.destroyed === 0,
    "first ready native owner missing",
  );
  const phases = entries(result.phases);
  equal(
    phases.map((phase) => phase.kind),
    ["live", "committed", "terminal", "drained", "stopped"],
    "missing ordered screenshot brackets",
  );
  const committed = record(result.committed),
    terminal = record(result.terminal),
    drained = record(result.drained),
    stop = physical(result.stop, guest),
    peerExit = physical(result.peerExit, peerGuest),
    final = record(result.final);
  proof(stop.text === guest.text, "final C output changed");
  guestPrefix(result.committedGuest, guest);
  guestPrefix(peerGuest, record(phases.at(-1)!.peerGuest));
  proof(
    String(peerExit.text).startsWith(text(record(phases.at(-1)!.peerGuest))),
    "peer output history changed at stop",
  );
  proof(
    !text(record(result.committedGuest)).includes("index=65 "),
    "refusal issued before committed gate",
  );
  const sequence = [
    uncovered,
    controlService,
    coverage,
    observed,
    record(phases[0]!.before),
    record(phases[0]!.service),
    firstReady,
    committed,
    record(phases[1]!.before),
    record(phases[1]!.service),
    terminal,
    record(phases[2]!.before),
    record(phases[2]!.service),
    drained,
    record(phases[3]!.before),
    record(phases[3]!.service),
    record(stop.service),
    record(phases[4]!.before),
    record(phases[4]!.service),
    record(peerExit.service),
    final,
  ];
  validateSequence(sequence, result, victim, peer, terminal, drained);
  const heap = number(observed.heapBytes);
  let previous = { presents: 0, queue: 0 };
  for (const [index, phase] of phases.entries()) {
    proof(phase.peerPid === peerGuest.pid, "original peer pid changed");
    guestPrefix(phase.peerGuest, record(phases.at(-1)!.peerGuest));
    proof(
      record(phase.peerGuest).pid === peerGuest.pid &&
        record(phase.peerGuest).token === peerGuest.token &&
        record(phase.peerGuest).surface === peerGuest.surface,
      "original peer incarnation changed",
    );
    if (index > 0) checkpointGuest(phase.guest, guest, String(phase.kind));
    previous = bracketProof(phase, peer.id, previous);
    accounting(phase.accounting, index === 0 || index === 4 ? 2 : 3, index === 4 ? 2 : 1);
    for (const service of [record(phase.before), record(phase.service)]) {
      live(owner(service, peer.id, "original peer"), peer);
      rendered(service, peer.id);
      topology(service, index === 1 ? 2 : 1, heap);
      if (index > 0)
        payloadState(service, victim, results, requested, index >= 2, index >= 3, index === 4);
    }
  }
  payloadState(committed, victim, results, requested, false, false, false);
  payloadState(terminal, victim, results, requested, true, false, false);
  payloadState(drained, victim, results, requested, true, true, false);
  terminalOwner(owner(record(stop.service), victim.id, "stopped payload owner"), 3, true);
  accounting(stop.snapshot, 2, 2);
  accounting(peerExit.snapshot, 1, 3);
  assertRetired(peerExit.service);
  assertRetired(final);
  const runtime = record(result.runtimeStop);
  proof(
    Array.isArray(runtime.errors) && runtime.errors.length === 0,
    "runtime teardown reported errors",
  );
  const workers = entries(runtime.workers);
  proof(
    workers.length >= 5 &&
      workers.every((worker) => worker.stopped === true) &&
      workers.filter((worker) => String(worker.url).includes("/gpu/service-worker.ts")).length ===
        1 &&
      workers.filter((worker) => worker.url === "/fs-worker.js").length === 1 &&
      workers.filter((worker) => worker.url === "/gpu-guest.js").length >= 3,
    "full physical worker teardown or single service missing",
  );
  accounting(runtime.snapshot, 0, 3);
  proof(
    entries(record(runtime.snapshot).holders).every((holder) => holder.state !== "live"),
    "live reservation survived disposal",
  );
  return timing(record(phases[4]!.service), peer.id);
}
function checkpointGuest(value: unknown, guest: Record<string, unknown>, kind: string) {
  guestPrefix(value, guest);
  const captured = record(value),
    output = text(captured),
    events = entries(captured.events);
  if (kind === "stopped") {
    equal(captured, guest, "stopped compiled record differs");
    return;
  }
  const marker =
    kind === "committed"
      ? "payload-last-committed"
      : kind === "terminal"
        ? "payload-refusal-requested"
        : "payload-terminal";
  proof(output.endsWith(`GPU_WAIT_STDIN stage=${marker}\n`), "compiled checkpoint substituted");
  const payloads = events.filter((event) => event.name === "payload" && event.phase === "return");
  const last = events.at(-1)!;
  proof(
    !events.some((event) => event.name === "close") &&
      payloads.length === (kind === "drained" ? 1 : 0) &&
      last.phase === "return" &&
      last.name === (kind === "drained" ? "payload" : "append") &&
      last.result === (kind === "drained" ? -48 : 0),
    "compiled checkpoint GPU calls differ",
  );
}
function rendered(service: Record<string, unknown>, id: unknown) {
  const observed = record(service.fairness),
    native = record(observed.native);
  for (const name of [
    "draw",
    "finish",
    "submit",
    "transferToImageBitmap",
    "transferFromImageBitmap",
  ])
    proof(
      native[`${id}:${name}`] !== undefined && integer(record(native[`${id}:${name}`]).count) > 0,
      "original native rendering coverage missing",
    );
  proof(
    entries(observed.slices).some((slice) => slice.connection === id && number(slice.draws) > 0) &&
      entries(observed.queue).some(
        (work) => work.connection === id && record(work.settlement).kind === "completed",
      ),
    "original native queue or draw coverage missing",
  );
}
function payloadState(
  service: Record<string, unknown>,
  victim: Record<string, unknown>,
  results: Record<string, number>[],
  requested: Record<string, number>[],
  terminal: boolean,
  drained: boolean,
  stopped: boolean,
) {
  const native = owner(service, victim.id, "original payload owner");
  controls(service, native, terminal ? 3 : 0);
  payloadNative(service, native, results, requested, terminal);
  proof(
    native.payloadReadySlots === 64 &&
      integer(record(native.replies).capacity) === 262144 &&
      record(native.replies).used === (drained ? 0 : terminal ? 64 : 40) &&
      record(native.commands).used === 0 &&
      record(native.commands).writer === 0,
    "unread slots or retained reply bytes differ",
  );
  if (terminal) {
    terminalOwner(native, 3, stopped);
    return;
  }
  peerProof(native, victim);
  proof(
    native.pending === 0 &&
      native.payloadBytes === 512 &&
      native.presenter === false &&
      native.partial === false,
    "payload storage confused with pending operations or bytes",
  );
}
function validateSequence(
  sequence: Record<string, unknown>[],
  result: Record<string, unknown>,
  victim: Record<string, unknown>,
  peer: Record<string, unknown>,
  terminal: Record<string, unknown>,
  drained: Record<string, unknown>,
) {
  const realm = sequence[0]!.realm;
  proof(typeof realm === "string" && realm.length > 0, "missing original service realm");
  const responses = new Set<unknown>(),
    identities = new Map<unknown, Record<string, unknown>>(),
    retiredAt = new Map<unknown, Record<string, unknown>>();
  let previous: Record<string, unknown> | undefined;
  for (const service of sequence) {
    proof(
      service.realm === realm &&
        typeof service.responseId === "string" &&
        !responses.has(service.responseId) &&
        integer(service.serial) > (previous ? integer(previous.serial) : 0) &&
        number(service.at) > (previous ? number(previous.at) : 0),
      "stale or cross-realm snapshot",
    );
    responses.add(service.responseId);
    if (previous) {
      cumulative(previous, service);
      payloadHistory(previous, service);
    }
    if (number(service.serial) >= number(record(result.observed).serial))
      proof(
        service.token === result.token && service.mode === "admission" && service.armed === false,
        "uncorrelated service selection",
      );
    const natives = entries(service.owners);
    proof(
      natives.length <= 3 &&
        entries(service.attempts).length === natives.length &&
        new Set(natives.map((native) => native.id)).size === natives.length,
      "owner cohort replaced or duplicated",
    );
    for (const native of natives)
      validateNativeHistory(service, native, identities, retiredAt, victim, terminal, drained);
    if (number(service.serial) >= number(record(result.observed).serial))
      proof(
        owner(service, peer.id, "original peer").surface === peer.surface,
        "original peer surface changed",
      );
    previous = service;
  }
  proof(identities.size === 3 && retiredAt.size === 3, "missing original owner retirement history");
}
function validateNativeHistory(
  service: Record<string, unknown>,
  native: Record<string, unknown>,
  identities: Map<unknown, Record<string, unknown>>,
  retiredAt: Map<unknown, Record<string, unknown>>,
  victim: Record<string, unknown>,
  terminal: Record<string, unknown>,
  drained: Record<string, unknown>,
) {
  const prior = identities.get(native.id) ?? native;
  for (const key of ["id", "grant", "surface", "device", "created"])
    proof(
      integer(native[key]) > 0 && native[key] === prior[key],
      "native identity changed from first ready",
    );
  identities.set(native.id, prior);
  controls(service, native, native.state === "ready" ? 0 : native.id === victim.id ? 3 : 1);
  const before = retiredAt.get(native.id);
  if (before)
    frozen(
      before,
      service,
      native.id,
      native.id === victim.id &&
        number(before.serial) >= number(terminal.serial) &&
        number(before.serial) < number(drained.serial),
    );
  if (native.state !== "terminal") return;
  const reason = native.id === victim.id ? 3 : 1;
  if (native.id !== victim.id) retired(native, reason);
  retiredAt.set(native.id, service);
}
