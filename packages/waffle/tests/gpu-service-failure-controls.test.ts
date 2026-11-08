import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateServiceFailureResult } from "./gpu-service-failure-browser.js";
import { RecordRing } from "../browser/gpu/ring.js";

const audit = { canaries: Array.from({ length: 33 }, () => "native-canary"), leaks: [] };
const green = { corner: [0, 0, 0, 255], center: [0, 255, 0, 255] };
function compiled(id: number) {
  const token = `guest-${id}`;
  return {
    token,
    surface: id,
    pid: id + 1,
    text: `GPU_STAGE surface id=${id} width=64\nGPU_FRAME\n`,
    events: ["open", "append", "completions"].flatMap((name, index) =>
      ["enter", "return"].map((phase) => ({
        token,
        name,
        phase,
        call: index + 1,
        connection: 1,
        result: 0,
        authority: audit,
      })),
    ),
  };
}
function ring(terminal = 0) {
  return { head: 24, tail: 24, terminal, writer: 0, used: 0 };
}
function native(id: number, done = id === 1) {
  return {
    surface: id,
    grant: id,
    device: id,
    id,
    state: done ? "terminal" : "ready",
    created: 1,
    destroyed: done ? 1 : 0,
    devices: done ? 0 : 1,
    terminalReason: done ? 1 : 0,
    retiredAck: done,
    readerDisposed: done,
    commands: ring(done ? 1 : 0),
    replies: ring(done ? 1 : 0),
    presenter: !done,
    presenterId: done ? 0 : id,
    presenterDevice: done ? 0 : id,
    frame: id === 3 && !done,
    pending: id === 3 && !done ? 1 : 0,
    readerReads: 10,
    ringReads: 10,
    logicalBytes: 0,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: 66294,
    partial: false,
    replayBusy: false,
    payloadBytes: 0,
  };
}
function service(at: number) {
  const ids = at < 10 ? [1] : at < 50 ? [1, 2] : [1, 2, 3];
  const points = [10, 30, 50, 70, 90].filter((time) => time <= at);
  const aggregate = { maxMs: 1, totalMs: 1, count: 1 };
  const calls: Record<string, typeof aggregate> = { "2:draw": aggregate };
  return {
    at,
    serial: at,
    responseId: `old-${at}`,
    realm: "old-realm",
    mode: "disposal",
    token: "case",
    armed: at > 60,
    nativeHeld: at > 60,
    held: at > 60,
    nativeReleased: false,
    heldCompletion: at > 60 ? { owner: 3, token: 5 } : undefined,
    scopeResult:
      at > 60 ? { owner: 3, device: 3, kind: "none", at: 61, releasedAt: null } : undefined,
    pendingOpen: at === 110 ? { grant: 4, surface: 4, connection: 1 } : null,
    owners: ids.map((id) => native(id)),
    attempts: ids.map((id) => ({ surface: id, grant: id, owner: id })),
    lifecycle: ["configure", "release", "retired"].map((kind, index) => ({
      kind,
      owner: 1,
      grant: 1,
      surface: 1,
      device: 1,
      presenter: kind === "retired" ? 0 : 1,
      at: index + 1,
    })),
    fairness: {
      overflow: false,
      records: { "2:draw": aggregate },
      native: calls,
      presents: points.map((point) => ({ at: point + 2, connection: 2 })),
      slices: points.map((point) => ({ start: point, end: point + 1, connection: 2 })),
      queue: points.map((point) => ({
        start: point,
        connection: 2,
        settlement: { kind: "completed", at: point + 1 },
      })),
      blobs:
        at > 60
          ? [
              {
                start: 51,
                end: 60,
                connection: 3,
                bytes: 4800184,
                commandRingBytes: 4194304,
                draws: 200000,
              },
            ]
          : [],
    },
  };
}
function ledger(live: number, debt: number) {
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: live + debt }, (_, index) => ({
      label: "guest-control",
      state: index < live ? "live" : "debt",
      shape: { length: index < live ? 67108864 : 5505220 },
    })),
  };
}
function fixture() {
  const controlGuest = compiled(1),
    peerGuest = compiled(2),
    victimGuest = compiled(3);
  const blockedGuest = {
    ...victimGuest,
    events: victimGuest.events.concat(
      ["enter", "wait"].map((phase) => ({
        token: victimGuest.token,
        name: "completions",
        phase,
        call: 4,
        connection: 1,
        result: 0,
        authority: audit,
      })),
    ),
  };
  const openingGuest = {
    ...compiled(4),
    events: [
      {
        token: "guest-4",
        name: "open",
        phase: "enter",
        call: 1,
        connection: 0,
        result: 0,
        authority: audit,
      },
    ],
  };
  const controls = [1, 2, 3, 4].map((grant) => ({
    grant,
    connection: 1,
    status: -64,
    reason: grant === 1 ? 1 : 5,
    arenaTerminal: grant === 1 ? 1 : 5,
    commands: ring(grant === 1 ? 1 : 5),
    replies: ring(grant === 1 ? 1 : 5),
  }));
  const oldWorkers = [
    { id: 1, url: "/fs-worker.js", stopped: false, createdAt: 1 },
    { id: 2, url: "/gpu/service-worker.ts/ownership", stopped: false, createdAt: 2 },
  ];
  const originalWorkers = oldWorkers.concat(
    [controlGuest, peerGuest, victimGuest, openingGuest].map((item, index) => ({
      ...item,
      id: index + 3,
      url: "/gpu-guest.js",
      stopped: index === 0,
      createdAt: 3,
    })),
    [{ id: 7, url: "/gpu-guest.js", stopped: false, createdAt: 3 }],
  );
  const failedWorkers = originalWorkers.map((worker) => ({
    ...worker,
    stopped: worker.stopped || worker.id === 2,
  }));
  const retiredWorkers = failedWorkers.map((worker) => ({
    ...worker,
    stopped: worker.stopped || ("pid" in worker && typeof worker.pid === "number"),
  }));
  const initialStops = [{ id: 3, url: "/gpu-guest.js", at: 5 }];
  const workerStops = initialStops.concat([{ id: 2, url: oldWorkers[1]!.url, at: 201 }]);
  const retiredStops = workerStops.concat(
    [4, 5, 6].map((id) => ({ id, url: "/gpu-guest.js", at: 200 + id })),
  );
  const revocations = [controlGuest, peerGuest, victimGuest, openingGuest].map((item) => ({
    pid: item.pid,
    value: 1,
  }));
  const state = {
    runtimeEpoch: 1,
    disposed: false,
    controls,
    workers: failedWorkers,
    workerStops,
    revocations,
    snapshot: ledger(1, 4),
  };
  const armed = { name: "armed", service: service(60) };
  const recoveryGuest = compiled(5);
  const recoveryBefore = {
    ...service(20),
    realm: "fresh-realm",
    responseId: "fresh-20",
    scopeResult: undefined,
    heldCompletion: undefined,
    owners: [{ ...native(5, false), id: 1, device: 1, presenterId: 1, presenterDevice: 1 }],
    attempts: [{ grant: 5, surface: 5, owner: 1 }],
    fairness: { ...service(20).fairness, presents: [], queue: [] },
  };
  const recoveryService = {
    ...recoveryBefore,
    at: 40,
    serial: 40,
    responseId: "fresh-40",
    fairness: {
      ...recoveryBefore.fairness,
      presents: [{ connection: 1, at: 30 }],
      queue: [{ connection: 1, start: 25, settlement: { kind: "completed", at: 28 } }],
    },
  };
  const ended = {
    ...recoveryService,
    at: 60,
    serial: 60,
    responseId: "fresh-60",
    fairness: structuredClone(recoveryService.fairness),
    owners: [{ ...native(5, true), id: 1, device: 1 }],
  };
  const recovered = {
    ...state,
    controls: controls.concat([
      {
        ...controls[0]!,
        grant: 5,
        status: 1,
        reason: 0,
        arenaTerminal: 0,
        commands: ring(),
        replies: ring(),
      },
    ]),
    workers: structuredClone(retiredWorkers)
      .map((worker) => (worker.id === 7 ? { ...worker, ...recoveryGuest } : worker))
      .concat([{ id: 8, url: oldWorkers[1]!.url, stopped: false, createdAt: 210 }]),
    workerStops: retiredStops,
    audit: structuredClone(armed),
    snapshot: ledger(2, 4),
  };
  return {
    kind: "whole-service-failure",
    token: "case",
    controlGuest,
    peerGuest,
    victimGuest,
    blockedGuest,
    openingGuest,
    controlExit: {
      ownAuthority: [audit],
      exit: { kind: "exited", code: 0 },
      physicallyStopped: true,
      grantRetired: true,
      service: service(5),
    },
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
    auditControl: armed,
    phases: [
      [20, 40],
      [80, 100],
    ].map(([before, after], index) => ({
      name: index ? "held" : "live",
      peerPid: peerGuest.pid,
      before: service(before!),
      service: service(after!),
      pixels: structuredClone(green),
    })),
    pending: service(110),
    lostPixels: structuredClone(green),
    failure: {
      id: "fault",
      startedAt: 200,
      fault: {
        trusted: true,
        message: "Uncaught Error: GPU_SERVICE_FAILURE fault",
        at: 202,
        worker: 2,
      },
      before: {
        ...state,
        workers: originalWorkers,
        workerStops: initialStops,
        controls: controls.map((item) =>
          item.grant === 1
            ? item
            : {
                ...item,
                status: item.grant === 4 ? 0 : 1,
                reason: 0,
                arenaTerminal: 0,
                commands: ring(),
                replies: ring(),
              },
        ),
      },
      stopped: state,
      after: { ...structuredClone(state), workers: retiredWorkers, workerStops: retiredStops },
      audit: armed,
      exits: [peerGuest, blockedGuest, openingGuest].map((item, index) => ({
        pid: item.pid,
        guest: {
          ...item,
          events: item.events.concat(
            index === 0 ? [{ ...item.events.at(-1)!, phase: "enter", call: 4, result: 0 }] : [],
            [
              {
                ...item.events.at(-1)!,
                call: index === 0 ? 4 : item.events.at(-1)!.call,
                name: index === 2 ? "open" : "completions",
                phase: "return",
                result: -64,
              },
            ],
          ),
        },
        exit: { kind: "exited", code: 1, status: 1 },
        ownAuthority: [audit],
        physicallyStopped: true,
        grantRetired: true,
        text: `${item.text}GPU_FAIL stage=${index === 2 ? "open" : "completions"} status=-64\n`,
      })),
    },
    recovery: {
      guest: recoveryGuest,
      before: recoveryBefore,
      service: recoveryService,
      pixels: structuredClone(green),
      state: recovered,
      after: {
        ...recovered,
        workers: recovered.workers.map((worker) => ({
          ...worker,
          stopped: worker.stopped || worker.id === 7,
        })),
        workerStops: retiredStops.concat([{ id: 7, url: "/gpu-guest.js", at: 260 }]),
        audit: structuredClone(armed),
        controls: controls.concat([{ ...controls[0]!, grant: 5 }]),
        snapshot: ledger(1, 5),
      },
      exit: {
        pid: recoveryGuest.pid,
        ownAuthority: [audit],
        grantRetired: true,
        physicallyStopped: true,
        exit: { kind: "exited", code: 0 },
        service: ended,
      },
    },
  };
}

