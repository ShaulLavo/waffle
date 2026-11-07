import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateRegrantResult } from "./gpu-regrant-browser.js";

const names = ["live", "ready", "held", "replacement", "released", "retired"];
const heap = 66086;
const audit = () => ({
  canaries: Array.from({ length: 33 }, (_, n) => `canary-${n}`),
  leaks: new Array<string>(),
});
function ledger(live: number, retired: number) {
  const holder = (state: string, length: number) => ({
    label: "guest-control",
    state,
    shape: { length },
  });
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: live }, () => holder("live", 67108864)).concat(
      Array.from({ length: retired }, () => holder("debt", 5505220)),
    ),
  };
}
function guest(id: number) {
  const surface = id === 4 ? 3 : id,
    token = `guest-${id}`;
  const events = ["open", "append", "completions"].flatMap((name, call) =>
    ["enter", "return"].map((phase) => ({
      name,
      phase,
      call: call + 1,
      token,
      connection: 1,
      result: 0,
      authority: audit(),
    })),
  );
  return {
    pid: id + 1,
    surface,
    token,
    events,
    text: `GPU_STAGE surface id=${surface} width=64 height=64 scale=1000 flags=3\nGPU_STAGE open\nGPU_FRAME\n`,
  };
}
function ring(reason: number) {
  return { capacity: 4194304, terminal: reason, head: 100, tail: 100, used: 0, writer: 0 };
}
function native(id: number, index: number) {
  const done = id === 1 || (id === 3 && index >= 3) || (id === 4 && index >= 5) || index === 6;
  const reason = done ? (id === 3 ? 4 : 1) : 0;
  return {
    id,
    grant: id,
    surface: id === 4 ? 3 : id,
    device: id,
    state: done ? "terminal" : "ready",
    terminalReason: reason,
    created: 1,
    destroyed: Number(done),
    devices: Number(!done),
    presenter: !done,
    presenterId: done ? 0 : id,
    presenterDevice: done ? 0 : id,
    frame: id === 3 && !done,
    readerDisposed: done,
    retiredAck: done,
    partial: false,
    pending: id === 3 && index === 2 ? 1 : 0,
    payloadBytes: 0,
    replayBusy: false,
    readerReads: 10,
    ringReads: 10,
    logicalBytes: 0,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: heap,
    commands: ring(reason),
    replies: ring(reason),
  };
}
function lifecycle(index: number) {
  const event = (kind: string, id: number, at: number) => ({
    kind,
    owner: id,
    grant: id,
    surface: id === 4 ? 3 : id,
    device: id,
    presenter: kind === "retired" ? 0 : id,
    at,
  });
  return [
    event("configure", 1, 0),
    event("release", 1, 1),
    event("retired", 1, 2),
    event("configure", 2, 3),
  ].concat(
    index >= 1 ? [event("configure", 3, 41)] : [],
    index >= 3
      ? [event("release", 3, 121), event("retired", 3, 122), event("configure", 4, 123)]
      : [],
    index >= 5 ? [event("release", 4, 201), event("retired", 4, 202)] : [],
    index >= 6 ? [event("release", 2, 241), event("retired", 2, 242)] : [],
  );
}
function blobObservation(end: number | null = 82) {
  return {
    connection: 3,
    bytes: 4800184,
    commandRingBytes: 4194304,
    draws: 200000,
    start: 81,
    end,
  };
}
function fairness(serial: number, known: number[], index: number) {
  const active = known.filter((id) => id !== 3);
  const counts = (id: number) => (id === 2 ? serial : 1);
  return {
    overflow: false,
    native: Object.fromEntries(
      known.map((id) => [
        `${id}:draw`,
        { count: id === 3 && index >= 2 ? 200000 : 1, totalMs: 1, maxMs: 1 },
      ]),
    ),
    records: Object.fromEntries(
      known.map((id) => [`${id}:top:1`, { count: 1, totalMs: 1, maxMs: 1 }]),
    ),
    presents: active
      .flatMap((id) =>
        Array.from({ length: counts(id) }, (_, n) => ({
          connection: id,
          at: id === 2 ? (n + 1) * 20 - 1 : id === 4 ? 125 : 1,
        })),
      )
      .sort((a, b) => a.at - b.at),
    queue: active
      .flatMap((id) =>
        Array.from({ length: counts(id) }, (_, n) => ({
          connection: id,
          start: id === 2 ? (n + 1) * 20 - 3 : id === 4 ? 124 : 0,
          settlement: { kind: "completed", at: id === 2 ? (n + 1) * 20 - 2 : id === 4 ? 126 : 1 },
        })),
      )
      .sort((a, b) => a.start - b.start),
    slices: known.map((id) => ({
      connection: id,
      start: id === 4 ? 124 : 0,
      end: id === 4 ? 125 : 1,
    })),
    blobs: index >= 2 ? [blobObservation()] : [],
  };
}
function snapshot(index: number, serial: number) {
  const known = index === 0 ? [1, 2] : index < 3 ? [1, 2, 3] : [1, 2, 3, 4];
  const owners = known.map((id) => native(id, index));
  const live = owners.filter((item) => item.state === "ready").length;
  return {
    token: "regrant",
    realm: "one-service",
    mode: "regrant",
    serial,
    responseId: `sample-${serial}`,
    at: serial * 20,
    armed: index >= 2,
    held: index >= 2,
    nativeHeld: index === 2 || index === 3,
    nativeReleased: index >= 4,
    released: index >= 4,
    scopeResult:
      index >= 2
        ? { owner: 3, device: 3, kind: "none", at: 83, releasedAt: index >= 4 ? 161 : null }
        : undefined,
    connections: live,
    devicesLive: live,
    presentCanvasesLive: live,
    frameTexturesLive: Number(index === 1 || index === 2),
    nativeRequests: known.length,
    heapBytes: live * heap,
    owners,
    lifecycle: lifecycle(index),
    fairness: fairness(serial, known, index),
    attempts: owners.map((item) => ({
      owner: item.id,
      grant: item.grant,
      surface: item.surface,
      connection: 1,
      status: item.state === "terminal" ? -64 : 1,
      reason: item.terminalReason,
      arenaTerminal: item.terminalReason,
      retiredAck: item.retiredAck,
      commands: ring(item.terminalReason),
      replies: ring(item.terminalReason),
      beforeNativeRequests: 0,
      afterNativeRequests: 0,
      beforeConnections: 0,
      afterConnections: 1,
    })),
  };
}
function stop(id: number, live: number, retired: number, failed = false) {
  return {
    pid: id + 1,
    exit: { kind: "exited", code: Number(failed) },
    grantRetired: true,
    physicallyStopped: true,
    text: failed ? "GPU_FAIL stage=completions status=-64\n" : "GPU_FRAME\n",
    ownAuthority: [audit()],
    snapshot: ledger(live, retired),
    service: snapshot(0, 1),
  };
}
function proof() {
  const oldGuest = guest(3),
    blockedGuest = structuredClone(oldGuest);
  blockedGuest.events = blockedGuest.events.concat(
    ["enter", "wait"].map((phase) => ({
      name: "completions",
      phase,
      call: 4,
      token: oldGuest.token,
      connection: 1,
      result: 0,
      authority: audit(),
    })),
  );
  const controlExit = stop(1, 1, 1);
  controlExit.service.owners = [native(1, 0)];
  const phases = names.map((name, index) => ({
    name,
    peerPid: 3,
    before: snapshot(index, index * 2 + 1),
    service: snapshot(index, index * 2 + 2),
    pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
    replacementPixels: { center: [0, 0, 255, 255], corner: [0, 0, 0, 255] },
  }));
  return {
    kind: "surface-regrant",
    token: "regrant",
    peer: 2,
    victim: 3,
    replacement: 4,
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
    controlGuest: guest(1),
    controlExit,
    peerGuest: guest(2),
    oldGuest,
    blockedGuest,
    replacementGuest: guest(4),
    regrant: { oldPid: 4, replacementPid: 5, surface: 3, retiredBeforeGrant: false },
    phases,
    oldStop: stop(3, 3, 2, true),
    replacementStop: stop(4, 2, 3),
    peerExit: stop(2, 1, 4),
    final: snapshot(6, 13),
    runtimeStop: {
      errors: [],
      workers: [{ url: "/gpu/service-worker.ts/ownership", stopped: true }],
      snapshot: ledger(0, 4),
    },
  };
}
type Proof = ReturnType<typeof proof>;
function rejects(change: (value: Proof) => void, message: RegExp) {
  const value = proof();
  change(value);
  expect(() => validateRegrantResult(value)).toThrow(message);
}
function afterReplacement(value: Proof) {
  return value.phases
    .slice(3)
    .flatMap((phase) => [phase.before, phase.service])
    .concat([value.final]);
}
function afterHeld(value: Proof) {
  return value.phases
    .slice(2)
    .flatMap((phase) => [phase.before, phase.service])
    .concat([value.final]);
}

