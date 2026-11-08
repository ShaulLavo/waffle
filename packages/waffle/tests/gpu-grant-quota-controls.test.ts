import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { quotaImports, validateGrantQuotaResult } from "./gpu-grant-quota-browser.js";

const limit = 67108864,
  unit = 5505216,
  consumed = 66062724;
function audit() {
  return {
    canaries: Array.from({ length: 33 }, (_, index) => `canary-${index}`),
    leaks: new Array<string>(),
  };
}
function guest() {
  let lengths = [4],
    call = 0;
  const state = () => ({
    limit,
    consumed: lengths.reduce((sum, size) => sum + size, 0),
    receiptBytes: lengths.reduce((sum, size) => sum + size, 0),
    lengths: lengths.slice(),
  });
  const event = (name: string, phase: string, connection: number, result: number) => ({
    token: "victim",
    call,
    name,
    phase,
    connection,
    result,
    quota: state(),
  });
  const events: ReturnType<typeof event>[] = [];
  let text = "";
  for (let cycle = 1; cycle <= 14; cycle++) {
    call++;
    events.push(event("open", "enter", 0, 0));
    lengths = lengths.concat(cycle <= 12 ? [64, 4194368, 262208, 1048576] : [64]);
    events.push(event("open", "return", 0, cycle <= 12 ? 0 : -48));
    text += `GPU_QUOTA_OPEN cycle=${cycle} status=${cycle <= 12 ? 0 : -48} output=${cycle <= 12 ? cycle : 3735928559}\n`;
    if (cycle > 12) {
      text += "GPU_WAIT_STDIN stage=quota-refused\n";
      continue;
    }
    text += "GPU_WAIT_STDIN stage=quota-open\nGPU_WAIT_STDIN stage=quota-close\n";
    for (const name of ["append", "completions", "close", "close"]) {
      call++;
      events.push(event(name, "enter", cycle, 0), event(name, "return", cycle, 0));
    }
  }
  return { pid: 4, token: "victim", surface: 3, text, events };
}
function ledger(live: number, victim = false, peer = false) {
  const holder = (state: string, length: number) => ({
    label: "guest-control",
    state,
    shape: { length },
    declaredBytes: length,
  });
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: live }, () => holder("live", limit)).concat(
      [holder("debt", 5505220)],
      victim ? [holder("debt", consumed)] : [],
      peer ? [holder("debt", 5505220)] : [],
    ),
  };
}
function ring(terminal: number) {
  return { head: 100, tail: 100, terminal };
}
function native(id: number, live: boolean, acknowledged: boolean) {
  return {
    id,
    grant: id <= 2 ? id : 3,
    surface: id <= 2 ? id : 3,
    device: id,
    state: live ? "ready" : "terminal",
    terminalReason: live ? 0 : 1,
    devices: Number(live),
    created: 1,
    destroyed: Number(!live),
    pending: 0,
    payloadBytes: 0,
    replayBusy: false,
    partial: false,
    presenter: live,
    presenterId: live ? id : 0,
    presenterDevice: live ? id : 0,
    frame: false,
    readerDisposed: !live,
    retiredAck: acknowledged,
    readerReads: 10,
    ringReads: 10,
    logicalBytes: 0,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: 1,
    commands: ring(live ? 0 : 1),
    replies: ring(live ? 0 : 1),
  };
}
function snapshot(serial: number, cycle: number, kind: string, final = false) {
  const active = kind === "open",
    stopped = kind === "stopped" || final;
  const owners = [native(1, false, true), native(2, !final, final)].concat(
    Array.from({ length: cycle }, (_, index) =>
      native(index + 3, active && index === cycle - 1, stopped),
    ),
  );
  const fairness = {
    overflow: false,
    native: Object.fromEntries(owners.map((item) => [`${item.id}:submit`, { count: 1 }])),
    presents: owners.flatMap((item) =>
      Array.from({ length: item.id === 2 ? serial : 1 }, (_, index) => ({
        connection: item.id,
        at: item.id === 2 ? (index + 1) * 20 - 1 : 1,
      })),
    ),
    queue: owners.flatMap((item) =>
      Array.from({ length: item.id === 2 ? serial : 1 }, (_, index) => ({
        connection: item.id,
        start: item.id === 2 ? (index + 1) * 20 - 3 : 0,
        settlement: { kind: "completed", at: item.id === 2 ? (index + 1) * 20 - 2 : 1 },
      })),
    ),
    slices: owners.map((item) => ({ connection: item.id, start: 0, end: 1 })),
    blobs: new Array<{ connection: number; start: number; end: number | null }>(),
  };
  const connections = final ? 0 : active ? 2 : 1;
  return {
    realm: "one-service",
    token: "quota",
    mode: "admission",
    armed: false,
    serial,
    at: serial * 20,
    responseId: `sample-${serial}`,
    connections,
    devicesLive: connections,
    presentCanvasesLive: connections,
    heapBytes: connections,
    frameTexturesLive: 0,
    nativeRequests: cycle + 2,
    owners,
    attempts: owners.map((item) => ({
      owner: item.id,
      grant: item.grant,
      surface: item.surface,
      connection: item.id <= 2 ? 1 : item.id - 2,
      beforeConnections: 1,
      afterConnections: 2,
      beforeNativeRequests: 0,
      afterNativeRequests: 0,
      status: item.state === "ready" ? 1 : -64,
      reason: item.state === "ready" ? 0 : 1,
      arenaTerminal: item.state === "ready" ? 0 : 1,
      retiredAck: item.retiredAck,
    })),
    fairness,
  };
}
function stop(pid: number, text: string, live: number, victim = false, peer = false) {
  return {
    pid,
    text,
    exit: { kind: "exited", code: 0 },
    grantRetired: true,
    physicallyStopped: true,
    ownAuthority: [audit()],
    snapshot: ledger(live, victim, peer),
    service: snapshot(1, 0, "closed", true),
  };
}
function capturedGuest(value: ReturnType<typeof guest>, kind: string, cycle: number) {
  const size =
    kind === "open" ? (cycle - 1) * 10 + 6 : cycle <= 12 ? cycle * 10 : 120 + (cycle - 12) * 2;
  return { ...value, events: value.events.slice(0, size) };
}
function result() {
  const victim = guest();
  const peerGuest = { ...guest(), pid: 3, surface: 2, token: "peer" };
  peerGuest.events = peerGuest.events.map((event) => ({ ...event, token: "peer" }));
  const kinds = ["open", "closed", "open", "closed", "refused", "refused", "stopped"];
  const cycles = [1, 1, 2, 12, 13, 14, 14];
  const phases = kinds.map((kind, index) => ({
    kind,
    cycle: cycles[index]!,
    peerPid: 3,
    before: snapshot(index * 2 + 1, Math.min(cycles[index]!, 12), kind),
    service: snapshot(index * 2 + 2, Math.min(cycles[index]!, 12), kind),
    guest: capturedGuest(victim, kind, cycles[index]!),
    accounting: ledger(index === 6 ? 2 : 3, index === 6),
    pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
  }));
  const controlExit = stop(2, "control", 1);
  controlExit.service.owners = [native(1, false, true)];
  return {
    kind: "grant-quota",
    token: "quota",
    peer: native(2, true, false),
    peerGuest,
    guest: victim,
    phases,
    controlExit,
    coverage: {
      readerReads: 1,
      ringReads: 1,
      disposed: 1,
      destroyed: 1,
      nativeRequests: 1,
      presents: 1,
      native: {
        draw: 1,
        finish: 1,
        submit: 1,
        transferToImageBitmap: 1,
        transferFromImageBitmap: 1,
      },
    },
    stop: stop(4, victim.text, 2, true),
    peerExit: stop(3, "peer", 1, true, true),
    final: snapshot(15, 12, "stopped", true),
    runtimeStop: {
      errors: new Array<string>(),
      workers: [{ url: "/gpu/service-worker.ts/ownership", stopped: true }],
      snapshot: ledger(0, true, true),
    },
  };
}
type Result = ReturnType<typeof result>;
function rejects(change: (value: Result) => void, reason: RegExp) {
  const value = result();
  change(value);
  expect(() => validateGrantQuotaResult(value)).toThrow(reason);
}

