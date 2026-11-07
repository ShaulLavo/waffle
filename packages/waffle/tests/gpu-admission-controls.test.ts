import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateAdmissionResult } from "./gpu-admission-browser.js";

const checkpointNames = [
  "live",
  "saturated",
  "refused",
  "refusal-retired",
  "capacity",
  "recovered",
  "retired",
];
const heapUnit = 66086;
function audit() {
  return { canaries: Array.from({ length: 33 }, (_, i) => `canary-${i}`), leaks: [] as string[] };
}
function ledger(live: number, stopped: number) {
  const holder = (state: string, length: number) => ({
    label: "guest-control",
    state,
    shape: { length },
  });
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: stopped }, () => holder("debt", 5505220)).concat(
      Array.from({ length: live }, () => holder("live", 67108864)),
    ),
  };
}
function guest(surface: number, refused = false) {
  const token = `guest-${surface}`;
  const event = (name: string, call: number, phase: string, result = 0) => ({
    token,
    name,
    call,
    phase,
    connection: name === "open" ? 0 : 1,
    result,
  });
  return {
    pid: surface + 1,
    surface,
    token,
    text:
      `GPU_STAGE surface id=${surface} width=64 height=64 scale=1000 flags=3\n` +
      (refused
        ? "GPU_FAIL stage=open status=-48\n"
        : "GPU_STAGE open\nGPU_STAGE device\nGPU_FRAME\n"),
    events: (refused ? ["open"] : ["open", "append", "completions"]).flatMap((name, index) => [
      event(name, index + 1, "enter"),
      event(name, index + 1, "return", refused ? -48 : 0),
    ]),
  };
}
function liveSurfaces(index: number) {
  if (index === 0 || index === 6) return [2];
  if (index < 4) return Array.from({ length: 8 }, (_, i) => i + 2);
  return [2, 5, 6, 7, 8, 9].concat(index === 5 ? [11] : []);
}
function knownSurfaces(index: number) {
  if (index === 0) return [1, 2];
  return Array.from({ length: 9 }, (_, i) => i + 1).concat(index >= 5 ? [11] : []);
}
function ring(terminal: number, command: boolean, refused = false) {
  return {
    capacity: command ? 4194304 : 262144,
    head: refused ? 0 : 100,
    tail: refused ? 0 : 100,
    used: 0,
    writer: 0,
    terminal,
  };
}
function native(surface: number, live: boolean) {
  return {
    id: surface === 11 ? 10 : surface,
    grant: surface,
    surface,
    device: surface,
    created: 1,
    destroyed: Number(!live),
    state: live ? "ready" : "terminal",
    terminalReason: live ? 0 : 1,
    devices: Number(live),
    presenter: live,
    frame: false,
    pending: 0,
    payloadBytes: 0,
    replayBusy: false,
    partial: false,
    readerDisposed: !live,
    retiredAck: !live,
    readerReads: 10,
    ringReads: 10,
    logicalBytes: 0,
    protocolReads: 0,
    protocolReplays: 0,
    peakHeap: heapUnit,
    commands: ring(live ? 0 : 1, true),
    replies: ring(live ? 0 : 1, false),
  };
}
function attempt(surface: number, live: boolean) {
  const refused = surface === 10;
  const before = surface <= 2 ? 0 : surface === 11 ? 6 : Math.min(8, surface - 2);
  const reason = refused ? 3 : live ? 0 : 1;
  return {
    grant: surface,
    surface,
    connection: 1,
    owner: refused ? null : surface === 11 ? 10 : surface,
    status: refused ? -48 : live ? 1 : -64,
    reason,
    arenaTerminal: reason,
    commands: ring(reason, true, refused),
    replies: ring(reason, false, refused),
    retiredAck: !live,
    beforeConnections: before,
    afterConnections: before + Number(!refused),
    beforeHeap: before * heapUnit,
    afterHeap: before * heapUnit + (refused ? 0 : 65536),
    beforeNativeRequests: refused ? 9 : surface - 1,
    afterNativeRequests: refused ? 9 : surface - 1,
  };
}
function fairness(serial: number, surfaces: readonly number[]) {
  return {
    overflow: false,
    native: Object.fromEntries(
      surfaces.map((surface) => [
        `${surface === 11 ? 10 : surface}:submit`,
        { count: 1, totalMs: 1, maxMs: 1 },
      ]),
    ),
    slices: surfaces.map((surface) => ({
      connection: surface === 11 ? 10 : surface,
      start: 1,
      end: 2,
    })),
    presents: surfaces.flatMap((surface) =>
      Array.from({ length: surface === 2 ? serial : 1 }, (_, n) => ({
        connection: surface === 11 ? 10 : surface,
        at: surface === 2 ? (n + 1) * 20 - 1 : 1,
      })),
    ),
    queue: surfaces.flatMap((surface) =>
      Array.from({ length: surface === 2 ? serial : 1 }, (_, n) => ({
        connection: surface === 11 ? 10 : surface,
        start: surface === 2 ? (n + 1) * 20 - 3 : 0,
        settlement: { kind: "completed", at: surface === 2 ? (n + 1) * 20 - 2 : 1 },
      })),
    ),
  };
}
function snapshot(index: number, serial: number, final = false) {
  const known = knownSurfaces(index),
    live = final ? [] : liveSurfaces(index);
  return {
    token: "admission",
    realm: "one-service",
    mode: "admission",
    armed: false,
    held: false,
    released: false,
    nativeHeld: false,
    at: serial * 20,
    serial,
    responseId: `sample-${serial}`,
    connections: live.length,
    devicesLive: live.length,
    presentCanvasesLive: live.length,
    frameTexturesLive: 0,
    heapBytes: live.length * heapUnit,
    nativeRequests: known.length,
    owners: known.map((surface) => native(surface, live.includes(surface))),
    attempts: known
      .concat(index >= 2 ? [10] : [])
      .map((surface) => attempt(surface, live.includes(surface))),
    fairness: fairness(serial, known),
  };
}
function stop(surface: number, live: number, retired: number) {
  return {
    pid: surface + 1,
    exit: { kind: "exited", code: surface === 10 ? 1 : 0 },
    grantRetired: true,
    physicallyStopped: true,
    ownAuthority: [audit()],
    snapshot: ledger(live, retired),
    text: guest(surface, surface === 10).text,
    service: snapshot(0, 1),
  };
}
function proof() {
  const controlExit = stop(1, 1, 1);
  controlExit.service.owners = [native(1, false)];
  controlExit.service.connections = 0;
  const phases = checkpointNames.map((name, index) => ({
    name,
    peerPid: 3,
    before: snapshot(index, index * 2 + 1),
    service: snapshot(index, index * 2 + 2),
    pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
    recoveryPixels: { center: [255, 0, 0, 255], corner: [0, 0, 0, 255] },
  }));
  return {
    kind: "global-admission",
    token: "admission",
    peer: 2,
    cap: 8,
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
    cohort: Array.from({ length: 8 }, (_, i) => guest(i + 2)),
    refused: guest(10, true),
    refusalStop: stop(10, 9, 2),
    recovered: guest(11),
    selected: [stop(3, 8, 3), stop(4, 7, 4)],
    endings: [5, 6, 7, 8, 9, 11].map((surface, index) => stop(surface, 7 - index, 5 + index)),
    peerExit: stop(2, 1, 11),
    phases,
    final: snapshot(6, 15, true),
    runtimeStop: {
      workers: [{ url: "/gpu/service-worker.ts/ownership", stopped: true }],
      errors: [] as string[],
      snapshot: ledger(0, 11),
    },
  };
}
type Proof = ReturnType<typeof proof>;
function rejects(change: (value: Proof) => void, message: RegExp) {
  const value = proof();
  change(value);
  expect(() => validateAdmissionResult(value)).toThrow(message);
}
const phaseIndices = [0, 1, 2, 3, 4, 5, 6];