test("a complete same-canvas regrant proof retains the original targets without hardware qualification", () => {
  expect(validateRegrantResult(proof())).toMatchObject({
    targets: { sliceMs: 8, peerGapMs: 100 },
    hardwareQualified: false,
    targetStatus: "met",
  });
});
test("the original peer can legitimately hold its next frame", () => {
  const value = proof();
  for (const phase of value.phases) {
    phase.before.owners[1]!.frame = true;
    phase.before.frameTexturesLive++;
  }
  expect(validateRegrantResult(value).hardwareQualified).toBe(false);
});
test("coverage, compiled process identity, open and authority controls are mandatory", () => {
  rejects((v) => {
    v.coverage.native.submit = 0;
  }, /missing native observer coverage/);
  rejects((v) => {
    v.coverage.disposed = 0;
  }, /missing observer coverage/);
  rejects((v) => {
    v.oldGuest.token = "";
  }, /missing compiled guest identity/);
  rejects((v) => {
    v.replacementGuest.events[1]!.result = -64;
  }, /wrong original compiled open/);
  rejects((v) => {
    v.peerGuest.events[2]!.token = "other";
  }, /correlated ownership import/);
  rejects((v) => {
    v.blockedGuest.events[0]!.authority.leaks.push("private");
    v.oldGuest.events[0]!.authority.leaks.push("private");
  }, /authority canaries/);
  rejects((v) => {
    v.oldGuest.events.length = 0;
  }, /correlated ownership import/);
  rejects((v) => {
    v.replacementGuest.pid = v.oldGuest.pid;
  }, /aliased compiled guest/);
  rejects((v) => {
    v.replacementGuest.surface = 99;
    v.replacementGuest.text = v.replacementGuest.text.replace("id=3", "id=99");
  }, /reuse the original canvas/);
});
test("regrant must happen before awaiting retirement and retain distinct native ownership", () => {
  rejects((v) => {
    v.regrant.retiredBeforeGrant = true;
  }, /waited for retirement/);
  rejects((v) => {
    v.regrant.oldPid = 99;
  }, /waited for retirement/);
  rejects((v) => {
    v.replacement = v.victim;
  }, /wrong selected native owners/);
  rejects((v) => {
    v.phases[3]!.service.owners[3]!.device = 3;
  }, /aliased native ownership/);
  rejects((v) => {
    v.phases[4]!.before.owners[3]!.presenterId = 3;
  }, /live presenter or device replaced/);
});
test("every native screenshot bracket needs fresh started and completed queue work and new presents", () => {
  for (let index = 0; index < names.length; index++) {
    rejects((v) => {
      v.phases[index]!.service.fairness.queue = structuredClone(
        v.phases[index]!.before.fairness.queue,
      );
    }, /fresh in-bracket native work/);
    rejects((v) => {
      v.phases[index]!.service.fairness.presents = structuredClone(
        v.phases[index]!.before.fairness.presents,
      );
    }, /fresh in-bracket native work/);
    rejects((v) => {
      const queue = v.phases[index]!.service.fairness.queue;
      queue.findLast((item) => item.connection === 2)!.start = 0;
    }, /stale in-bracket queue work/);
    rejects((v) => {
      v.phases[index]!.pixels.center = [255, 0, 0, 255];
    }, /pixel failure/);
    rejects((v) => {
      v.phases[index]!.peerPid = 99;
    }, /replaced peer checkpoint/);
  }
  rejects((v) => {
    v.phases[4]!.replacementPixels.center = [255, 0, 0, 255];
  }, /pixel failure/);
});
test("same-service snapshots and cumulative observations cannot be dropped or rewritten", () => {
  rejects((v) => {
    v.phases[2]!.before.realm = "other";
  }, /stale or uncorrelated/);
  rejects((v) => {
    v.phases[2]!.service.responseId = v.phases[2]!.before.responseId;
  }, /stale or uncorrelated/);
  rejects((v) => {
    v.phases[2]!.service.serial = 0;
  }, /stale or uncorrelated/);
  rejects((v) => {
    v.phases[2]!.service.at = 0;
  }, /stale or uncorrelated/);
  rejects((v) => {
    v.phases[2]!.service.fairness.presents[0]!.at++;
  }, /observation history rewritten/);
  rejects((v) => {
    v.phases[2]!.service.lifecycle[0]!.at++;
  }, /lifecycle history rewritten/);
  rejects((v) => {
    v.phases[2]!.service.fairness.queue.length = 0;
  }, /queue observation history dropped/);
  rejects((v) => {
    v.phases[2]!.service.fairness.native["2:draw"]!.count = 0;
  }, /aggregate history decreased/);
  rejects((v) => {
    v.final.token = "other";
  }, /final correlated cohort/);
});
test("presenter release and service retirement must precede replacement configure and present", () => {
  rejects((v) => {
    for (const s of afterReplacement(v))
      [s.lifecycle[5], s.lifecycle[7]] = [s.lifecycle[7]!, s.lifecycle[5]!];
  }, /configured before original release and retirement/);
  rejects((v) => {
    for (const s of afterReplacement(v)) s.lifecycle[5]!.presenter = 99;
  }, /presenter release or replacement identity/);
  rejects((v) => {
    for (const s of afterReplacement(v)) s.lifecycle[7]!.grant = 99;
  }, /uncorrelated lifecycle/);
  rejects((v) => {
    for (const s of afterReplacement(v)) s.lifecycle[7]!.at = 130;
  }, /presented before configure/);
});
test("the old compiled owner must hold a real native scope result after oversized replay", () => {
  rejects((v) => {
    v.phases[2]!.service.owners[2]!.pending = 0;
  }, /not pending with its owned frame/);
  rejects((v) => {
    v.blockedGuest.events.at(-1)!.phase = "return";
  }, /real completions import/);
  rejects((v) => {
    v.blockedGuest.events[0]!.call = 99;
  }, /import history rewritten/);
  rejects((v) => {
    v.phases[3]!.service.nativeHeld = false;
  }, /correlated held native scope result/);
  rejects((v) => {
    for (const sample of afterHeld(v)) sample.scopeResult!.owner = 4;
  }, /correlated held native scope result/);
  rejects((v) => {
    v.phases[2]!.service.scopeResult!.releasedAt = 1;
  }, /native result release interval/);
  rejects((v) => {
    v.phases[4]!.service.scopeResult!.at++;
  }, /held native result identity rewritten/);
  rejects((v) => {
    for (const sample of afterHeld(v)) sample.fairness.blobs[0]!.draws--;
  }, /oversized replay workload/);
});
test("retired ownership, credit, rings, imports and physical stops remain strict", () => {
  rejects((v) => {
    v.phases[4]!.before.owners[2]!.commands.head++;
  }, /Late work published/);
  rejects((v) => {
    v.phases[3]!.service.owners[2]!.devices = 1;
  }, /unretired owner/);
  rejects((v) => {
    v.phases[3]!.service.heapBytes++;
  }, /service credit/);
  rejects((v) => {
    v.phases[4]!.service.owners[3]!.grant++;
    v.phases[4]!.service.attempts[3]!.grant++;
  }, /owner identity changed/);
  rejects((v) => {
    v.phases[3]!.before.owners[2]!.readerDisposed = false;
  }, /unretired owner/);
  rejects((v) => {
    v.oldStop.physicallyStopped = false;
  }, /compiled physical stop/);
  rejects((v) => {
    v.oldStop.text = "GPU_FAIL stage=other status=-64";
  }, /revoked compiled failure/);
  rejects((v) => {
    v.replacementStop.exit.code = 1;
  }, /compiled physical stop/);
  rejects((v) => {
    v.peerExit.snapshot.holders.at(-1)!.shape.length = 0;
  }, /monotonic debt/);
  rejects((v) => {
    v.runtimeStop.workers[0]!.stopped = false;
  }, /retained workers/);
  rejects((v) => {
    v.runtimeStop.workers.push({ url: "/gpu/service-worker.ts", stopped: true });
  }, /single-service topology/);
});
test("no new pending or rejected work may start after old retirement", () => {
  for (const settlement of [{ kind: "pending" }, { kind: "rejected", at: 150 }]) {
    rejects((v) => {
      const s = v.phases[3]!.service;
      Reflect.set(s.fairness.queue, s.fairness.queue.length, {
        connection: 3,
        start: 145,
        settlement,
      });
    }, /late retired native work/);
  }
});
test("retired owners cannot replay or invoke existing or newly observed native methods", () => {
  rejects((v) => {
    const s = v.phases[3]!.service;
    s.fairness.slices.push({ connection: 3, start: 145, end: 146 });
  }, /late retired replay or native work/);
  rejects((v) => {
    v.phases[3]!.service.fairness.native["3:draw"]!.count++;
  }, /late retired replay or native work/);
  rejects((v) => {
    v.phases[3]!.service.fairness.native["3:submit"] = { count: 1, totalMs: 1, maxMs: 1 };
  }, /late retired replay or native work/);
});
function pendingAtRetirement(kind: "completed" | "rejected") {
  const value = proof();
  for (const s of afterHeld(value)) {
    Reflect.set(s.fairness.queue, s.fairness.queue.length, {
      connection: 3,
      start: 84,
      settlement: s.serial <= 8 ? { kind: "pending" } : { kind, at: 161 },
    });
    s.fairness.queue.sort((a, b) => a.start - b.start);
  }
  return value;
}
test("already pending work can settle after retirement but its identity and settlement cannot change", () => {
  for (const kind of ["completed", "rejected"] as const)
    expect(validateRegrantResult(pendingAtRetirement(kind)).hardwareQualified).toBe(false);
  rejects((v) => {
    const q = v.phases[4]!.service.fairness.queue.find((item) => item.connection === 4)!;
    q.start++;
  }, /late retired native work/);
  rejects((v) => {
    v.phases[4]!.service.fairness.queue[0]!.settlement.at++;
  }, /settlement changed after completion/);
});
test("unexpected opens, changed service counts, stale presenters and final live owners fail", () => {
  rejects((v) => {
    v.phases[3]!.before.attempts.push(structuredClone(v.phases[3]!.before.attempts[0]!));
  }, /unexpected original open attempt/);
  rejects((v) => {
    v.phases[3]!.before.attempts[3]!.grant++;
  }, /uncorrelated original open attempt/);
  rejects((v) => {
    v.phases[3]!.before.connections++;
  }, /ownership cohort or topology/);
  rejects((v) => {
    v.phases[4]!.before.owners[1]!.presenterDevice = 99;
  }, /live presenter or device replaced/);
  rejects((v) => {
    v.final.owners[1]!.device = 99;
  }, /final peer identity/);
  rejects((v) => {
    v.final.presentCanvasesLive = 1;
  }, /retained guest resources/);
  rejects((v) => {
    v.final.fairness.overflow = true;
  }, /final correlated cohort/);
});
test("latency misses stay not-met and the complete compiled runner always includes regrant", () => {
  const value = proof();
  for (const phase of value.phases)
    for (const s of [phase.before, phase.service]) s.fairness.slices[0]!.end = 12;
  value.final.fairness.slices[0]!.end = 12;
  expect(validateRegrantResult(value)).toMatchObject({
    targetStatus: "not-met",
    sliceTargetMet: false,
    hardwareQualified: false,
  });
  const runner = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  expect(runner).toContain('import { regrantCases } from "./gpu-regrant-browser.js"');
  expect(runner).toContain("await regrantCases(page, url, available)");
  expect(runner).toContain("await admissionCases(page, url, available)");
});