test("same-incarnation accounting preserves partial allocations on both refusals", () => {
  expect(quotaImports(guest())).toBe(consumed);
  expect(consumed).toBe(4 + 12 * unit + 128);
});
test("complete same-grant proof remains functional rather than hardware qualification", () => {
  expect(validateGrantQuotaResult(result())).toMatchObject({
    hardwareQualified: false,
    targets: { sliceMs: 8, peerGapMs: 100 },
    targetStatus: "met",
  });
});
test("refusal errno, untouched output, receipts and close accounting have distinct controls", () => {
  rejects((value) => {
    value.guest.events.findLast(
      (event) => event.name === "open" && event.phase === "return",
    )!.result = -33;
  }, /wrong open errno/);
  rejects((value) => {
    value.guest.text = value.guest.text.replace("output=3735928559", "output=13");
  }, /untouched failure output/);
  rejects((value) => {
    value.guest.events[1]!.quota.receiptBytes++;
  }, /receipt and consumed/);
  rejects((value) => {
    const state = value.guest.events.find(
      (event) => event.name === "close" && event.phase === "return",
    )!.quota;
    const released = state.lengths.pop()!;
    state.consumed -= released;
    state.receiptBytes -= released;
  }, /normal close refunded/);
  rejects((value) => {
    const state = value.guest.events.findLast((event) => event.name === "open")!.quota;
    state.lengths.push(4194368);
    state.consumed += 4194368;
    state.receiptBytes += 4194368;
  }, /unadmitted construction/);
  rejects((value) => {
    value.guest.text += "GPU_FAIL stage=device status=-64";
  }, /unrelated C failure/);
});
test("full live reservation and conservative retirement debt cannot be refunded or retained unused", () => {
  rejects((value) => {
    value.phases[1]!.accounting.holders.splice(0, 1);
  }, /live reservation/);
  rejects((value) => {
    value.stop.snapshot.holders.at(-1)!.shape.length = limit;
  }, /unused allowance release/);
  rejects((value) => {
    value.phases[6]!.accounting.holders.find((holder) => holder.shape.length === 5505220)!.state =
      "released";
  }, /invalid retired ledger/);
  rejects((value) => {
    value.stop.physicallyStopped = false;
  }, /actual C physical stop/);
});
test("global cap, replacement grants, late activation and wrong terminal reasons cannot stand in for quota", () => {
  rejects((value) => {
    value.phases[4]!.service.connections = 8;
  }, /global service cap/);
  rejects((value) => {
    value.phases[5]!.service.attempts.push(value.phases[5]!.service.attempts[0]!);
  }, /failed open reached service/);
  rejects((value) => {
    value.phases[3]!.service.owners[3]!.grant++;
  }, /guest grant replaced/);
  rejects((value) => {
    value.phases[1]!.service.owners[2]!.terminalReason = 3;
  }, /normal close terminal/);
  rejects((value) => {
    value.phases[2]!.guest = { ...value.guest, pid: 99 };
  }, /incarnation changed/);
});
test("original peer needs fresh bracketed queue work, presents and its original presenter", () => {
  rejects((value) => {
    value.phases[4]!.service.owners[1]!.presenterId++;
  }, /presenter replaced/);
  rejects((value) => {
    value.phases[4]!.service.fairness.queue.filter((work) => work.connection === 2).at(-1)!.start =
      0;
  }, /in-bracket queue/);
  rejects((value) => {
    const presents = value.phases[4]!.service.fairness.presents;
    presents.splice(
      presents.findLastIndex((present) => present.connection === 2),
      1,
    );
  }, /missing fresh|missing new/);
  rejects((value) => {
    value.phases[4]!.service.realm = "replacement-service";
  }, /cross-realm/);
  rejects((value) => {
    value.final.realm = "replacement-service";
  }, /terminal realm/);
  rejects((value) => {
    value.runtimeStop.workers[0]!.stopped = false;
  }, /worker stop audit/);
});
test("earliest retired history and completed blobs reject late work", () => {
  rejects((value) => {
    value.phases[5]!.service.owners[2]!.readerReads++;
  }, /late retired owner work/);
  rejects((value) => {
    value.phases[5]!.service.fairness.blobs.push({ connection: 3, start: 1, end: 2 });
  }, /completed-blob work/);
  rejects((value) => {
    value.phases[5]!.service.fairness.queue.find((work) => work.connection === 3)!.settlement.at++;
  }, /settlement changed/);
});
test("legitimate pending settlement after the earliest retired snapshot stays valid", () => {
  const value = result();
  const work = value.phases[1]!.before.fairness.queue.find((work) => work.connection === 3)!;
  work.settlement = { kind: "pending", at: 0 };
  for (const phase of value.phases.slice(1)) {
    for (const service of [phase.before, phase.service]) {
      const queue = service.fairness.queue.find((entry) => entry.connection === 3)!;
      if (queue === work) continue;
      queue.settlement.at = value.phases[1]!.before.at + 1;
    }
  }
  value.final.fairness.queue.find((entry) => entry.connection === 3)!.settlement.at =
    value.phases[1]!.before.at + 1;
  expect(validateGrantQuotaResult(value).hardwareQualified).toBe(false);
});
test("default compiled runner discovers quota and retains every earlier case", () => {
  const source = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  for (const name of [
    "grantQuotaCases",
    "serviceFailureCases",
    "disposalCases",
    "regrantCases",
    "admissionCases",
    "malformedCases",
    "ownershipCases",
    "fairnessCases",
    "sceneCases",
    "frameModes",
    "forgedCase",
  ])
    expect(source).toContain(`await ${name}(`);
  expect(source).toContain('"--grant-quota-only"');
});

test("a later same-guest import cannot backfill an earlier C checkpoint", () => {
  rejects((value) => {
    value.phases[0]!.guest = value.guest;
  }, /later import substituted/);
  rejects((value) => {
    value.coverage.disposed = 0;
  }, /missing observer coverage/);
  rejects((value) => {
    value.phases[4]!.service.serial = value.phases[4]!.before.serial;
  }, /stale or cross-realm/);
});

test("control and terminal histories cannot join numeric identities from different realms", () => {
  rejects((value) => {
    value.controlExit.service.realm = "other-service";
  }, /another service realm/);
  rejects((value) => {
    value.final.owners[2] = value.final.owners[3]!;
  }, /terminal native cohort duplicated/);
  rejects((value) => {
    value.final.owners[1]!.device++;
  }, /terminal native identity/);
  rejects((value) => {
    value.final.attempts[1]!.connection++;
  }, /terminal open history/);
});