test("a globally failed service stops original owners and recovers serially in the same runtime", () => {
  expect(validateServiceFailureResult(fixture()).hardwareQualified).toBe(false);
});

const invalid: [string, (value: ReturnType<typeof fixture>) => void, string][] = [
  [
    "missing positive native coverage",
    (x) => {
      x.coverage.native.draw = 0;
    },
    "missing native observer coverage",
  ],
  [
    "fabricated error event",
    (x) => {
      x.failure.fault.trusted = false;
    },
    "not the authentic worker fault",
  ],
  [
    "unrelated worker exception",
    (x) => {
      x.failure.fault.message = "Uncaught Error: unrelated";
    },
    "not the authentic worker fault",
  ],
  [
    "wrong worker error identity",
    (x) => {
      x.failure.fault.worker = 99;
    },
    "wrong failed service worker",
  ],
  [
    "missing native hold",
    (x) => {
      x.phases[1]!.before.nativeHeld = false;
    },
    "missing active held native resources",
  ],
  [
    "changed first held token",
    (x) => {
      x.phases[1]!.service.heldCompletion!.token++;
      x.pending.heldCompletion!.token++;
    },
    "first held completion identity changed",
  ],
  [
    "stale snapshot",
    (x) => {
      x.pending.serial = 1;
    },
    "uncorrelated service observation",
  ],
  [
    "reused response identity",
    (x) => {
      x.pending.responseId = x.phases[1]!.service.responseId;
    },
    "uncorrelated service observation",
  ],
  [
    "original peer replaced",
    (x) => {
      x.phases[1]!.peerPid++;
    },
    "original green peer replaced",
  ],
  [
    "wrong original pixels",
    (x) => {
      x.phases[0]!.pixels.center = [255, 0, 0, 255];
    },
    "Compiled guest pixel failure",
  ],
  [
    "completed blob history dropped",
    (x) => {
      x.pending.fairness.blobs = [];
    },
    "blob observation history dropped",
  ],
  [
    "pending late submission",
    (x) => {
      x.pending.fairness.queue.push({
        connection: 1,
        start: 109,
        settlement: { kind: "pending", at: 109 },
      });
    },
    "late retired native work",
  ],
  [
    "rejected late submission",
    (x) => {
      x.pending.fairness.queue.push({
        connection: 1,
        start: 109,
        settlement: { kind: "rejected", at: 110 },
      });
    },
    "late retired native work",
  ],
  [
    "retired native call growth",
    (x) => {
      x.pending.fairness.native["1:draw"] = { count: 1, totalMs: 1, maxMs: 1 };
    },
    "late retired replay or native work",
  ],
  [
    "pending open already settled",
    (x) => {
      x.failure.before.controls[3]!.status = 1;
    },
    "connection or opening waiter already terminal",
  ],
  [
    "missing pending open",
    (x) => {
      x.pending.pendingOpen = null;
    },
    "missing actual opening waiter",
  ],
  [
    "missing stopped worker",
    (x) => {
      x.failure.stopped.workers[1]!.stopped = false;
    },
    "failed service revived or runtime topology stopped",
  ],
  [
    "old reply ring live",
    (x) => {
      x.failure.stopped.controls[2]!.replies.terminal = 0;
    },
    "open waiter or rings not terminal",
  ],
  [
    "pending waiter not terminal",
    (x) => {
      x.failure.stopped.controls[3]!.status = 0;
    },
    "open waiter or rings not terminal",
  ],
  [
    "wrong service terminal reason",
    (x) => {
      x.failure.stopped.controls[2]!.reason = 4;
    },
    "open waiter or rings not terminal",
  ],
  [
    "changed late publication",
    (x) => {
      x.failure.after.controls[2]!.commands.head++;
    },
    "late old publication changed",
  ],
  [
    "missing grant revoke",
    (x) => {
      x.failure.after.revocations[2]!.value = 0;
    },
    "original grant revocation missing",
  ],
  [
    "unrelated import exception",
    (x) => {
      x.failure.exits[1]!.guest.events.at(-1)!.phase = "throw";
    },
    "uncorrelated terminal import outcome",
  ],
  [
    "wrong held import correlation",
    (x) => {
      x.failure.exits[1]!.guest.events.at(-1)!.call++;
    },
    "held import completion identity changed",
  ],
  [
    "unrelated peer import",
    (x) => {
      x.failure.exits[0]!.guest.events.at(-1)!.name = "open";
    },
    "unrelated terminal import",
  ],
  [
    "wrong C failure",
    (x) => {
      x.failure.exits[2]!.text = "GPU_FAIL stage=device status=-64\n";
    },
    "wrong compiled failure stage",
  ],
  [
    "service realm revived",
    (x) => {
      x.recovery.service.realm = "old-realm";
    },
    "old service identity revived",
  ],
  [
    "replacement mislabeled as original",
    (x) => {
      x.recovery.guest.pid = x.peerGuest.pid;
    },
    "recovery relabeled an original guest",
  ],
  [
    "new runtime",
    (x) => {
      x.recovery.after.runtimeEpoch++;
    },
    "sole page runtime replaced or disposed",
  ],
  [
    "overlapping GPU workers",
    (x) => {
      x.recovery.state.workers.at(-1)!.createdAt = 200;
    },
    "concurrent service topology or old worker revived",
  ],
  [
    "wrong recovery pixels",
    (x) => {
      x.recovery.pixels.center = [255, 0, 0, 255];
    },
    "Compiled guest pixel failure",
  ],
  [
    "stale recovery queue work",
    (x) => {
      x.recovery.service.fairness.queue[0]!.start = 19;
    },
    "missing recovery native queue completion",
  ],
  [
    "no recovery presentation",
    (x) => {
      x.recovery.service.fairness.presents = [];
    },
    "missing recovery native present",
  ],
  [
    "erased conservative debt",
    (x) => {
      x.failure.after.snapshot.holders.pop();
    },
    "shared-control",
  ],
];
invalid.push(
  [
    "substituted held native identity",
    (x) => {
      const owner = x.phases[1]!.before.owners.find((item) => item.id === 3)!;
      owner.grant = 999;
      owner.surface = 999;
      owner.presenterId = 999;
      owner.presenterDevice = 999;
    },
    "held victim native identity changed",
  ],
  [
    "substituted pending native identity",
    (x) => {
      x.pending.owners[2]!.grant = 999;
      x.pending.owners[2]!.surface = 999;
    },
    "held victim native identity changed",
  ],
  [
    "another pending open call",
    (x) => {
      const events = x.failure.exits[2]!.guest.events;
      events.at(-1)!.call = 999;
      events.splice(events.length - 1, 0, { ...events.at(-1)!, phase: "enter", result: 0 });
    },
    "pending open completion identity changed",
  ],
  [
    "different pending terminal connection",
    (x) => {
      x.failure.exits[2]!.guest.events.at(-1)!.connection = 999;
    },
    "uncorrelated terminal import outcome",
  ],
  [
    "lost ready history before hold",
    (x) => {
      x.blockedGuest.events.shift();
      x.failure.exits[1]!.guest.events.shift();
    },
    "guest import history rewritten",
  ],
  [
    "lost original C output",
    (x) => {
      x.failure.exits[1]!.text = "GPU_FAIL stage=completions status=-64\n";
    },
    "guest output history rewritten",
  ],
  [
    "dead realm on recovery retirement",
    (x) => {
      x.recovery.exit.service.realm = "old-realm";
    },
    "recovery terminal service identity changed",
  ],
  [
    "changed recovery terminal token",
    (value) => {
      value.recovery.exit.service.token = "other";
    },
    "recovery terminal service identity changed",
  ],
  [
    "changed recovery terminal device",
    (x) => {
      x.recovery.exit.service.owners[0]!.device = 999;
    },
    "recovery terminal native identity changed",
  ],
  [
    "lost recovery terminal queue history",
    (x) => {
      x.recovery.exit.service.fairness.queue = [];
    },
    "queue observation history dropped",
  ],
  [
    "lost recovery terminal presents",
    (x) => {
      x.recovery.exit.service.fairness.presents = [];
    },
    "native observation history rewritten",
  ],
  [
    "revived original guest through recovery",
    (x) => {
      for (const state of [x.recovery.state, x.recovery.after])
        state.workers.find((worker) => worker.id === 5)!.stopped = false;
    },
    "original physical worker revived",
  ],
  [
    "erased original stop history",
    (x) => {
      x.recovery.state.workerStops = [];
      x.recovery.after.workerStops = [];
    },
    "worker stop history rewritten",
  ],
  [
    "rewritten original constructor time",
    (x) => {
      x.recovery.state.workers[2]!.createdAt++;
    },
    "original physical worker identity changed",
  ],
  [
    "missing old audit during recovery",
    (x) => {
      Reflect.deleteProperty(x.recovery.state, "audit");
    },
    "terminated service audit missing through recovery",
  ],
  [
    "rewritten old audit after recovery",
    (x) => {
      x.recovery.after.audit.service.serial++;
    },
    "terminated service audit rewritten through recovery",
  ],
);
for (const key of ["grant", "surface", "device", "presenterId", "presenterDevice"]) {
  invalid.push([
    `changed first held ${key}`,
    (value) => {
      Reflect.set(value.phases[1]!.before.owners[2]!, key, 999);
    },
    "held victim native identity changed",
  ]);
  invalid.push([
    `changed pending held ${key}`,
    (value) => {
      Reflect.set(value.pending.owners[2]!, key, 999);
    },
    "held victim native identity changed",
  ]);
}
for (const [name, change, reason] of invalid) {
  test(`service failure controls reject ${name} for its intended reason`, () => {
    const value = structuredClone(fixture());
    change(value);
    expect(() => validateServiceFailureResult(value)).toThrow(reason);
  });
}