test("native result identity, release stamps and producer attribution stay cumulative", () => {
  rejects((v) => {
    v.phases[4]!.service.scopeResult!.releasedAt!++;
  }, /native result release stamp rewritten/);
  rejects((v) => {
    v.phases[3]!.before.fairness.native["99:draw"] = { count: 1, totalMs: 1, maxMs: 1 };
  }, /unowned native aggregate/);
  rejects((v) => {
    v.phases[3]!.before.fairness.queue.push({
      connection: 99,
      start: 125,
      settlement: { kind: "completed", at: 126 },
    });
  }, /unowned native producer/);
});

test("native pending settlements and aggregate timings retain their recorded meaning", () => {
  rejects((v) => {
    Reflect.set(v.phases[2]!.service.fairness.queue.at(-1)!.settlement, "kind", "unknown");
  }, /invalid native queue settlement/);
  rejects((v) => {
    v.phases[2]!.service.fairness.native["2:draw"]!.totalMs = 0;
  }, /aggregate history decreased/);
  const value = pendingAtRetirement("completed");
  value.phases[4]!.before.fairness.queue.find((work) => work.connection === 3)!.settlement.at = 100;
  expect(() => validateRegrantResult(value)).toThrow(/settlement predates its pending observation/);
});

test("releasing the old result cannot publish to replacement rings or add pending results", () => {
  rejects((v) => {
    v.phases[4]!.service.owners[3]!.replies.head++;
  }, /mutated replacement rings/);
  rejects((v) => {
    v.phases[4]!.service.owners[3]!.commands.tail++;
  }, /mutated replacement rings/);
  rejects((v) => {
    v.phases[4]!.service.owners[3]!.pending++;
  }, /replacement gained results or work/);
  rejects((v) => {
    v.phases[4]!.service.owners[3]!.payloadBytes++;
  }, /replacement gained results or work/);
});

