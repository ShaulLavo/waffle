import type { Page } from "playwright";
import { navigateTestPage } from "./browser-navigation.js";
import { invoke, pixels, assertTrianglePixels } from "./gpu-browser-shared.js";
import { qualificationRecord as record } from "./fixtures/gpu/qualification-contract.js";
import {
  checkpoint,
  current,
  until,
  entries,
  number,
  owner,
  nativeCoverage,
  timing,
  authority,
  accounting,
} from "./gpu-ownership-browser.js";
import {
  guest,
  identity,
  live,
  retired,
  cumulative,
  noRetiredWork,
} from "./gpu-regrant-browser.js";
import { activeImport, heldNative, startHeldOwnership, lifecycle } from "./gpu-disposal-browser.js";
import { bracketProof } from "./gpu-admission-browser.js";

async function serviceFailureCase(page: Page) {
  try {
    const held = await startHeldOwnership(page);
    await invoke(page, "serviceCommand", ["service-hold-open"]);
    await invoke(page, "launchTriangle", [[], "gpu", 3, true]);
    const pending = await until(page, (service) => service.pendingOpen !== null);
    const openingGuest = await invoke(page, "ownershipGuest", [3]);
    const failure = await invoke(page, "failGpuService");
    const lostPixels = await pixels(page, 1, false);
    await invoke(page, "launchTriangle", [["green", "--pause-acquired"], "gpu", 4, true]);
    await checkpoint(page, "GPU_WAIT_STDIN stage=acquired", 4);
    const recoveryGuest = await invoke(page, "ownershipGuest", [4]);
    const recoveryBefore = await current(page);
    await invoke(page, "feedTriangle", ["\n", 4]);
    await checkpoint(page, "GPU_FRAME colour=green", 4);
    const recoveryPixels = await pixels(page, 4);
    assertTrianglePixels(recoveryPixels, "green");
    const recoveryService = await current(page);
    const recovered = await invoke(page, "serviceFailureState");
    const recoveryExit = await invoke(page, "stopTriangle", [false, 4]);
    const after = await invoke(page, "serviceFailureState");
    const result = {
      kind: "whole-service-failure",
      ...held,
      openingGuest,
      pending,
      failure,
      lostPixels,
      recovery: {
        guest: recoveryGuest,
        before: recoveryBefore,
        service: recoveryService,
        pixels: recoveryPixels,
        state: recovered,
        exit: recoveryExit,
        after,
      },
    };
    try {
      return { ...result, measurements: validateServiceFailureResult(result) };
    } catch (error) {
      console.error(JSON.stringify({ stage: "service-failure-invalid", result }));
      throw error;
    }
  } finally {
    await invoke(page, "closeIntegration");
  }
}
export async function serviceFailureCases(source: Page, url: string, available: boolean) {
  if (!available) return { kind: "unsupported", implementedProofExecuted: false };
  const browser = source.context().browser();
  if (!browser) throw new Error("Service failure proof needs the registered browser");
  const context = await browser.newContext({
    viewport: { width: 320, height: 240 },
  });
  try {
    const page = await context.newPage();
    await navigateTestPage(page, url);
    return await serviceFailureCase(page);
  } finally {
    await context.close();
  }
}
function requireProof(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`GPU service failure ${message}`);
}
function equal(before: unknown, after: unknown, message: string) {
  requireProof(JSON.stringify(before) === JSON.stringify(after), message);
}
function guestHistory(before: Record<string, unknown>, after: Record<string, unknown>) {
  const original = entries(before.events);
  equal(
    original,
    entries(after.events).slice(0, original.length),
    "guest import history rewritten",
  );
  outputPrefix(before.text, after.text);
}
function outputPrefix(before: unknown, after: unknown) {
  requireProof(
    typeof before === "string" && typeof after === "string" && after.startsWith(before),
    "guest output history rewritten",
  );
}
function heldVictim(service: Record<string, unknown>, original: Record<string, unknown>) {
  const current = owner(service, original.id, "held victim");
  requireProof(
    ["grant", "surface", "device", "presenterId", "presenterDevice"].every(
      (key) => current[key] === original[key],
    ),
    "held victim native identity changed",
  );
  live(current, original);
  heldNative(service, current);
}
function workerHistory(before: Record<string, unknown>, after: Record<string, unknown>) {
  const current = entries(after.workers);
  for (const original of entries(before.workers)) {
    const matches = current.filter((worker) => worker.id === original.id);
    requireProof(matches.length === 1, "original physical worker omitted or duplicated");
    const next = matches[0]!;
    requireProof(
      ["id", "url", "createdAt", "pid", "token", "surface"].every(
        (key) => original[key] === undefined || original[key] === next[key],
      ),
      "original physical worker identity changed",
    );
    requireProof(
      typeof next.stopped === "boolean" && (original.stopped !== true || next.stopped === true),
      "original physical worker revived",
    );
  }
  const stops = entries(before.workerStops);
  equal(stops, entries(after.workerStops).slice(0, stops.length), "worker stop history rewritten");
}
function originalControls(state: Record<string, unknown>, grants: readonly unknown[]) {
  const controls = entries(state.controls).filter((item) => grants.includes(item.grant));
  requireProof(
    controls.length === grants.length &&
      new Set(controls.map((item) => item.grant)).size === grants.length,
    "missing original open controls",
  );
  return controls;
}
function terminal(control: Record<string, unknown>, reason: number) {
  requireProof(
    control.connection === 1 &&
      control.status === -64 &&
      control.reason === reason &&
      control.arenaTerminal === reason &&
      record(control.commands).terminal === reason &&
      record(control.replies).terminal === reason,
    "open waiter or rings not terminal",
  );
}
function liveRuntime(state: Record<string, unknown>, epoch: unknown) {
  requireProof(
    number(state.runtimeEpoch) > 0 && state.runtimeEpoch === epoch && state.disposed === false,
    "sole page runtime replaced or disposed",
  );
  requireProof(!("service" in state), "fabricated post-termination service snapshot");
}
function pixelObservation(value: unknown) {
  const image = record(value);
  for (const key of ["center", "corner"]) {
    const bytes = image[key];
    requireProof(
      Array.isArray(bytes) &&
        bytes.length === 4 &&
        bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
      "missing actual pixel observation",
    );
  }
  return {
    center: entriesAsNumbers(image.center),
    corner: entriesAsNumbers(image.corner),
  };
}
function entriesAsNumbers(value: unknown) {
  requireProof(Array.isArray(value), "missing pixel bytes");
  return value.map(number);
}
function openingWaiter(value: unknown, pending: Record<string, unknown>) {
  requireProof(
    pending.pendingOpen !== null && typeof pending.pendingOpen === "object",
    "missing actual opening waiter",
  );
  const openingGuest = record(value),
    events = entries(openingGuest.events),
    opening = record(pending.pendingOpen);
  requireProof(
    typeof openingGuest.token === "string" &&
      number(openingGuest.pid) > 0 &&
      number(openingGuest.surface) > 0 &&
      events.length === 1 &&
      events[0]!.token === openingGuest.token &&
      events[0]!.name === "open" &&
      events[0]!.phase === "enter" &&
      events[0]!.connection === 0 &&
      opening.surface === openingGuest.surface &&
      opening.connection === 1 &&
      number(opening.grant) > 0 &&
      !entries(pending.attempts).some((item) => item.grant === opening.grant),
    "missing actual opening waiter",
  );
  return openingGuest;
}
function preFailure(result: Record<string, unknown>) {
  const phases = entries(result.phases);
  requireProof(
    result.kind === "whole-service-failure" &&
      typeof result.token === "string" &&
      result.token.length > 0 &&
      phases.length === 2 &&
      phases[0]!.name === "live" &&
      phases[1]!.name === "held",
    "missing case or checkpoints",
  );
  nativeCoverage(result.coverage);
  const controlGuest = guest(result.controlGuest),
    peerGuest = guest(result.peerGuest),
    victimGuest = guest(result.victimGuest);
  const controlExit = record(result.controlExit),
    controlService = record(controlExit.service),
    first = record(phases[0]!.before),
    held = record(phases[1]!.service);
  authority(controlExit);
  requireProof(
    record(controlExit.exit).kind === "exited" &&
      record(controlExit.exit).code === 0 &&
      controlExit.grantRetired === true &&
      controlExit.physicallyStopped === true,
    "positive compiled control did not retire",
  );
  const control = identity(controlService, controlGuest),
    peer = identity(first, peerGuest),
    victim = identity(held, victimGuest);
  retired(control, 1);
  lifecycle(controlService, control);
  for (const key of ["id", "grant", "device", "surface"])
    requireProof(
      new Set([control[key], peer[key], victim[key]]).size === 3,
      "aliased original native identity",
    );
  activeImport(result.blockedGuest, victimGuest);
  guestHistory(victimGuest, record(result.blockedGuest));
  const armed = record(record(result.auditControl).service);
  requireProof(
    record(result.auditControl).name === "armed" &&
      armed.nativeHeld === false &&
      armed.armed === false &&
      armed.token === result.token &&
      armed.mode === "disposal",
    "missing pre-work shared audit positive control",
  );
  const history = [
    controlService,
    first,
    record(phases[0]!.service),
    armed,
    record(phases[1]!.before),
    held,
    record(result.pending),
  ];
  const responses = new Set<unknown>();
  let previous = controlService,
    serial = 0,
    at = 0;
  for (const service of history) {
    requireProof(
      typeof service.realm === "string" &&
        service.realm.length > 0 &&
        service.realm === first.realm &&
        number(service.serial) > serial &&
        number(service.at) >= at &&
        typeof service.responseId === "string" &&
        service.responseId.length > 0 &&
        !responses.has(service.responseId),
      "uncorrelated service observation",
    );
    if (service !== controlService) cumulative(previous, service);
    noRetiredWork(controlService, service, control.id);
    previous = service;
    serial = number(service.serial);
    at = number(service.at);
    responses.add(service.responseId);
  }
  let bracket = { presents: 0, queue: 0 };
  for (const phase of phases) {
    requireProof(phase.peerPid === peerGuest.pid, "original green peer replaced");
    for (const service of [record(phase.before), record(phase.service)]) {
      requireProof(
        service.token === result.token && service.mode === "disposal",
        "wrong selected service case",
      );
      live(owner(service, peer.id, "original peer"), peer);
    }
    bracket = bracketProof(phase, peer.id, bracket);
  }
  const pending = record(result.pending);
  requireProof(
    pending.token === result.token && pending.mode === "disposal",
    "wrong selected service case",
  );
  live(owner(pending, peer.id, "original peer"), peer);
  for (const service of [record(phases[1]!.before), held, pending]) heldVictim(service, victim);
  equal(
    record(phases[1]!.before).heldCompletion,
    held.heldCompletion,
    "first held completion identity changed",
  );
  equal(held.heldCompletion, pending.heldCompletion, "first held completion identity changed");
  const openingGuest = openingWaiter(result.openingGuest, pending),
    opening = record(pending.pendingOpen);
  const guests = [controlGuest, peerGuest, victimGuest, openingGuest];
  for (const key of ["pid", "token", "surface"])
    requireProof(
      new Set(guests.map((item) => item[key])).size === guests.length,
      "aliased compiled guest",
    );
  requireProof(
    ![control.grant, peer.grant, victim.grant].includes(opening.grant),
    "aliased opening grant",
  );
  return {
    held,
    pending,
    control,
    peer,
    victim,
    guests,
    blockedGuest: record(result.blockedGuest),
    grants: [control.grant, peer.grant, victim.grant, opening.grant],
  };
}
function failedService(result: Record<string, unknown>, original: ReturnType<typeof preFailure>) {
  const failure = record(result.failure),
    before = record(failure.before),
    stopped = record(failure.stopped),
    after = record(failure.after),
    fault = record(failure.fault);
  requireProof(
    typeof failure.id === "string" &&
      failure.id.length > 0 &&
      fault.trusted === true &&
      fault.message === `Uncaught Error: GPU_SERVICE_FAILURE ${failure.id}`,
    "not the authentic worker fault",
  );
  const workers = entries(before.workers),
    services = workers.filter((item) => String(item.url).includes("/gpu/service-worker.ts"));
  requireProof(
    services.length === 1 && services[0]!.stopped === false && fault.worker === services[0]!.id,
    "wrong failed service worker",
  );
  for (const [index, compiled] of original.guests.entries()) {
    const matches = workers.filter(
      (worker) =>
        worker.pid === compiled.pid &&
        worker.token === compiled.token &&
        worker.surface === compiled.surface,
    );
    requireProof(
      matches.length === 1 &&
        matches[0]!.url === "/gpu-guest.js" &&
        matches[0]!.stopped === (index === 0),
      "original physical worker correlation missing",
    );
  }
  const service = services[0]!,
    stops = entries(stopped.workerStops).filter((item) => item.id === service.id);
  requireProof(
    stops.length === 1 &&
      stops[0]!.url === service.url &&
      number(stops[0]!.at) >= number(failure.startedAt) &&
      number(stops[0]!.at) <= number(fault.at),
    "normal owner did not stop the failed worker",
  );
  const controls = originalControls(before, original.grants);
  requireProof(
    entries(before.controls).length === 4 && controls[0]!.grant === original.control.grant,
    "missing complete old open inventory",
  );
  terminal(controls[0]!, 1);
  for (const [index, item] of controls.slice(1).entries())
    requireProof(
      item.connection === 1 &&
        item.status === (index === 2 ? 0 : 1) &&
        item.reason === 0 &&
        item.arenaTerminal === 0 &&
        record(item.commands).terminal === 0 &&
        record(item.replies).terminal === 0,
      "connection or opening waiter already terminal",
    );
  const terminalControls = originalControls(stopped, original.grants);
  for (const item of terminalControls)
    terminal(item, item.grant === original.control.grant ? 1 : 5);
  for (const state of [stopped, after]) {
    liveRuntime(state, before.runtimeEpoch);
    equal(
      terminalControls,
      originalControls(state, original.grants),
      "late old publication changed",
    );
    const current = entries(state.workers);
    requireProof(
      current.find((item) => item.id === service.id)?.stopped === true &&
        current.filter((item) => String(item.url).includes("/gpu/service-worker.ts")).length ===
          1 &&
        current.some((item) => item.url === "/fs-worker.js" && item.stopped === false),
      "failed service revived or runtime topology stopped",
    );
    const revocations = entries(state.revocations);
    requireProof(
      revocations.length === 4 &&
        original.guests.every((compiled) =>
          revocations.some((item) => item.pid === compiled.pid && item.value === 1),
        ),
      "original grant revocation missing",
    );
  }
  workerHistory(before, stopped);
  workerHistory(stopped, after);
  equal(result.auditControl, failure.audit, "terminated service audit rewritten");
  failureExits(failure, original);
  accounting(after.snapshot, 1, 4);
  pixelObservation(result.lostPixels);
  return {
    before,
    after,
    service,
    stopAt: number(stops[0]!.at),
    controls: terminalControls,
  };
}
function failureExits(failure: Record<string, unknown>, original: ReturnType<typeof preFailure>) {
  const exits = entries(failure.exits);
  requireProof(exits.length === 3, "missing original guest failure");
  for (const [index, compiled] of original.guests.slice(1).entries()) {
    const matches = exits.filter((item) => item.pid === compiled.pid);
    requireProof(matches.length === 1, "original failed guest replaced");
    const item = matches[0]!,
      observed = record(item.guest),
      exit = record(item.exit);
    requireProof(
      observed.pid === compiled.pid &&
        observed.surface === compiled.surface &&
        observed.token === compiled.token &&
        exit.kind === "exited" &&
        exit.code === 1 &&
        exit.status === 1 &&
        item.grantRetired === true &&
        item.physicallyStopped === true,
      "wrong correlated guest failure or retirement",
    );
    authority(item);
    const events = entries(observed.events);
    const entered = index === 1 ? original.blockedGuest : compiled;
    const originalEvents = entries(entered.events);
    guestHistory(entered, observed);
    const last = events.at(-1)!;
    if (index !== 0)
      requireProof(
        events.length === originalEvents.length + 1 && last.call === originalEvents.at(-1)!.call,
        index === 1
          ? "held import completion identity changed"
          : "pending open completion identity changed",
      );
    const name = index === 2 ? "open" : index === 1 ? "completions" : last.name;
    requireProof(
      index !== 0 || name === "completions" || name === "append",
      "unrelated terminal import",
    );
    terminalCall(events, compiled.token, name);
    requireProof(
      typeof item.text === "string" &&
        item.text
          .split("\n")
          .filter((line) => line.startsWith("GPU_FAIL"))
          .join("\n") === `GPU_FAIL stage=${name} status=-64`,
      "wrong compiled failure stage",
    );
    outputPrefix(entered.text, item.text);
    const state = record(failure.after);
    requireProof(
      entries(state.workers).some(
        (worker) =>
          worker.pid === compiled.pid &&
          worker.token === compiled.token &&
          worker.surface === compiled.surface &&
          worker.stopped === true,
      ),
      "original guest worker not stopped",
    );
  }
}
function terminalCall(events: readonly Record<string, unknown>[], token: unknown, name: unknown) {
  const last = events.at(-1)!,
    call = events.filter((event) => event.call === last.call),
    entered = call[0]!;
  requireProof(
    last.name === name &&
      last.phase === "return" &&
      last.result === -64 &&
      events.every((event) => event.token === token && event.phase !== "throw") &&
      call.length >= 2 &&
      call.length <= 3 &&
      entered.phase === "enter" &&
      call.every((event) => event.name === name) &&
      call.slice(1, -1).every((event) => event.phase === "wait") &&
      (last.connection === undefined || last.connection === entered.connection),
    "uncorrelated terminal import outcome",
  );
}
function recoveredService(
  result: Record<string, unknown>,
  original: ReturnType<typeof preFailure>,
  failed: ReturnType<typeof failedService>,
) {
  const recovery = record(result.recovery),
    before = record(recovery.before),
    service = record(recovery.service),
    compiled = guest(recovery.guest),
    exit = record(recovery.exit),
    state = record(recovery.state),
    after = record(recovery.after);
  for (const key of ["pid", "token", "surface"])
    requireProof(
      original.guests.every((item) => item[key] !== compiled[key]),
      "recovery relabeled an original guest",
    );
  requireProof(
    typeof service.realm === "string" &&
      service.realm.length > 0 &&
      service.realm !== original.held.realm &&
      before.realm === service.realm &&
      number(service.serial) > number(before.serial) &&
      number(service.at) >= number(before.at) &&
      service.responseId !== before.responseId &&
      entries(service.owners).length === 1,
    "old service identity revived",
  );
  cumulative(before, service);
  const native = identity(service, compiled);
  live(native, identity(before, compiled));
  requireProof(
    !original.grants.includes(native.grant) && native.pending === 0,
    "old grant revived",
  );
  const work = record(service.fairness),
    previous = record(before.fairness);
  requireProof(
    entries(previous.presents).length === 0 &&
      entries(work.presents).some(
        (item) =>
          item.connection === native.id &&
          number(item.at) >= number(before.at) &&
          number(item.at) <= number(service.at),
      ),
    "missing recovery native present",
  );
  requireProof(
    entries(work.queue).some(
      (item) =>
        item.connection === native.id &&
        number(item.start) >= number(before.at) &&
        record(item.settlement).kind === "completed" &&
        number(record(item.settlement).at) >= number(item.start) &&
        number(record(item.settlement).at) <= number(service.at),
    ),
    "missing recovery native queue completion",
  );
  assertTrianglePixels(pixelObservation(recovery.pixels), "green");
  for (const observation of [state, after]) {
    liveRuntime(observation, failed.before.runtimeEpoch);
    equal(
      failed.controls,
      originalControls(observation, original.grants),
      "old publication revived through recovery",
    );
    const workers = entries(observation.workers),
      services = workers.filter((item) => String(item.url).includes("/gpu/service-worker.ts"));
    requireProof(
      services.length === 2 &&
        services[0]!.id === failed.service.id &&
        services[0]!.stopped === true &&
        services[1]!.id !== failed.service.id &&
        services[1]!.stopped === false &&
        number(services[1]!.createdAt) >= failed.stopAt,
      "concurrent service topology or old worker revived",
    );
  }
  workerHistory(failed.after, state);
  workerHistory(state, after);
  const liveControls = entries(state.controls),
    closedControls = entries(after.controls);
  const opened = liveControls.find((item) => item.grant === native.grant);
  const closed = closedControls.find((item) => item.grant === native.grant);
  requireProof(
    liveControls.length === 5 &&
      closedControls.length === 5 &&
      opened !== undefined &&
      opened.status === 1 &&
      opened.reason === 0 &&
      opened.arenaTerminal === 0 &&
      record(opened.commands).terminal === 0 &&
      record(opened.replies).terminal === 0 &&
      closed !== undefined,
    "fresh open controls missing or already retired",
  );
  terminal(closed, 1);
  authority(exit);
  requireProof(
    exit.pid === compiled.pid &&
      exit.grantRetired === true &&
      exit.physicallyStopped === true &&
      record(exit.exit).kind === "exited" &&
      record(exit.exit).code === 0,
    "recovery did not exit normally",
  );
  const terminalService = record(exit.service);
  requireProof(
    terminalService.realm === service.realm &&
      terminalService.token === service.token &&
      terminalService.mode === service.mode &&
      number(terminalService.serial) > number(service.serial) &&
      number(terminalService.at) >= number(service.at) &&
      typeof terminalService.responseId === "string" &&
      terminalService.responseId.length > 0 &&
      terminalService.responseId !== before.responseId &&
      terminalService.responseId !== service.responseId &&
      entries(terminalService.owners).length === 1 &&
      record(terminalService.fairness).overflow === false,
    "recovery terminal service identity changed",
  );
  cumulative(service, terminalService);
  const terminalNative = identity(terminalService, compiled);
  requireProof(
    ["id", "grant", "surface", "device", "created"].every(
      (key) => native[key] === terminalNative[key],
    ),
    "recovery terminal native identity changed",
  );
  retired(terminalNative, 1);
  accounting(state.snapshot, 2, 4);
  accounting(after.snapshot, 1, 5);
  for (const observation of [state, after]) {
    requireProof(
      observation.audit !== null && typeof observation.audit === "object",
      "terminated service audit missing through recovery",
    );
    equal(
      result.auditControl,
      observation.audit,
      "terminated service audit rewritten through recovery",
    );
  }
}
/** Uses retained shared controls after termination, never invented native resource zeroes. */
export function validateServiceFailureResult(value: unknown) {
  const result = record(value),
    original = preFailure(result),
    failed = failedService(result, original);
  recoveredService(result, original, failed);
  return timing(original.held, original.peer.id);
}
