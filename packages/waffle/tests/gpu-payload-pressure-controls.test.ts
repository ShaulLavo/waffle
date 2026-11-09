import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { payloadImports, validatePayloadPressureResult } from "./gpu-payload-pressure-browser.js";
import { entries } from "./gpu-ownership-browser.js";

const methods = ["draw", "finish", "submit", "transferToImageBitmap", "transferFromImageBitmap"];
function audit() {
  return {
    canaries: Array.from({ length: 33 }, (_, index) => `canary-${index}`),
    leaks: new Array<string>(),
  };
}
function ring(reason: number, head = 100, tail = head) {
  return { capacity: 262144, head, tail, used: head - tail, writer: 0, terminal: reason };
}
function native(id: number, serial: number) {
  const payload = id === 33;
  const terminal = id === 11 ? serial >= 2 : id === 22 ? serial >= 20 : serial >= 11;
  const reason = terminal ? (payload ? 3 : 1) : 0;
  const unread = payload && serial >= 8 && serial < 14;
  return {
    id,
    grant: id,
    surface: id / 11,
    device: id,
    state: terminal ? "terminal" : "ready",
    terminalReason: reason,
    devices: terminal ? 0 : 1,
    created: 1,
    destroyed: terminal ? 1 : 0,
    readerReads: 10,
    ringReads: 10,
    logicalBytes: 0,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: 66000,
    readerDisposed: terminal,
    retiredAck: terminal && (!payload || serial >= 17),
    partial: false,
    pending: 0,
    payloadBytes: payload && !terminal ? 512 : 0,
    payloadReadySlots: payload ? 64 : 0,
    replayBusy: false,
    presenter: !payload && !terminal,
    presenterId: !payload && !terminal ? id : 0,
    presenterDevice: !payload && !terminal ? id : 0,
    frame: false,
    commands: ring(reason, payload && serial >= 11 ? 1024 : 1000),
    replies: ring(
      reason,
      payload && serial >= 11 ? 1024 : 1000,
      unread ? 960 : payload && serial >= 11 ? 1024 : 1000,
    ),
  };
}
function ledger(live: number, debt: number) {
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: live }, () => ({
      label: "guest-control",
      state: "live",
      shape: { length: 67108864 },
    })).concat(
      Array.from({ length: debt }, () => ({
        label: "guest-control",
        state: "debt",
        shape: { length: 5505220 },
      })),
    ),
  };
}
function payloadEvents(serial: number) {
  const count = serial >= 11 ? 65 : serial >= 8 ? 64 : 0;
  const subject = (order: number, at: number) => ({
    order,
    owner: 33,
    grant: 33,
    connection: 1,
    device: 33,
    at,
  });
  const compilations = Array.from({ length: count }, (_, index) => ({
    ...subject(3 + index * 3, index === 64 ? 205 : 145 + index / 100),
    call: index + 1,
    settled: "fulfilled",
    settledAt: index === 64 ? 205.001 : 145 + index / 100 + 0.001,
    pending: 1,
  }));
  const allocations = Array.from({ length: count }, (_, index) => ({
    ...subject(
      4 + index * 3 + Number(index === 64),
      index === 64 ? 205.02 : 145 + index / 100 + 0.002,
    ),
    length: 8,
    readyBefore: index,
    readyAfter: Math.min(index + 1, 64),
    repliesUsedBefore: index === 64 ? 40 : 0,
    pendingBefore: 0,
    outcome: index === 64 ? "refused" : "handle",
    handle: index === 64 ? 0 : index + 1,
    generation: index === 64 ? 0 : 1,
    terminalReason: index === 64 ? 3 : 0,
    failure: index === 64 ? "Payload credit exhausted" : null,
  }));
  const publications = Array.from({ length: Math.min(count, 64) }, (_, index) => ({
    ...subject(5 + index * 3, 145 + index / 100 + 0.003),
    token: 100 + index,
    status: 0,
    handle: index + 1,
    generation: 1,
    length: 8,
    published: true,
    repliesUsed: 40,
  }));
  const terminations =
    serial >= 11 ? [{ ...subject(196, 205.01), requested: 3, terminalBefore: 0, selected: 3 }] : [];
  return {
    compilations,
    allocations,
    publications,
    terminations,
    dropped: 0,
    uncorrelatedCompilations: 0,
  };
}
function snapshot(serial: number) {
  const owners = [native(11, serial)].concat(
    serial >= 4 ? [native(22, serial)] : [],
    serial >= 7 ? [native(33, serial)] : [],
  );
  const connections = owners.filter((owner) => owner.state === "ready").length;
  const peerCount = Math.max(0, Math.min(serial, 20) - 3);
  return {
    realm: "one-realm",
    serial,
    at: serial * 20,
    responseId: `sample-${serial}`,
    token: serial >= 4 ? "payload" : undefined,
    mode: serial >= 4 ? "admission" : undefined,
    armed: false,
    connections,
    devicesLive: connections,
    presentCanvasesLive: serial >= 4 && serial < 20 ? 1 : serial === 1 ? 1 : 0,
    frameTexturesLive: 0,
    heapBytes: serial >= 7 && serial < 11 ? 131500 : connections ? 66000 : 0,
    nativeRequests: owners.length,
    owners,
    attempts: owners.map((owner) => ({
      owner: owner.id,
      grant: owner.grant,
      surface: owner.surface,
      connection: 1,
      status: owner.state === "ready" ? 1 : owner.id === 33 ? -48 : -64,
      reason: owner.terminalReason,
      arenaTerminal: owner.terminalReason,
      retiredAck: owner.retiredAck,
      commands: owner.commands,
      replies: owner.replies,
    })),
    lifecycle: new Array<Record<string, unknown>>(),
    fairness: {
      overflow: false,
      native: Object.fromEntries(
        owners.flatMap((owner) =>
          owner.id === 33
            ? [
                [
                  "33:getCompilationInfo",
                  { count: serial >= 11 ? 65 : serial >= 8 ? 64 : 0, totalMs: 1, maxMs: 1 },
                ],
              ]
            : methods.map((method) => [
                `${owner.id}:${method}`,
                { count: 1, totalMs: 1, maxMs: 1 },
              ]),
        ),
      ),
      records: {},
      blobs: [{ connection: 11, commandRingBytes: 4194304, bytes: 8, draws: 1, start: 8, end: 9 }],
      slices: [{ connection: 11, start: 8, end: 9, draws: 1 }].concat(
        serial >= 4 ? [{ connection: 22, start: 65, end: 66, draws: 1 }] : [],
      ),
      presents: [{ connection: 11, at: 9 }].concat(
        Array.from({ length: peerCount }, (_, index) => ({
          connection: 22,
          at: (index + 4) * 20 - 1,
        })),
      ),
      queue: [{ connection: 11, start: 7, settlement: { kind: "completed", at: 9 } }].concat(
        Array.from({ length: peerCount }, (_, index) => ({
          connection: 22,
          start: (index + 4) * 20 - 3,
          settlement: { kind: "completed", at: (index + 4) * 20 - 2 },
        })),
      ),
    },
    payloadPressure: payloadEvents(serial),
  };
}
function compilation(index: number) {
  return { kind: 17, bytes: 40, token: 99 + index, status: 0, words: [1, 0, index, 1, 8, 0] };
}
function compiled() {
  let call = 0;
  const events: Record<string, unknown>[] = [];
  const invoke = (
    name: string,
    result: number,
    records?: Record<string, unknown>[],
    payload?: { handle: number; generation: number },
  ) => {
    call++;
    events.push({
      call,
      token: "victim",
      name,
      phase: "enter",
      connection: name === "open" ? 0 : 1,
      authority: audit(),
      payload,
    });
    events.push({ call, token: "victim", name, phase: "return", result, records });
  };
  let text =
    "GPU_STAGE surface id=3 width=64 height=64 scale=1000 flags=3\nGPU_STAGE open\nGPU_STAGE adapter\nGPU_STAGE device\nGPU_PAYLOAD_READY connection=1 surface=3 shader=6 slots=64\n";
  invoke("open", 0);
  for (const kind of [1, 2, 5]) {
    invoke("append", 0);
    invoke("completions", 0, [{ kind, bytes: 32, status: 0, token: kind, words: [] }]);
  }
  for (let index = 1; index <= 64; index++) {
    invoke("append", 0);
    text += `GPU_PAYLOAD_REQUESTED index=${index} token=${index + 99}\n`;
    if (index === 64) continue;
    invoke("completions", 0, [compilation(index)]);
    text += `GPU_PAYLOAD_RESULT index=${index} token=${index + 99} handle=${index} generation=1 length=8 read=0 phase=ready\n`;
  }
  text += "GPU_WAIT_STDIN stage=payload-last-committed\n";
  const committed = { events: events.slice(), text };
  invoke("append", 0);
  text +=
    "GPU_STDIN stage=payload-last-committed count=1\nGPU_PAYLOAD_REQUESTED index=65 token=164\nGPU_WAIT_STDIN stage=payload-refusal-requested\n";
  const terminal = { events: events.slice(), text };
  invoke("completions", 0, [
    compilation(64),
    { kind: 12, bytes: 24, token: 0, status: 0, words: [3, 0] },
  ]);
  invoke("completions", -48);
  invoke("payload", -48, undefined, { handle: 64, generation: 1 });
  text +=
    "GPU_STDIN stage=payload-refusal-requested count=1\nGPU_PAYLOAD_RESULT index=64 token=163 handle=64 generation=1 length=8 read=0 phase=terminal\nGPU_PAYLOAD_TERMINAL reason=3 records=2 successes=1 closed=1 status=-48\nGPU_PAYLOAD_AFTER_TERMINAL token=163 handle=64 generation=1 read=-48\nGPU_WAIT_STDIN stage=payload-terminal\n";
  const drained = { events: events.slice(), text };
  invoke("close", 0);
  invoke("close", 0);
  text += "GPU_STDIN stage=payload-terminal count=1\nGPU_STAGE closed\n";
  const id = { pid: 30, token: "victim", surface: 3 };
  return {
    full: { ...id, events, text },
    committed: { ...id, ...committed },
    terminal: { ...id, ...terminal },
    drained: { ...id, ...drained },
  };
}
function stop(pid: number, text: string, serial: number, live: number, debt: number) {
  return {
    pid,
    text,
    exit: { kind: "exited", code: 0 },
    grantRetired: true,
    physicallyStopped: true,
    ownAuthority: [audit()],
    service: snapshot(serial),
    snapshot: ledger(live, debt),
  };
}
function fixture() {
  const guest = compiled();
  const original = (token: string, pid: number, surface: number) => ({
    ...guest.full,
    token,
    pid,
    surface,
    events: guest.full.events.map((event) => ({ ...event, token })),
  });
  const peerGuest = original("peer", 20, 2),
    controlGuest = original("control", 10, 1);
  const controlCoverage = {
    ...snapshot(3),
    coverage: {
      readerReads: 1,
      ringReads: 1,
      disposed: 1,
      destroyed: 1,
      nativeRequests: 1,
      presents: 1,
      native: Object.fromEntries(methods.map((name) => [name, 1])),
    },
  };
  const names = ["live", "committed", "terminal", "drained", "stopped"];
  const serials = [5, 9, 12, 15, 18];
  const captures = [undefined, guest.committed, guest.terminal, guest.drained, guest.full];
  const terminal = snapshot(11);
  return {
    kind: "payload-pressure",
    token: "payload",
    guest: guest.full,
    peerGuest,
    controlGuest,
    peer: native(22, 4),
    observed: snapshot(4),
    firstReady: snapshot(7),
    uncovered: {
      ...snapshot(1),
      coverage: {
        ...controlCoverage.coverage,
        native: { ...controlCoverage.coverage.native, draw: 0 },
      },
    },
    controlCoverage,
    controlExit: stop(10, controlGuest.text, 2, 1, 1),
    committedGuest: guest.committed,
    committed: snapshot(8),
    refusal: terminal,
    terminal,
    drained: snapshot(14),
    stop: stop(30, guest.full.text, 17, 2, 2),
    phases: names.map((kind, index) => ({
      kind,
      before: snapshot(serials[index]!),
      service: snapshot(serials[index]! + 1),
      peerPid: 20,
      peerGuest,
      guest: captures[index],
      accounting: ledger(index === 0 || index === 4 ? 2 : 3, index === 4 ? 2 : 1),
      pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
    })),
    peerExit: stop(20, peerGuest.text, 20, 1, 3),
    final: snapshot(21),
    runtimeStop: {
      errors: [],
      snapshot: ledger(0, 3),
      workers: [
        "/fs-worker.js",
        "/gpu/service-worker.ts/ownership",
        "/gpu-guest.js",
        "/gpu-guest.js",
        "/gpu-guest.js",
      ].map((url) => ({ url, stopped: true })),
    },
  };
}
function services(value: ReturnType<typeof fixture>) {
  return Array.from(
    new Set(
      [
        value.uncovered,
        value.controlExit.service,
        value.controlCoverage,
        value.observed,
        value.firstReady,
        value.committed,
        value.refusal,
        value.terminal,
        value.drained,
        value.stop.service,
        value.peerExit.service,
        value.final,
      ].concat(value.phases.flatMap((phase) => [phase.before, phase.service])),
    ),
  );
}
function rejects(change: (value: ReturnType<typeof fixture>) => void, reason: RegExp) {
  const value = fixture();
  change(value);
  expect(() => validatePayloadPressureResult(value)).toThrow(reason);
}