test("complete compiled admission result is accepted without hardware qualification", () => {
  expect(validateAdmissionResult(proof())).toMatchObject({
    hardwareQualified: false,
    targets: { sliceMs: 8, peerGapMs: 100 },
    targetStatus: "met",
  });
});
test("the live peer can hold its next acquired frame in any checkpoint", () => {
  const value = proof();
  for (const phase of value.phases) {
    const peer = phase.before.owners.find((item) => item.id === 2)!;
    peer.frame = true;
    phase.before.frameTexturesLive++;
  }
  expect(validateAdmissionResult(value).hardwareQualified).toBe(false);
});
test("positive native observation and admitted compiled imports cannot be omitted", () => {
  rejects((value) => {
    value.coverage.disposed = 0;
  }, /missing observer coverage/);
  rejects((value) => {
    value.coverage.native.submit = 0;
  }, /missing native observer coverage/);
  rejects((value) => {
    value.cohort[3]!.events.length = 0;
  }, /open import outcome/);
  rejects((value) => {
    value.recovered.text += "GPU_FAIL stage=device status=-64\n";
  }, /admitted compiled guest failed/);
  rejects((value) => {
    value.phases[1]!.service.owners[3]!.readerReads = 0;
  }, /positive coverage/);
});
test("only the original eight-connection policy and exact C open failure count", () => {
  rejects((value) => {
    value.cap = 9;
  }, /wrong case or global cap/);
  rejects((value) => {
    value.cohort.pop();
  }, /cohort size/);
  for (const text of [
    "GPU_FAIL",
    "GPU_FAIL stage=device status=-48",
    "GPU_FAIL stage=open status=-33",
    "GPU_FAIL stage=open status=-48 trailing",
    "GPU_FAIL stage=open status=-48\nGPU_FAIL stage=argument status=-28",
  ]) {
    rejects((value) => {
      value.refused.text = value.refused.text.replace("GPU_FAIL stage=open status=-48", text);
    }, /refusal stage or errno/);
  }
  rejects((value) => {
    value.refused.events[1]!.result = -33;
  }, /open import outcome/);
  rejects((value) => {
    value.refused.events[0]!.connection = 1;
  }, /open import outcome/);
  rejects((value) => {
    value.refused.text = value.refused.text.replace("id=10", "id=99");
  }, /surface correlation/);
});
test("service refusal must be local, unadmitted, and resource-terminal before retirement", () => {
  for (const index of [2, 3, 4, 5, 6]) {
    rejects((value) => {
      value.phases[index]!.service.attempts.at(-1)!.status = -64;
    }, /service cap or refusal/);
    rejects((value) => {
      value.phases[index]!.service.attempts.at(-1)!.reason = 2;
    }, /service cap or refusal/);
    rejects((value) => {
      value.phases[index]!.before.attempts.at(-1)!.arenaTerminal = 4;
    }, /service cap or refusal/);
    rejects((value) => {
      value.phases[index]!.service.attempts.at(-1)!.owner = 11;
    }, /service cap or refusal/);
    rejects((value) => {
      value.phases[index]!.before.attempts.at(-1)!.beforeConnections = 7;
    }, /service cap or refusal/);
    rejects((value) => {
      value.phases[index]!.service.attempts.at(-1)!.afterNativeRequests++;
    }, /service cap or refusal/);
    rejects((value) => {
      value.phases[index]!.service.attempts.at(-1)!.commands.head++;
    }, /published or changed terminal/);
  }
});
test("every original live owner and the peer presenter survive with their identities", () => {
  for (const index of phaseIndices) {
    rejects((value) => {
      value.phases[index]!.before.owners[1]!.device = 99;
    }, /cohort identity/);
    rejects((value) => {
      value.phases[index]!.service.owners[1]!.presenter = false;
    }, /presenter/);
    rejects((value) => {
      value.phases[index]!.peerPid = 99;
    }, /peer checkpoint/);
    rejects((value) => {
      value.phases[index]!.service.frameTexturesLive++;
    }, /frame ownership/);
  }
  for (const index of [1, 2, 3]) {
    rejects((value) => {
      value.phases[index]!.before.owners[5]!.grant = 99;
    }, /cohort identity/);
    rejects((value) => {
      value.phases[index]!.service.owners.splice(5, 1);
    }, /global live cohort|ownership admitted guest/);
    rejects((value) => {
      value.phases[index]!.service.connections = 9;
    }, /global live cohort/);
  }
  rejects((value) => {
    value.recovered.pid = value.cohort[0]!.pid;
  }, /aliased guest pid/);
  rejects((value) => {
    value.phases[2]!.before.nativeRequests++;
  }, /native producer count/);
});
test("every screenshot bracket needs new original native presents and completed queue work", () => {
  for (const index of phaseIndices) {
    rejects((value) => {
      value.phases[index]!.service.fairness.presents = structuredClone(
        value.phases[index]!.before.fairness.presents,
      );
    }, /fresh in-bracket native work/);
    rejects((value) => {
      value.phases[index]!.service.fairness.queue = structuredClone(
        value.phases[index]!.before.fairness.queue,
      );
    }, /fresh in-bracket native work/);
    rejects((value) => {
      value.phases[index]!.service.fairness.queue = value.phases[index]!.service.fairness.queue.map(
        (item) => ({ ...item, start: 0, settlement: { ...item.settlement, at: 1 } }),
      );
    }, /stale in-bracket queue work/);
    rejects((value) => {
      value.phases[index]!.pixels.center = [255, 0, 0, 255];
    }, /pixel failure/);
  }
});
test("stale service realm, request, clock and token observations fail closed", () => {
  for (const index of phaseIndices) {
    rejects((value) => {
      value.phases[index]!.before.realm = "replacement";
    }, /stale or uncorrelated/);
    rejects((value) => {
      value.phases[index]!.service.token = "unrelated";
    }, /stale or uncorrelated/);
    rejects((value) => {
      value.phases[index]!.service.responseId = value.phases[index]!.before.responseId;
    }, /stale or uncorrelated/);
    rejects((value) => {
      value.phases[index]!.service.at = value.phases[index]!.before.at;
    }, /stale or uncorrelated/);
  }
});
test("selected holders and every owned resource must physically retire with exact debt", () => {
  rejects((value) => {
    value.refusalStop.physicallyStopped = false;
  }, /physical retirement/);
  rejects((value) => {
    value.selected[0]!.grantRetired = false;
  }, /physically retire normally/);
  rejects((value) => {
    value.endings[0]!.exit.code = 1;
  }, /physically retire normally/);
  rejects((value) => {
    value.phases[4]!.service.owners[2]!.pending = 1;
  }, /unretired admitted owner/);
  rejects((value) => {
    value.phases[6]!.before.heapBytes++;
  }, /service heap credit/);
  rejects((value) => {
    value.peerExit.snapshot.holders[0]!.shape.length = 0;
  }, /monotonic debt/);
  rejects((value) => {
    value.refusalStop.snapshot.holders[0]!.state = "released";
  }, /monotonic debt/);
  rejects((value) => {
    value.runtimeStop.snapshot.holders[0]!.shape.length = 0;
  }, /monotonic debt/);
  rejects((value) => {
    value.runtimeStop.workers[0]!.stopped = false;
  }, /retained workers/);
  rejects((value) => {
    value.final.devicesLive = 1;
  }, /global live cohort/);
});
test("later service turns cannot revive retired ownership or publish late work", () => {
  rejects((value) => {
    value.phases[5]!.before.owners[2]!.ringReads++;
  }, /late retired owner work/);
  rejects((value) => {
    value.phases[4]!.service.owners[2]!.replies.head++;
  }, /Late work published/);
  rejects((value) => {
    value.final.owners[2]!.device = 99;
  }, /cohort identity/);
  rejects((value) => {
    value.phases[5]!.service.attempts.at(-1)!.replies.head++;
  }, /published or changed terminal/);
});
test("all original latency misses remain not-met and never become hardware qualification", () => {
  const value = proof();
  value.phases[6]!.service.fairness.slices.find((slice) => slice.connection === 2)!.end = 20;
  const measured = validateAdmissionResult(value);
  expect(measured).toMatchObject({
    sliceTargetMet: false,
    targetStatus: "not-met",
    hardwareQualified: false,
  });
});
test("the complete registered compiled browser runner includes admission coverage", () => {
  const runner = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  expect(runner).toContain('import { admissionCases } from "./gpu-admission-browser.js"');
  expect(runner).toContain("await admissionCases(page, url, available)");
  expect(runner).toContain("await malformedCases(page, url, available)");
  expect(runner).toContain("await ownershipCases(page, url, available)");
});