test("an already pending retired submission may legitimately settle later", () => {
  const value = fixture(),
    control = value.controlExit.service;
  control.fairness.queue.unshift({
    connection: 1,
    start: 1,
    settlement: { kind: "pending", at: 1 },
  });
  const later = value.phases
    .flatMap((phase) => [phase.before, phase.service])
    .concat([value.auditControl.service, value.pending]);
  for (const observation of later)
    observation.fairness.queue.unshift({
      connection: 1,
      start: 1,
      settlement: { kind: "completed", at: 6 },
    });
  value.recovery.state.audit = structuredClone(value.auditControl);
  value.recovery.after.audit = structuredClone(value.auditControl);
  expect(validateServiceFailureResult(value).hardwareQualified).toBe(false);
});

test("the real Worker throw is outside the observer catch and the ordinary compiled gate discovers this proof", () => {
  const worker = readFileSync(
    new URL("./fixtures/gpu/ownership-service-worker.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(new URL("./fixtures/gpu/integration-page.ts", import.meta.url), "utf8");
  const runner = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  const handler = worker.slice(worker.indexOf("host.onmessage ="));
  expect(handler.indexOf("throw new Error(`GPU_SERVICE_FAILURE")).toBeLessThan(
    handler.indexOf("command(data)"),
  );
  expect(handler.slice(0, handler.indexOf("throw new Error(`GPU_SERVICE_FAILURE"))).not.toContain(
    "try {",
  );
  expect(page).toContain("trusted: event.isTrusted");
  expect(page).toContain('entry.worker.postMessage({ test: "service-failure", id })');
  expect(page).not.toContain("dispatchEvent(");
  expect(page).not.toContain(".onerror(");
  expect(runner).toContain("await serviceFailureCases(page, url, available)");
  expect(runner.indexOf("await serviceFailureCases")).toBeLessThan(
    runner.indexOf("if (serviceFailureOnly)"),
  );
});

test("the original peer may first observe global closure in its next append", () => {
  const value = fixture(),
    peer = value.failure.exits[0]!;
  const events = peer.guest.events;
  events.at(-2)!.name = "append";
  events.at(-1)!.name = "append";
  peer.text = `${value.peerGuest.text}GPU_FAIL stage=append status=-64\n`;
  expect(validateServiceFailureResult(value).hardwareQualified).toBe(false);
});

test("recovery pixel negatives do not mutate the original peer's observations", () => {
  const value = fixture();
  value.recovery.pixels.center = [255, 0, 0, 255];
  expect(
    value.phases.every((phase) => JSON.stringify(phase.pixels) === JSON.stringify(green)),
  ).toBe(true);
  expect(() => validateServiceFailureResult(value)).toThrow("Compiled guest pixel failure");
});

function committedReplyDrain() {
  const value = fixture();
  for (const state of [
    value.failure.before,
    value.failure.stopped,
    value.failure.after,
    value.recovery.state,
    value.recovery.after,
  ]) {
    state.controls = state.controls.map((control) =>
      control.grant !== 2
        ? control
        : {
            ...control,
            replies: {
              ...control.replies,
              head: 48,
              tail: state === value.failure.before || state === value.failure.stopped ? 24 : 48,
            },
          },
    );
  }
  return value;
}

test("an original guest may drain committed replies between service stop and physical exit", () => {
  expect(validateServiceFailureResult(committedReplyDrain()).hardwareQualified).toBe(false);
});

test("an unchanged unread tail remains allowed if the original guest fails before reading it", () => {
  const value = committedReplyDrain();
  for (const state of [value.failure.after, value.recovery.state, value.recovery.after])
    state.controls[1]!.replies.tail = 24;
  expect(validateServiceFailureResult(value).hardwareQualified).toBe(false);
});

for (const [field, next, message] of [
  ["tail", 16, "old reply consumer escaped committed bytes"],
  ["tail", 56, "old reply consumer escaped committed bytes"],
  ["tail", 25, "old reply consumer escaped committed bytes"],
  ["tail", 1.5, "old reply consumer escaped committed bytes"],
  ["head", 56, "late old publication changed"],
  ["terminal", 0, "late old publication changed"],
] satisfies [string, number, string][])
  test(`old reply ${field} cannot become ${next} during failure`, () => {
    const value = committedReplyDrain();
    Reflect.set(value.failure.after.controls[1]!.replies, field, next);
    expect(() => validateServiceFailureResult(value)).toThrow(message);
  });

test("command consumption cannot change after the service worker stops", () => {
  const value = committedReplyDrain();
  value.failure.after.controls[1]!.commands.tail = 16;
  expect(() => validateServiceFailureResult(value)).toThrow("late old publication changed");
});

test("old reply consumption is frozen once the original guest workers have stopped", () => {
  const value = committedReplyDrain();
  value.recovery.state.controls[1]!.replies.tail = 24;
  expect(() => validateServiceFailureResult(value)).toThrow(
    "old publication revived through recovery",
  );
});

test("committed reply consumption accepts the real observer's signed rollover tail", () => {
  const backing = new SharedArrayBuffer(128),
    cells = new Int32Array(backing),
    publication = new BigInt64Array(backing, 0, 1);
  Atomics.store(publication, 0, 0xfffffff0n);
  Atomics.store(cells, 2, -16);
  const ring = new RecordRing(backing, 16),
    acquired = ring.tryAcquireWriter();
  expect(acquired.kind).toBe("acquired");
  if (acquired.kind !== "acquired") throw new Error("Missing actual ring writer");
  const bytes = new Uint8Array(24),
    view = new DataView(bytes.buffer);
  view.setUint16(0, 1, true);
  view.setUint32(4, 24, true);
  expect(acquired.writer.tryWrite(bytes).kind).toBe("written");
  acquired.writer.release();
  ring.terminate(5);
  const observed = () => ({
    head: Number(Atomics.load(publication, 0) & 0xffffffffn),
    tail: Atomics.load(cells, 2),
    terminal: Number((Atomics.load(publication, 0) >> 32n) & 0xffffffffn),
  });
  const before = observed();
  expect(before).toEqual({ head: 24, tail: -16, terminal: 5 });
  expect(ring.readInto(new Uint8Array(24)).kind).toBe("record");
  const after = observed();
  expect(after).toEqual({ head: 24, tail: 24, terminal: 5 });
  expect(ring.readInto(new Uint8Array(24)).kind).toBe("terminal");
  const value = committedReplyDrain();
  for (const state of [
    value.failure.before,
    value.failure.stopped,
    value.failure.after,
    value.recovery.state,
    value.recovery.after,
  ])
    Object.assign(
      state.controls[1]!.replies,
      state === value.failure.before || state === value.failure.stopped
        ? { head: before.head, tail: before.tail }
        : { head: after.head, tail: after.tail },
    );
  expect(validateServiceFailureResult(value).hardwareQualified).toBe(false);
});

test("an original peer already physically stopped cannot drain committed replies", () => {
  const value = committedReplyDrain(),
    peer = value.peerGuest,
    worker = value.failure.stopped.workers.find(
      (worker) =>
        "pid" in worker &&
        worker.pid === peer.pid &&
        "token" in worker &&
        worker.token === peer.token &&
        "surface" in worker &&
        worker.surface === peer.surface,
    )!;
  worker.stopped = true;
  const stop = value.failure.after.workerStops.find((stop) => stop.id === worker.id)!;
  value.failure.stopped.workerStops = value.failure.stopped.workerStops.concat([stop]);
  expect(() => validateServiceFailureResult(value)).toThrow(
    "physically stopped guest changed old controls",
  );
});

for (const tail of [-0x80000001, 0x80000000, -15, -16.5])
  test(`observed signed tail ${tail} is rejected before normalization`, () => {
    const value = committedReplyDrain();
    value.failure.after.controls[1]!.replies.tail = tail;
    expect(() => validateServiceFailureResult(value)).toThrow(
      "old reply consumer escaped committed bytes",
    );
  });