test("the complete payload scalar model passes with correlated non-default tokens", () => {
  expect(validatePayloadPressureResult(fixture()).hardwareQualified).toBe(false);
});
test("default compiled and unit commands discover payload pressure", () => {
  const runner = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  expect(runner).toContain(
    'import { payloadPressureCases } from "./gpu-payload-pressure-browser.js"',
  );
  expect(runner).toMatch(/await payloadPressureCases\(page, url, available\)/);
  expect(runner).toMatch(/if \(payloadOnly\)/);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.scripts.test).toBe("bun test ./tests");
});
test("the opt-in observation delegates actual payload and close imports", () => {
  const source = readFileSync(
    new URL("./fixtures/gpu/integration-guest.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain('data.args.includes("--payload-pressure")');
  expect(source).toContain('["payload", "close"]');
  expect(source).toContain("apply(original, this, args)");
  expect(source).toContain("throw error");
});

test("missing native positive coverage fails for its intended reason", () => {
  rejects((value) => {
    value.controlCoverage.coverage.native.draw = 0;
  }, /missing native observer coverage/);
});
test("wrong compiled terminal stage fails", () => {
  rejects((value) => {
    value.guest.text = value.guest.text.replace("reason=3 records=2", "reason=2 records=2");
  }, /exact compiled terminal stage/);
});
test("wrong real payload import errno fails", () => {
  rejects((value) => {
    value.guest.events.find(
      (event) => event.name === "payload" && event.phase === "return",
    )!.result = 0;
  }, /payload import consumed early or revived/);
});
function closedBatch(event: Record<string, unknown>) {
  return (
    event.name === "completions" && entries(event.records ?? []).some((reply) => reply.kind === 12)
  );
}
test("committed success cannot be dropped behind closed", () => {
  rejects((value) => {
    const event = value.guest.events.find(closedBatch)!;
    event.records = entries(event.records).toReversed();
  }, /last committed success not drained before closed/);
});
test("early payload consumption fails independently", () => {
  const value = fixture();
  const event = value.guest.events.find(
    (event) => event.name === "payload" && event.phase === "return",
  )!;
  event.result = 0;
  expect(() => payloadImports(value.guest)).toThrow(/payload import consumed early or revived/);
});
for (const [key, replacement, reason] of [
  ["readyBefore", 63, /payload slots or reply storage/],
  ["repliesUsedBefore", 262144, /payload slots or reply storage/],
  ["pendingBefore", 64, /pending limit interfered/],
  ["failure", "Reply credit exhausted", /wrong payload resource refusal/],
  ["terminalReason", 2, /wrong payload resource refusal/],
] satisfies [string, number | string, RegExp][])
  test(`refusal must identify payload storage rather than ${key}`, () => {
    rejects((value) => {
      for (const service of services(value)) {
        const last = service.payloadPressure.allocations[64];
        if (last) Reflect.set(last, key, replacement);
      }
    }, reason);
  });
test("original control and arena terminal reason must agree", () => {
  rejects((value) => {
    value.terminal.attempts[2]!.arenaTerminal = 2;
  }, /control\/ring\/arena reason differs/);
});
test("native payload publication must be committed", () => {
  rejects((value) => {
    for (const service of services(value)) {
      const last = service.payloadPressure.publications[63];
      if (last) last.published = false;
    }
  }, /committed original payload publication/);
});
test("retired payload slots cannot masquerade as physical reclamation", () => {
  rejects((value) => {
    value.phases[2]!.service.owners[2]!.payloadReadySlots = 0;
  }, /unread slots or retained reply bytes/);
});
test("resource closure must be selected by the original native call", () => {
  rejects((value) => {
    for (const service of services(value)) {
      const entry = service.payloadPressure.terminations[0];
      if (entry) entry.terminalBefore = 3;
    }
  }, /closure was injected/);
});
test("native compilation settlement cannot be rewritten", () => {
  rejects((value) => {
    value.final.payloadPressure.compilations[0]!.settled = "rejected";
  }, /compilation settlement changed/);
});
test("native allocation event prefixes cannot be rewritten", () => {
  rejects((value) => {
    value.final.payloadPressure.allocations[0]!.handle = 2;
  }, /payload event prefix changed/);
});
test("peer guest must join the original native surface", () => {
  rejects((value) => {
    value.peerGuest.surface = 99;
  }, /peer guest\/native surface mismatch/);
});
test("first-ready grant and device identities cannot change", () => {
  rejects((value) => {
    value.firstReady.owners[2]!.device = 99;
  }, /native identity changed from first ready/);
});
test("stale service observations are rejected", () => {
  rejects((value) => {
    value.phases[2]!.service.serial = value.phases[2]!.before.serial;
  }, /stale or cross-realm/);
});
test("screenshots require newly started and completed original peer work", () => {
  rejects((value) => {
    value.phases[2]!.service.fairness.queue = value.phases[2]!.before.fairness.queue;
  }, /fresh in-bracket native work/);
});
test("green pixels remain required after local closure", () => {
  rejects((value) => {
    value.phases[2]!.pixels.center = [255, 0, 0, 255];
  }, /pixel failure/);
});
test("physical stop cannot be replaced by terminal accounting", () => {
  rejects((value) => {
    value.stop.physicallyStopped = false;
  }, /physical stop or grant/);
});
test("service retirement must return peer-only credit", () => {
  rejects((value) => {
    value.phases[2]!.service.heapBytes++;
  }, /peer-only baseline/);
});
test("consumed backing debt cannot disappear at physical stop", () => {
  rejects((value) => {
    value.stop.snapshot.holders.at(-1)!.shape.length = 0;
  }, /monotonic debt/);
});
test("every owned Worker must physically stop", () => {
  rejects((value) => {
    value.runtimeStop.workers[1]!.stopped = false;
  }, /full physical worker teardown/);
});
test("the earliest terminal peer cuts off new work", () => {
  rejects((value) => {
    value.final.fairness.presents.push({ connection: 22, at: 401 });
  }, /late retired native or completed-blob work/);
});
test("completed blobs are immutable", () => {
  rejects((value) => {
    value.final.fairness.blobs[0]!.end = 400;
  }, /completed blob history rewritten/);
});
function pendingHistory(value: ReturnType<typeof fixture>, change: boolean) {
  value.uncovered.fairness.queue[0]!.settlement.kind = "pending";
  value.uncovered.fairness.queue[0]!.settlement.at = 0;
  value.controlExit.service.fairness.queue[0]!.settlement.kind = "pending";
  value.controlExit.service.fairness.queue[0]!.settlement.at = 0;
  for (const service of services(value).filter((service) => service.serial >= 3))
    service.fairness.queue[0]!.settlement.at = 41;
  if (change) value.final.fairness.queue[0]!.settlement.kind = "pending";
}
test("work already pending at retirement may settle legitimately", () => {
  const value = fixture();
  pendingHistory(value, false);
  expect(validatePayloadPressureResult(value).hardwareQualified).toBe(false);
});
test("its first settled result cannot become pending again", () => {
  rejects((value) => pendingHistory(value, true), /settlement changed after completion/);
});

test("the original victim's terminal observation cuts off native work", () => {
  rejects((value) => {
    value.final.fairness.native["33:getCompilationInfo"]!.count++;
  }, /late retired native calls/);
});
test("a replacement peer presenter is not progress", () => {
  rejects((value) => {
    value.phases[2]!.service.owners[1]!.presenterId++;
  }, /presenter or device replaced/);
});
test("a peer PID change cannot hide behind unchanged pixels", () => {
  rejects((value) => {
    value.phases[2]!.peerPid++;
  }, /peer pid changed/);
});
test("the compiled import prefix cannot be replaced", () => {
  rejects((value) => {
    value.phases[2]!.guest = { ...compiled().terminal, events: [] };
  }, /import event prefix|compiled incarnation changed/);
});
test("a wrong original payload handle fails before native claims", () => {
  rejects((value) => {
    value.guest.events.find(
      (event) => event.name === "payload" && event.phase === "enter",
    )!.payload = { handle: 1, generation: 1 };
  }, /payload import used another handle/);
});
test("early C authority intervals cannot disappear", () => {
  rejects((value) => {
    value.guest.events[0]!.authority = { canaries: [], leaks: [] };
  }, /authority canaries failed/);
});
test("the terminal success handle cannot be changed in C output", () => {
  rejects((value) => {
    value.guest.text = value.guest.text.replace(
      "index=64 token=163 handle=64",
      "index=64 token=163 handle=63",
    );
  }, /reused payload slot/);
});
test("queue completion from work started before the screenshot is insufficient", () => {
  rejects((value) => {
    const phase = value.phases[2]!;
    for (const service of services(value).filter(
      (service) => service.serial >= phase.service.serial,
    )) {
      const work = service.fairness.queue.find(
        (work) => work.start === phase.service.serial * 20 - 3,
      )!;
      work.start = phase.before.at - 1;
    }
  }, /stale in-bracket queue work/);
});
for (const method of methods)
  test(`the same original green peer requires native ${method}`, () => {
    rejects((value) => {
      for (const service of services(value)) delete service.fairness.native[`22:${method}`];
    }, /native rendering coverage missing/);
  });

for (const key of ["peerExit", "final"] as const) {
  const terminalService = (value: ReturnType<typeof fixture>) =>
    key === "final" ? value.final : value.peerExit.service;
  test(`terminal payload compilations cannot restart at ${key}`, () => {
    rejects((value) => {
      const service = terminalService(value);
      service.payloadPressure.compilations.push({
        ...service.payloadPressure.compilations.at(-1)!,
        order: 10000,
        call: 66,
        at: service.at - 2,
        settledAt: service.at - 1,
      });
    }, /late retired payload work/);
  });
  test(`terminal payload allocations cannot restart at ${key}`, () => {
    rejects((value) => {
      const service = terminalService(value);
      service.payloadPressure.allocations.push({
        ...service.payloadPressure.allocations.at(-1)!,
        order: 10000,
        at: service.at - 1,
      });
    }, /late retired payload work/);
  });
  test(`terminal payload publications cannot restart at ${key}`, () => {
    rejects((value) => {
      const service = terminalService(value);
      service.payloadPressure.publications.push({
        ...service.payloadPressure.publications.at(-1)!,
        order: 10000,
        token: 999,
        at: service.at - 1,
        published: false,
      });
    }, /late retired payload work/);
  });
}
test("retired owners and original attempts cannot disappear", () => {
  rejects((value) => {
    value.final.owners = value.final.owners.filter((owner) => owner.id !== 11);
    value.final.attempts = value.final.attempts.filter((attempt) => attempt.owner !== 11);
    value.final.fairness.native["11:draw"]!.count++;
  }, /owner cohort history changed/);
});
test("original open attempt identity cannot be rewritten", () => {
  rejects((value) => {
    value.final.attempts[0]!.connection++;
  }, /open attempt identity changed/);
});
for (const key of ["native", "records"] as const)
  test(`unowned ${key} aggregate is rejected`, () => {
    rejects((value) => {
      Reflect.set(value.final.fairness[key], "0:draw", { count: 1, totalMs: 1, maxMs: 1 });
    }, /unowned native observation/);
  });
for (const key of ["queue", "slices", "presents", "blobs"] as const)
  test(`unowned ${key} entry is rejected`, () => {
    rejects((value) => {
      value.final.fairness[key][0]!.connection = 0;
    }, /unowned native observation/);
  });
test("every queue settlement must use a real discriminant", () => {
  rejects((value) => {
    for (const service of services(value)) {
      const settlement = { kind: service.serial <= 3 ? "pending" : "invented", at: 61 };
      service.fairness.queue.push({ connection: 11, start: 10, settlement });
    }
  }, /invalid native queue settlement/);
});
test("every queue settlement must follow its own native submission", () => {
  rejects((value) => {
    for (const service of services(value)) service.fairness.queue[0]!.settlement.at = 0;
  }, /native queue settlement outside submission interval/);
});
test("new native submissions cannot lie beyond their observing snapshot", () => {
  rejects((value) => {
    value.uncovered.fairness.queue[0]!.start = 21;
  }, /native submission after snapshot/);
});
test("settlements cannot lie beyond their observing snapshot", () => {
  rejects((value) => {
    value.uncovered.fairness.queue[0]!.settlement.at = 21;
  }, /native queue settlement outside submission interval/);
});
test("new payload events cannot predate their first observation interval", () => {
  rejects((value) => {
    for (const service of services(value)) {
      const payload = service.payloadPressure;
      if (!payload.compilations.length) continue;
      payload.compilations[0]!.at = 0;
      payload.compilations[0]!.settledAt = 0;
      payload.allocations[0]!.at = 0;
      payload.publications[0]!.at = 0;
    }
  }, /payload event outside observation interval/);
});
test("new payload events cannot follow their observing snapshot", () => {
  rejects((value) => {
    value.committed.payloadPressure.compilations[0]!.at = 161;
  }, /payload event outside observation interval/);
});
test("publication clocks must follow allocation clocks", () => {
  rejects((value) => {
    for (const service of services(value)) {
      const event = service.payloadPressure.publications[0];
      if (event) event.at = 145.001;
    }
  }, /payload event clock order changed/);
});
test("native settlement clocks must follow the original call", () => {
  rejects((value) => {
    for (const service of services(value)) {
      const event = service.payloadPressure.compilations[0];
      if (event) event.settledAt = event.at - 1;
    }
  }, /payload settlement outside call interval/);
});

test("an observed pending compilation may settle in its actual later interval", () => {
  const value = fixture();
  const pending = { ...value.committed.payloadPressure.compilations[0]!, at: 139 };
  Reflect.set(pending, "settled", "pending");
  Reflect.set(pending, "settledAt", null);
  value.firstReady.payloadPressure.compilations.push(pending);
  for (const service of services(value).filter((service) => service.serial > 7))
    service.payloadPressure.compilations[0]!.at = 139;
  expect(validatePayloadPressureResult(value).hardwareQualified).toBe(false);
});
test("a pending compilation cannot settle before the last pending observation", () => {
  rejects((value) => {
    const pending = { ...value.committed.payloadPressure.compilations[0]!, at: 139 };
    Reflect.set(pending, "settled", "pending");
    Reflect.set(pending, "settledAt", null);
    value.firstReady.payloadPressure.compilations.push(pending);
    for (const service of services(value).filter((service) => service.serial > 7)) {
      service.payloadPressure.compilations[0]!.at = 139;
      service.payloadPressure.compilations[0]!.settledAt = 139.5;
    }
  }, /settlement predates pending capture/);
});
test("repeated original terminal notifications remain allowed", () => {
  const value = fixture();
  value.final.payloadPressure.terminations.push({
    ...value.final.payloadPressure.terminations[0]!,
    order: 10000,
    at: 419,
    terminalBefore: 3,
  });
  expect(validatePayloadPressureResult(value).hardwareQualified).toBe(false);
});

test("the original reply tail cannot regress after its admitted C drain", () => {
  rejects((value) => {
    const reply = value.final.owners[2]!.replies;
    reply.tail = value.terminal.owners[2]!.replies.tail;
    reply.used = reply.head - reply.tail;
  }, /Late work published to retired victim rings/);
});

function beforeConnectionSettlement() {
  const value = fixture();
  for (const service of services(value)) service.serial *= 2;
  value.refusal = structuredClone(value.terminal);
  value.refusal.serial--;
  value.refusal.at--;
  value.refusal.responseId = "original-refusal-before-service-turn";
  value.refusal.attempts[2]!.status = 1;
  value.refusal.attempts[2]!.reason = 0;
  return value;
}
test("raw native refusal precedes connection settlement without erasing either record", () => {
  const value = beforeConnectionSettlement();
  expect(value.refusal.attempts[2]).toMatchObject({ status: 1, reason: 0, arenaTerminal: 3 });
  expect(value.terminal.attempts[2]).toMatchObject({ status: -48, reason: 3, arenaTerminal: 3 });
  expect(validatePayloadPressureResult(value).hardwareQualified).toBe(false);
  expect(value.refusal.attempts[2]!.reason).toBe(0);
});
test("a refusal already settled on arrival needs no second invented checkpoint", () => {
  const value = fixture();
  expect(value.refusal).toBe(value.terminal);
  expect(validatePayloadPressureResult(value).hardwareQualified).toBe(false);
});
test("historical results cannot acquire a missing raw refusal by fallback", () => {
  const value = fixture();
  Reflect.deleteProperty(value, "refusal");
  expect(() => validatePayloadPressureResult(value)).toThrow(/Expected qualification record/);
});
for (const [status, reason] of [
  [1, 3],
  [-64, 3],
  [-48, 0],
])
  test(`raw refusal rejects an unproved publication pair ${status}/${reason}`, () => {
    const value = beforeConnectionSettlement();
    Object.assign(value.refusal.attempts[2]!, { status, reason });
    expect(() => validatePayloadPressureResult(value)).toThrow(
      /original refusal control publication differs/,
    );
  });
test("the settled terminal checkpoint still requires exact original mirrors", () => {
  const value = beforeConnectionSettlement();
  Object.assign(value.terminal.attempts[2]!, { status: 1, reason: 0 });
  expect(() => validatePayloadPressureResult(value)).toThrow(
    /original control\/ring\/arena reason differs/,
  );
});
test("an intermediate native refusal cannot permit later command publication", () => {
  const value = beforeConnectionSettlement();
  for (const service of services(value).filter(
    (service) => service.serial >= value.terminal.serial,
  )) {
    service.owners[2]!.commands.head += 8;
    service.owners[2]!.commands.tail += 8;
  }
  expect(() => validatePayloadPressureResult(value)).toThrow(
    /Late work published to retired victim rings/,
  );
});
test("a copied checkpoint cannot change its raw refusal under the same serial", () => {
  const value = fixture();
  value.refusal = structuredClone(value.terminal);
  value.refusal.attempts[2]!.status = 1;
  value.refusal.attempts[2]!.reason = 0;
  expect(() => validatePayloadPressureResult(value)).toThrow(
    /same refusal\/settlement checkpoint changed/,
  );
});

function beforeResourceRetirement() {
  const value = beforeConnectionSettlement();
  Object.assign(value.refusal.owners[2]!, {
    devices: 1,
    destroyed: 0,
    readerDisposed: false,
  });
  return value;
}
test("raw refusal may precede queued device and reader cleanup", () => {
  const value = beforeResourceRetirement();
  expect(value.refusal.owners[2]).toMatchObject({
    state: "terminal",
    terminalReason: 3,
    devices: 1,
    destroyed: 0,
    readerDisposed: false,
    retiredAck: false,
  });
  expect(value.terminal.owners[2]).toMatchObject({
    devices: 0,
    destroyed: 1,
    readerDisposed: true,
    retiredAck: false,
  });
  expect(validatePayloadPressureResult(value).hardwareQualified).toBe(false);
});
for (const [name, capture] of [
  ["before cleanup", beforeResourceRetirement],
  ["after cleanup", beforeConnectionSettlement],
] as const) {
  for (const key of [
    "readerReads",
    "ringReads",
    "logicalBytes",
    "protocolReads",
    "protocolReplays",
    "peakHeap",
    "destroyed",
  ] as const)
    test(`refusal ${name} still cuts off late ${key}`, () => {
      const value = capture();
      value.terminal.owners[2]![key]++;
      expect(() => validatePayloadPressureResult(value)).toThrow(
        /late retired owner work|connection resources did not retire locally/,
      );
    });
  for (const [key, replacement] of [
    ["devices", 1],
    ["destroyed", 0],
    ["readerDisposed", false],
  ] as const)
    test(`refusal ${name} cannot leave ${key} unretired at settlement`, () => {
      const value = capture();
      Reflect.set(value.terminal.owners[2]!, key, replacement);
      expect(() => validatePayloadPressureResult(value)).toThrow(
        /late retired owner work|connection resources did not retire locally/,
      );
    });
  test(`refusal ${name} cannot permit native work during cleanup`, () => {
    const value = capture();
    value.terminal.fairness.native["33:getCompilationInfo"]!.count++;
    expect(() => validatePayloadPressureResult(value)).toThrow(/late retired native calls/);
  });
  test(`refusal ${name} cannot permit reply publication during cleanup`, () => {
    const value = capture();
    value.terminal.owners[2]!.replies.head += 8;
    value.terminal.owners[2]!.replies.used += 8;
    expect(() => validatePayloadPressureResult(value)).toThrow(
      /Late work published to retired victim rings|late retired reply publication/,
    );
  });
}
for (const [key, replacement] of [
  ["devices", 0],
  ["destroyed", 1],
  ["readerDisposed", true],
  ["retiredAck", true],
] as const)
  test(`selected refusal cannot claim inconsistent cleanup ${key}`, () => {
    const value = beforeResourceRetirement();
    Reflect.set(value.refusal.owners[2]!, key, replacement);
    value.refusal.attempts[2]!.retiredAck = value.refusal.owners[2]!.retiredAck;
    expect(() => validatePayloadPressureResult(value)).toThrow(
      /connection resources did not retire locally/,
    );
  });
