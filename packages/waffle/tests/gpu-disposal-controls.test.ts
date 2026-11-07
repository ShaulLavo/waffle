import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateDisposalResult } from "./gpu-disposal-browser.js";

function compiled(id: number) {
  const token = `compiled-${id}`;
  const events = ["open", "append", "completions"].flatMap((name, at) =>
    ["enter", "return"].map((phase) => ({
      token,
      name,
      call: at + 1,
      phase,
      connection: 1,
      result: 0,
      authority: { canaries: Array.from({ length: 33 }, () => "observed"), leaks: [] },
    })),
  );
  return {
    pid: id + 1,
    surface: id,
    token,
    events,
    text: `GPU_STAGE surface id=${id} width=64\nGPU_FRAME\n`,
  };
}
function observedRing(terminal = 0) {
  return { terminal, head: 100, tail: 100, used: 0, writer: 0, capacity: 4194304 };
}
function observedOwner(id: number, at: number) {
  const done = id === 1 || at >= 120,
    terminal = done ? (id === 1 ? 1 : 4) : 0;
  return {
    id,
    grant: id,
    surface: id,
    device: id,
    created: 1,
    destroyed: Number(done),
    devices: Number(!done),
    state: done ? "terminal" : "ready",
    terminalReason: terminal,
    presenter: !done,
    presenterId: done ? 0 : id,
    presenterDevice: done ? 0 : id,
    frame: id === 3 && !done,
    pending: id === 3 && !done ? 1 : 0,
    payloadBytes: 0,
    replayBusy: false,
    partial: false,
    retiredAck: done,
    readerDisposed: done,
    readerReads: 10,
    ringReads: 10,
    logicalBytes: 0,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: 66086,
    commands: observedRing(terminal),
    replies: observedRing(terminal),
  };
}
function observedLifecycle(at: number) {
  const specs: [number, string, number][] = [
    [1, "configure", 0],
    [1, "release", 1],
    [1, "retired", 2],
    [2, "configure", 3],
    [3, "configure", 50],
    [2, "release", 108],
    [2, "retired", 109],
    [3, "release", 110],
    [3, "retired", 111],
  ];
  return specs
    .filter(([, , time]) => time <= at)
    .map(([id, kind, time]) => ({
      owner: id,
      grant: id,
      surface: id,
      device: id,
      presenter: kind === "retired" ? 0 : id,
      kind,
      at: time,
    }));
}
function observedService(at: number) {
  const cohort = at < 50 ? [1, 2] : [1, 2, 3];
  const points = [10, 30, 50, 70, 90].filter((time) => time <= at);
  const aggregate = { count: 10, totalMs: 1, maxMs: 0.1 };
  return {
    realm: "original-service",
    responseId: `snapshot-${at}`,
    serial: at,
    at,
    token: "active-case",
    mode: "disposal",
    armed: at >= 80,
    held: at >= 80,
    nativeHeld: at >= 80 && at < 140,
    nativeReleased: at >= 140,
    heldCompletion: at < 80 ? undefined : { owner: 3, token: 4 },
    lateCallback: at < 140 ? undefined : { owner: 3, device: 3, token: 4, kind: "none", at: 131 },
    scopeResult:
      at < 80
        ? undefined
        : { owner: 3, device: 3, kind: "none", at: 61, releasedAt: at < 140 ? null : 130 },
    owners: cohort.map((id) => observedOwner(id, at)),
    attempts: cohort.map((id) => ({ surface: id, grant: id, owner: id })),
    lifecycle: observedLifecycle(at),
    connections: at >= 120 ? 0 : cohort.length - 1,
    devicesLive: at >= 120 ? 0 : cohort.length - 1,
    heapBytes: at >= 120 ? 0 : 66086,
    frameTexturesLive: at >= 50 && at < 120 ? 1 : 0,
    presentCanvasesLive: at >= 120 ? 0 : 1,
    fairness: {
      overflow: false,
      native: { "2:draw": aggregate },
      records: { "2:1": aggregate },
      slices: points.map((time) => ({ connection: 2, start: time, end: time + 1 })),
      presents: points.map((time) => ({ connection: 2, at: time + 2 })),
      queue: points.map((time) => ({
        connection: 2,
        start: time,
        settlement: { kind: "completed", at: time + 1 },
      })),
      blobs:
        at < 80
          ? []
          : [
              {
                connection: 3,
                commandRingBytes: 4194304,
                bytes: 4800184,
                draws: 200000,
                start: 51,
                end: 60,
              },
            ],
    },
  };
}
function stoppedLedger() {
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: 3 }, () => ({
      label: "guest-control",
      state: "debt",
      shape: { kind: "fixed-buffer", length: 5505220 },
    })),
  };
}
function observedControls(terminal: boolean) {
  return [1, 2, 3].map((grant) => {
    const reason = grant === 1 ? 1 : terminal ? 4 : 0;
    return {
      grant,
      connection: 1,
      status: reason ? -64 : 1,
      reason,
      arenaTerminal: reason,
      commands: observedRing(reason),
      replies: observedRing(reason),
    };
  });
}
function fixture() {
  const controlGuest = compiled(1),
    peerGuest = compiled(2),
    victimGuest = compiled(3);
  const blockedGuest = {
    ...victimGuest,
    events: victimGuest.events.concat([
      { ...victimGuest.events[0]!, name: "completions", call: 4, phase: "enter" },
      { ...victimGuest.events[0]!, name: "completions", call: 4, phase: "wait" },
    ]),
  };
  const workersBefore = [
    "/fs-worker.js",
    "/gpu-guest.js",
    "/gpu-guest.js",
    "/gpu/service-worker.ts/ownership",
  ].map((url, index) => ({
    id: index + 1,
    url,
    stopped: false,
    ...(index === 1 || index === 2
      ? { pid: index + 2, token: `compiled-${index + 1}`, surface: index + 1 }
      : {}),
  }));
  const workers = workersBefore.map((worker) => ({ ...worker, stopped: true }));
  const audits = [
    { name: "retired", service: observedService(120) },
    { name: "late", service: observedService(140) },
  ];
  const stopped = {
    disposed: true,
    workers,
    controls: observedControls(true),
    snapshot: stoppedLedger(),
    audits,
  };
  const guests = [controlGuest, peerGuest, blockedGuest];
  const exits = guests.map((compiled, index) => ({
    ...compiled,
    grantRetired: true,
    events:
      index === 2
        ? compiled.events.concat([{ ...compiled.events.at(-1)!, phase: "return", result: -64 }])
        : compiled.events,
    exit: { kind: index ? "signaled" : "exited", code: index ? 9 : 0, status: index ? 137 : 0 },
  }));
  return {
    kind: "active-runtime-disposal",
    token: "active-case",
    peer: 2,
    victim: 3,
    controlGuest,
    peerGuest,
    victimGuest,
    blockedGuest,
    controlExit: { service: observedService(10) },
    auditControl: { name: "armed", service: observedService(60) },
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
    phases: [
      [20, 40],
      [80, 100],
    ].map(([before, after], index) => ({
      name: index ? "held" : "live",
      peerPid: peerGuest.pid,
      before: observedService(before!),
      service: observedService(after!),
      pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
    })),
    disposal: {
      startedAt: 200,
      finishedAt: 210,
      workersBefore,
      memoryBefore: [
        { pid: 3, bytes: 262144 },
        { pid: 4, bytes: 4915200 },
      ],
      controlsBefore: observedControls(false),
      synchronous: {
        disposed: true,
        controls: observedControls(true),
        revocations: guests.map((compiled) => ({ pid: compiled.pid, value: 1 })),
      },
      exits,
      stopped,
      after: structuredClone(stopped),
      workerStops: workers.map((worker) => ({ id: worker.id, url: worker.url, at: 205 })),
      errors: [],
    },
  };
}
function rejects(mutate: (value: ReturnType<typeof fixture>) => void, reason: string) {
  const value = fixture();
  mutate(value);
  expect(() => validateDisposalResult(value)).toThrow(reason);
}
test("active disposal accepts an original compiled cohort and reports software timing only", () => {
  const result = validateDisposalResult(fixture());
  expect(result.hardwareQualified).toBe(false);
  expect(result.targets).toEqual({ sliceMs: 8, peerGapMs: 100 });
});
test("active disposal requires original peer pixels and fresh native brackets", () => {
  rejects((r) => {
    r.phases[1]!.pixels.center = [255, 0, 0, 255];
  }, "Compiled guest pixel failure");
  rejects((r) => {
    r.phases[1]!.service = structuredClone(r.phases[1]!.before);
    r.phases[1]!.service.serial++;
    r.phases[1]!.service.responseId += "-stale";
  }, "missing fresh in-bracket native work");
  rejects((r) => {
    r.phases[1]!.peerPid++;
  }, "original green peer replaced");
});
test("active disposal requires held original native resources and import waiter", () => {
  rejects((r) => {
    r.blockedGuest.events.at(-1)!.phase = "return";
  }, "not held inside actual completions import");
  rejects((r) => {
    r.phases[1]!.service.nativeHeld = false;
  }, "missing active held native resources");
  rejects((r) => {
    r.phases[1]!.service.owners[2]!.pending = 0;
  }, "missing active held native resources");
  rejects((r) => {
    r.disposal.memoryBefore.pop();
  }, "original compiled workers not active at disposal");
  rejects((r) => {
    r.disposal.controlsBefore[2]!.reason = 4;
  }, "original open already stopped before disposal");
});
test("active disposal rejects missing synchronous grant and shared-ring revocation", () => {
  rejects((r) => {
    r.disposal.synchronous.disposed = false;
  }, "runtime disposal error or missing synchronous revocation");
  rejects((r) => {
    r.disposal.synchronous.revocations[2]!.value = 0;
  }, "launch-wide revocation missing");
  rejects((r) => {
    r.disposal.synchronous.controls[2]!.replies.terminal = 0;
  }, "open waiter or ring not terminal");
});
test("active disposal requires all original guests and the held waiter to stop", () => {
  rejects((r) => {
    r.disposal.exits.pop();
  }, "owned guest omitted from shutdown");
  rejects((r) => {
    r.disposal.exits[1]!.exit.kind = "exited";
  }, "wrong original guest exit or launch grant retirement");
  rejects((r) => {
    r.disposal.exits[2]!.grantRetired = false;
  }, "wrong original guest exit or launch grant retirement");
  rejects((r) => {
    r.disposal.exits[2]!.events.pop();
  }, "held import waiter did not return terminal error");
});
test("active disposal proves physical worker stops rather than treating absent replies as zero", () => {
  rejects((r) => {
    r.disposal.workerStops.pop();
  }, "missing physical stop calls");
  rejects((r) => {
    r.disposal.stopped.workers[3]!.stopped = false;
  }, "worker not physically stopped");
  rejects((r) => {
    r.disposal.workerStops[3]!.at = 190;
  }, "active worker stopped outside disposal boundary");
  rejects((r) => {
    r.disposal.after.workers[3]!.stopped = false;
  }, "workers revived after disposal");
  rejects((r) => {
    r.disposal.stopped.audits = [];
    r.disposal.after.audits = [];
  }, "missing actual pre-termination disposal audits");
});
test("active disposal keeps conservative shared-control debt and stable publications", () => {
  rejects((r) => {
    r.disposal.stopped.snapshot.holders[2]!.state = "live";
  }, "Ownership shared-control live accounting changed");
  rejects((r) => {
    r.disposal.stopped.snapshot.holders[2]!.shape.length = 0;
  }, "Ownership shared-control monotonic debt");
  rejects((r) => {
    r.disposal.after.controls[2]!.replies.head++;
  }, "late publication changed terminated shared controls");
});
test("active disposal requires actual resource retirement and the original release identity", () => {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[0]!.service.devicesLive = 1;
  }, "GPU service retained guest resources");
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[0]!.service.owners[2]!.destroyed = 0;
  }, "unretired owner or presenter");
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[0]!.service.lifecycle.find(
        (e) => e.owner === 3 && e.kind === "release",
      )!.presenter = 99;
  }, "owner lifecycle identity changed");
});
test("active disposal requires the real native result to release after retirement", () => {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.nativeReleased = false;
  }, "late native result not released after owner retirement");
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.scopeResult!.releasedAt = 100;
  }, "late native result not released after owner retirement");
});
test("active disposal preserves cumulative observations including completed blobs", () => {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[0]!.service.fairness.blobs = [];
  }, "blob observation history dropped");
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[0]!.service.fairness.blobs[0]!.draws = 1;
  }, "completed blob history rewritten");
});
function rejectsLateSubmission(kind: string) {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.fairness.queue.push({
        connection: 3,
        start: 125,
        settlement: { kind, at: 126 },
      });
  }, "late retired native work");
}
test("active disposal rejects newly pending and rejected retired submissions for their own reason", () => {
  for (const kind of ["pending", "rejected"]) rejectsLateSubmission(kind);
});
test("active disposal rejects retired native calls and result publications", () => {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.owners[2]!.replies.head++;
  }, "Late work published to retired victim rings");
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.fairness.native["2:draw"].count++;
  }, "late retired replay or native work");
});
test("complete compiled gate discovers active disposal without replacing prior G3 helpers", () => {
  const source = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  for (const helper of [
    "disposalCases",
    "regrantCases",
    "admissionCases",
    "malformedCases",
    "ownershipCases",
  ])
    expect(source).toContain(`await ${helper}(page, url, available)`);
});