test("each admitted native cohort member needs its own positive work observations", () => {
  rejects((value) => {
    value.phases[1]!.service.fairness.queue = value.phases[1]!.service.fairness.queue.filter(
      (work) => work.connection !== 5,
    );
  }, /missing native peer progress/);
});
test("retired native producers cannot submit or present after their retirement bracket", () => {
  rejects((value) => {
    value.phases[5]!.service.fairness.presents.push({ connection: 3, at: 230 });
  }, /late retired native work/);
  rejects((value) => {
    value.phases[5]!.service.fairness.queue.push({
      connection: 3,
      start: 229,
      settlement: { kind: "completed", at: 230 },
    });
  }, /late retired native work/);
});

test("no unowned native producer or extra final open can hide outside the cohort", () => {
  rejects((value) => {
    value.phases[2]!.service.fairness.presents.push({ connection: 99, at: 99 });
  }, /unowned native producer/);
  rejects((value) => {
    value.final.attempts.push(attempt(12, false));
  }, /unexpected final open attempts/);
  rejects((value) => {
    value.phases[2]!.service.attempts.at(-1)!.beforeHeap++;
  }, /service cap or refusal/);
});
test("recovery must retain its actual new compiled guest pixels", () => {
  rejects((value) => {
    value.phases[5]!.recoveryPixels.center = [0, 255, 0, 255];
  }, /pixel failure/);
});

