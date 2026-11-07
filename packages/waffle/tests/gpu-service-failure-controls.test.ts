import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateServiceFailureResult } from "./gpu-service-failure-browser.js";

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
  const workerStops = [{ id: 2, url: oldWorkers[1]!.url, at: 201 }];
  const failedWorkers = oldWorkers
    .map((worker) => ({ ...worker, stopped: worker.id === 2 }))
    .concat(
      [peerGuest, victimGuest, openingGuest].map((item, index) => ({
        ...item,
        id: index + 3,
        url: "/gpu-guest.js",
        stopped: true,
        createdAt: 3,
      })),
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
  const ended = { ...recoveryService, owners: [{ ...native(5, true), id: 1, device: 1 }] };
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
    workers: failedWorkers.concat([
      { id: 6, url: oldWorkers[1]!.url, stopped: false, createdAt: 210 },
    ]),
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
      pixels: green,
    })),
    pending: service(110),
    lostPixels: green,
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
        workers: oldWorkers.concat(
          [controlGuest, peerGuest, victimGuest, openingGuest].map((item, index) => ({
            ...item,
            id: index + 3,
            url: "/gpu-guest.js",
            stopped: index === 0,
            createdAt: 3,
          })),
        ),
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
      after: structuredClone(state),
      audit: armed,
      exits: [peerGuest, blockedGuest, openingGuest].map((item, index) => ({
        pid: item.pid,
        guest: {
          ...item,
          events: item.events.concat([
            {
              ...item.events.at(-1)!,
              name: index === 2 ? "open" : "completions",
              phase: "return",
              result: -64,
            },
          ]),
        },
        exit: { kind: "exited", code: 1, status: 1 },
        ownAuthority: [audit],
        physicallyStopped: true,
        grantRetired: true,
        text: `GPU_FAIL stage=${index === 2 ? "open" : "completions"} status=-64\n`,
      })),
    },
    recovery: {
      guest: recoveryGuest,
      before: recoveryBefore,
      service: recoveryService,
      pixels: green,
      state: recovered,
      after: {
        ...recovered,
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