test("active disposal needs a positive shared audit before the expensive held work", () => {
  rejects((r) => {
    r.auditControl.name = "unobserved";
  }, "shared disposal audit positive control missing");
});

test("already pending native work may settle after retirement without new submissions", () => {
  const r = fixture();
  const pending = { connection: 3, start: 99, settlement: { kind: "pending", at: 0 } };
  r.phases[1]!.service.fairness.queue.push(structuredClone(pending));
  for (const state of [r.disposal.stopped, r.disposal.after]) {
    state.audits[0]!.service.fairness.queue.push(structuredClone(pending));
    state.audits[1]!.service.fairness.queue.push({
      connection: 3,
      start: 99,
      settlement: { kind: "completed", at: 130 },
    });
  }
  expect(validateDisposalResult(r).hardwareQualified).toBe(false);
});
test("post-disposal publication cannot become a new accepted stopped baseline", () => {
  rejects((r) => {
    r.disposal.stopped.controls[2]!.replies.head++;
    r.disposal.after.controls[2]!.replies.head++;
  }, "publication changed after synchronous disposal");
});

test("active disposal observes the actual canceled completion callback, not just native gate release", () => {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.lateCallback = undefined;
  }, "original canceled native callback did not run");
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after])
      state.audits[1]!.service.lateCallback!.owner = 2;
  }, "original canceled native callback did not run");
});