test("an actual old-presenter release observation cannot be omitted", () => {
  rejects((v) => {
    for (const service of afterReplacement(v))
      service.lifecycle = service.lifecycle.filter(
        (event) => event.owner !== 3 || event.kind !== "release",
      );
  }, /missing or duplicate lifecycle event/);
});

test("completed blob history cannot disappear at retirement or the final sample", () => {
  rejects((value) => {
    for (const sample of afterReplacement(value)) sample.fairness.blobs = [];
  }, /blob observation history dropped/);
  rejects((value) => {
    value.final.fairness.blobs = [];
  }, /blob observation history dropped/);
});

test("completed blob identities and observations cannot be rewritten or reopened", () => {
  for (const key of ["connection", "commandRingBytes", "bytes", "start", "draws", "end"]) {
    const value = proof();
    for (const sample of afterReplacement(value)) Reflect.set(sample.fairness.blobs[0]!, key, 1);
    expect(() => validateRegrantResult(value)).toThrow(/blob.*history rewritten/);
  }
  rejects((value) => {
    for (const sample of afterReplacement(value)) sample.fairness.blobs[0]!.end = null;
  }, /completed blob history rewritten/);
});

function runningBlobProof() {
  const value = proof();
  for (const [index, sample] of [value.phases[1]!.before, value.phases[1]!.service].entries()) {
    const blob = blobObservation(null);
    blob.start = 50;
    blob.draws = index + 1;
    sample.fairness.blobs = [blob];
    sample.fairness.native["3:draw"]!.count = blob.draws;
  }
  for (const sample of afterHeld(value)) sample.fairness.blobs[0]!.start = 50;
  return value;
}

test("running blob progress can finish while retaining its original identity", () => {
  expect(validateRegrantResult(runningBlobProof()).hardwareQualified).toBe(false);
});

test("running blob history cannot change identity, lose progress or complete retroactively", () => {
  const changed = runningBlobProof();
  changed.phases[1]!.service.fairness.blobs[0]!.bytes++;
  expect(() => validateRegrantResult(changed)).toThrow(/blob identity history rewritten/);
  const regressed = runningBlobProof();
  regressed.phases[1]!.service.fairness.blobs[0]!.draws = 0;
  expect(() => validateRegrantResult(regressed)).toThrow(/blob progress history regressed/);
  const retroactive = runningBlobProof();
  retroactive.phases[2]!.before.fairness.blobs[0]!.end = 79;
  expect(() => validateRegrantResult(retroactive)).toThrow(
    /blob completion history predates running observation/,
  );
});