function afterCapacity(value: Proof) {
  return value.phases
    .slice(5)
    .flatMap((phase) => [phase.before, phase.service])
    .concat([value.final]);
}
function appendLateQueue(value: Proof, settlement: unknown) {
  for (const service of afterCapacity(value)) {
    const queue = service.fairness.queue;
    Reflect.set(queue, queue.length, { connection: 3, start: 200, settlement });
  }
}
test("retired owners cannot start pending or rejected submissions later", () => {
  rejects((value) => appendLateQueue(value, { kind: "pending" }), /late retired native work/);
  rejects(
    (value) => appendLateQueue(value, { kind: "rejected", at: 201 }),
    /late retired native work/,
  );
});
test("retired owners cannot replay another slice", () => {
  rejects((value) => {
    for (const service of afterCapacity(value))
      Reflect.set(service.fairness.slices, service.fairness.slices.length, {
        connection: 3,
        start: 200,
        end: 201,
        records: 1,
        draws: 1,
        bytes: 12,
        kind: "progress",
      });
  }, /late retired native work/);
});
test("retired owners cannot invoke existing or newly observed native methods", () => {
  rejects((value) => {
    for (const service of afterCapacity(value)) service.fairness.native["3:submit"]!.count++;
  }, /late retired native work/);
  rejects((value) => {
    for (const service of afterCapacity(value))
      service.fairness.native["3:draw"] = { count: 1, totalMs: 1, maxMs: 1 };
  }, /late retired native work/);
});
function pendingAtRetirement(kind: "completed" | "rejected") {
  const value = proof();
  for (const phase of value.phases.slice(1)) {
    for (const service of [phase.before, phase.service]) {
      const settled = phase.name === "recovered" || phase.name === "retired";
      Reflect.set(service.fairness.queue, service.fairness.queue.length, {
        connection: 3,
        start: 3,
        settlement: settled ? { kind, at: 210 } : { kind: "pending" },
      });
    }
  }
  Reflect.set(value.final.fairness.queue, value.final.fairness.queue.length, {
    connection: 3,
    start: 3,
    settlement: { kind, at: 210 },
  });
  return value;
}
test("an already recorded pending submission may settle after its owner retires", () => {
  for (const kind of ["completed", "rejected"] as const)
    expect(validateAdmissionResult(pendingAtRetirement(kind)).hardwareQualified).toBe(false);
});

test("retired submission identity and already-settled results cannot be rewritten", () => {
  rejects((value) => {
    for (const service of afterCapacity(value))
      service.fairness.queue.find((work) => work.connection === 3)!.start = 0.5;
  }, /late retired native work/);
  rejects((value) => {
    for (const service of afterCapacity(value))
      service.fairness.queue.find((work) => work.connection === 3)!.settlement.at = 199;
  }, /settlement changed after completion/);
});

test("retired observations cannot hide work behind overflow", () => {
  rejects((value) => {
    value.final.fairness.overflow = true;
  }, /retired native observation overflow/);
});