test("GPU service stops after its guests and before the filesystem", () => {
  rejects((r) => {
    r.disposal.workerStops[3]!.at = 204;
  }, "owned worker shutdown order changed");
});

test("the original held completion token cannot be rewritten at the disposal boundary", () => {
  rejects((r) => {
    for (const state of [r.disposal.stopped, r.disposal.after]) {
      state.audits[0]!.service.heldCompletion!.token = 99;
      state.audits[1]!.service.heldCompletion!.token = 99;
      state.audits[1]!.service.lateCallback!.token = 99;
    }
  }, "held completion identity changed at disposal");
});

function auditServices(value: ReturnType<typeof fixture>) {
  return [value.disposal.stopped, value.disposal.after].flatMap((state) =>
    state.audits.map((audit) => audit.service),
  );
}
function changeHeldToken(service: ReturnType<typeof observedService>, token: number) {
  service.heldCompletion!.token = token;
  if (service.lateCallback) service.lateCallback.token = token;
}

test("the first held completion token stays fixed through every later held observation", () => {
  rejects((value) => {
    changeHeldToken(value.phases[1]!.service, 99);
    for (const service of auditServices(value)) changeHeldToken(service, 99);
  }, "held completion identity changed during held observation");
});

function rejectFirstTerminalStart(kind: string) {
  rejects((value) => {
    for (const service of auditServices(value)) {
      service.fairness.queue.push({ connection: 3, start: 115, settlement: { kind, at: 116 } });
      Reflect.set(service.fairness.native, "3:submit", { count: 1, totalMs: 0, maxMs: 0 });
    }
  }, "native work started after owner retirement");
}
for (const kind of ["pending", "rejected"])
  test(`new ${kind} work cannot enter the first terminal audit baseline`, () => {
    rejectFirstTerminalStart(kind);
  });

test("the positive control stays immutable from its earliest terminal observation", () => {
  rejects((value) => {
    const services = value.phases
      .flatMap((phase) => [phase.before, phase.service])
      .concat([value.auditControl.service], auditServices(value));
    for (const service of services) service.owners[0]!.readerReads++;
  }, "late retired owner work");
});

test("the positive audit cannot hide new work from the already retired control", () => {
  rejects((value) => {
    const services = [value.auditControl.service].concat(
      [value.phases[1]!.before, value.phases[1]!.service],
      auditServices(value),
    );
    for (const service of services)
      Reflect.set(service.fairness.native, "1:draw", { count: 1, totalMs: 0, maxMs: 0 });
  }, "late retired replay or native work");
});

test("pre-retirement work first observed at shutdown can settle without becoming new work", () => {
  const value = fixture();
  for (const state of [value.disposal.stopped, value.disposal.after]) {
    state.audits[0]!.service.fairness.queue.push({
      connection: 3,
      start: 105,
      settlement: { kind: "pending", at: 0 },
    });
    state.audits[1]!.service.fairness.queue.push({
      connection: 3,
      start: 105,
      settlement: { kind: "rejected", at: 130 },
    });
  }
  expect(validateDisposalResult(value).hardwareQualified).toBe(false);
});

test("first terminal audit timestamps cannot grandfather post-retirement replay or presents", () => {
  rejects((value) => {
    for (const service of auditServices(value))
      service.fairness.slices.push({ connection: 3, start: 115, end: 116 });
  }, "native work started after owner retirement");
  rejects((value) => {
    for (const service of auditServices(value))
      service.fairness.presents.push({ connection: 3, at: 115 });
  }, "native work started after owner retirement");
  rejects((value) => {
    for (const service of auditServices(value))
      service.fairness.blobs.push({
        connection: 3,
        commandRingBytes: 4194304,
        bytes: 4800184,
        draws: 1,
        start: 115,
        end: 116,
      });
  }, "native work started after owner retirement");
});
