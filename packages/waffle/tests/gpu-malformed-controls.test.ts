import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateMalformedResult } from "./gpu-malformed-browser.js";

function cleanAuthority() {
  return {
    canaries: Array.from({ length: 33 }, (_, index) => `synthetic-canary-${index}`),
    leaks: [] as string[],
  };
}
function ledger(live: number, retired: number) {
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: live + retired }, (_, i) => ({
      label: "guest-control",
      state: i < live ? "live" : "debt",
      shape: { length: i < live ? 67108864 : 5505220 },
    })),
  };
}
/** Victim counters follow the service: the hold starts at armed, the mutated read lands after it. */
function owner(id: number, phase = 0) {
  const victim = id === 3,
    terminal = victim && phase >= 3;
  return {
    id,
    grant: id,
    surface: id,
    device: id,
    created: 1,
    destroyed: terminal ? 1 : 0,
    state: terminal ? "terminal" : "ready",
    terminalReason: terminal ? 2 : 0,
    devices: terminal ? 0 : 1,
    pending: 0,
    payloadBytes: 0,
    replayBusy: false,
    presenter: !terminal,
    frame: !terminal && victim,
    partial: false,
    readerDisposed: terminal,
    retiredAck: terminal,
    readerReads: 10 + phase,
    ringReads: terminal ? 12 : 10,
    heldReads: victim && phase >= 2 ? 10 : 0,
    logicalBytes: terminal ? 4800184 : 0,
    protocolReads: terminal ? phase - 2 : 0,
    protocolReplays: terminal ? 1 : 0,
    peakHeap: terminal ? 4932356 : 132172,
    commands: {
      head: 100,
      tail: terminal ? 80 : 0,
      used: terminal ? 20 : 4194304,
      capacity: 4194304,
      writer: 1,
      terminal: terminal ? 2 : 0,
    },
    replies: {
      head: 32,
      tail: 32,
      used: 0,
      capacity: 262144,
      writer: 0,
      terminal: terminal ? 2 : 0,
    },
  };
}
/** The service keeps the first, already stopped control guest in its owner list. */
function retiredControl() {
  return {
    ...owner(1),
    state: "terminal",
    terminalReason: 1,
    devices: 0,
    destroyed: 1,
    presenter: false,
    readerDisposed: true,
    retiredAck: true,
  };
}
type Event = {
  token: string;
  name: string;
  call: number;
  phase: string;
  connection?: number;
  length?: number;
  result?: number;
  authority?: ReturnType<typeof cleanAuthority>;
};
function victimEvents(phase: number): Event[] {
  const events: Event[] = ["append", "completions"].flatMap((name, i) => [
    {
      token: "victim",
      name,
      call: i + 1,
      phase: "enter",
      connection: 1,
      authority: cleanAuthority(),
    },
    { token: "victim", name, call: i + 1, phase: "return", result: 0 },
  ]);
  if (phase < 2) return events;
  const append = { token: "victim", name: "append", call: 3 };
  return events.concat(
    [
      { ...append, phase: "enter", connection: 1, length: 4800184, authority: cleanAuthority() },
      { ...append, phase: "wait" },
    ],
    phase >= 3 ? [{ ...append, phase: "return", result: -64 }] : [],
  );
}
function proof(kind = "header") {
  const injection = {
    owner: 3,
    mode: kind,
    read: kind === "chunk" ? 12 : 11,
    offset: kind === "header" ? 0 : kind === "chunk" ? 12 : 44,
    before: kind === "header" ? 69636 : kind === "chunk" ? 65512 : 12,
    after: kind === "header" ? 4294901761 : kind === "chunk" ? 65520 : 4097,
  };
  const phases = ["live", "ready", "armed", "retired", "released"].map((name, i) => {
    const snapshot = (serial: number) => ({
      realm: "realm",
      token: "case",
      mode: kind,
      serial,
      responseId: `response-${serial}`,
      at: serial * 20,
      armed: i >= 2,
      held: i >= 2,
      malformedReleased: i >= 3,
      injection: i >= 3 ? { ...injection } : undefined,
      late: i === 4 ? { reads: 0, kind: "terminal", reason: 2 } : undefined,
      heapBytes: i === 1 || i === 2 ? 132172 : 66086,
      connections: i === 1 || i === 2 ? 2 : 1,
      devicesLive: i === 1 || i === 2 ? 2 : 1,
      frameTexturesLive: i === 1 || i === 2 ? 1 : 0,
      presentCanvasesLive: i === 1 || i === 2 ? 2 : 1,
      owners: (i ? [owner(2, i), owner(3, i)] : [owner(2, i)]).concat([retiredControl()]),
      fairness: {
        overflow: false,
        slices: [{ connection: 2, start: 1, end: 2 }],
        presents: Array.from({ length: serial }, (_, n) => ({
          connection: 2,
          at: 20 * (n + 1) - 1,
        })),
        queue: Array.from({ length: serial }, (_, n) => ({
          connection: 2,
          start: 20 * (n + 1) - 3,
          settlement: { kind: "completed", at: 20 * (n + 1) - 2 },
        })),
      },
    });
    return {
      name,
      peerPid: 3,
      guest: i ? { pid: 4, token: "victim", events: victimEvents(i) } : undefined,
      pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
      before: snapshot(i * 2 + 1),
      service: snapshot(i * 2 + 2),
    };
  });
  return {
    kind,
    token: "case",
    peer: 2,
    victim: 3,
    phases,
    coverage: {
      readerReads: 1,
      ringReads: 1,
      disposed: 1,
      destroyed: 1,
      nativeRequests: 3,
      presents: 1,
      native: {
        draw: 1,
        finish: 1,
        submit: 1,
        transferToImageBitmap: 1,
        transferFromImageBitmap: 1,
      },
    },
    controlExit: { exit: { kind: "exited", code: 0 }, ownAuthority: [cleanAuthority()] },
    stop: {
      pid: 4,
      exit: { kind: "exited", code: 1 },
      grantRetired: true,
      physicallyStopped: true,
      ownAuthority: [cleanAuthority()],
      snapshot: ledger(2, 2),
      text:
        kind === "nesting"
          ? "GPU_FAIRNESS_PUBLISHED\nGPU_FAIL stage=completions status=-64\n"
          : "GPU_FAIL stage=fairness-append status=-64\n",
    },
    peerExit: {
      pid: 3,
      exit: { kind: "exited", code: 0 },
      ownAuthority: [cleanAuthority()],
      snapshot: ledger(1, 3),
    },
    final: {
      connections: 0,
      devicesLive: 0,
      heapBytes: 0,
      frameTexturesLive: 0,
      presentCanvasesLive: 0,
    },
  };
}

type Proof = ReturnType<typeof proof>;
const all = [0, 1, 2, 3, 4],
  retirement = [3, 4];
/** Each mutation must trip its own predicate, not an unrelated structural failure. */
function rejects(mutate: (value: Proof) => void, message: RegExp, kind = "header") {
  const value = proof(kind);
  mutate(value);
  expect(() => validateMalformedResult(value)).toThrow(message);
}
const stale = /stale or uncorrelated snapshot/,
  cohort = /wrong live ownership cohort/;
const late = /consumed or published work after retirement/,
  byte = /correlated malformed byte observation/;

test("all three complete malformed proofs are accepted without hardware qualification", () => {
  for (const mode of ["header", "chunk", "nesting"]) {
    expect(validateMalformedResult(proof(mode))).toMatchObject({
      hardwareQualified: false,
      targets: { sliceMs: 8, peerGapMs: 100 },
    });
  }
});
test("the same live peer may acquire its next frame between checkpoint snapshots", () => {
  for (const mode of ["header", "chunk", "nesting"]) {
    const value = proof(mode);
    for (const phase of value.phases) {
      phase.before.owners[0]!.frame = true;
      phase.before.frameTexturesLive++;
    }
    expect(validateMalformedResult(value).hardwareQualified).toBe(false);
  }
});
test("frame counters must match the peer observation without hiding a retained victim frame", () => {
  for (const i of all) {
    rejects((value) => {
      value.phases[i]!.before.frameTexturesLive++;
    }, cohort);
    rejects((value) => {
      Reflect.deleteProperty(value.phases[i]!.service.owners[0]!, "frame");
    }, /missing peer frame observation/);
  }
});
test("missing service and victim-context observer coverage fails", () => {
  rejects((value) => {
    value.coverage.ringReads = 0;
  }, /missing observer coverage/);
  rejects((value) => {
    value.coverage.native.transferFromImageBitmap = 0;
  }, /missing native observer coverage/);
  rejects((value) => {
    value.phases[1]!.guest!.events.length = 0;
  }, /Missing correlated ownership import/);
  rejects((value) => {
    value.phases[1]!.service.owners[1]!.ringReads = 0;
  }, /missing live victim positive coverage/);
});
test("every checkpoint rejects stale or uncorrelated snapshots", () => {
  for (const i of all) {
    rejects((value) => {
      value.phases[i]!.service.responseId = value.phases[i]!.before.responseId;
    }, stale);
    rejects((value) => {
      value.phases[i]!.before.token = "other";
    }, stale);
    rejects((value) => {
      value.phases[i]!.service.realm = "other";
    }, stale);
    rejects((value) => {
      value.phases[i]!.before.mode = "chunk";
    }, stale);
    rejects((value) => {
      value.phases[i]!.service.serial = value.phases[i]!.before.serial;
    }, stale);
    rejects((value) => {
      value.phases[i]!.before.at = 0;
    }, stale);
  }
  rejects((value) => {
    value.phases[3]!.name = "released";
  }, /missing or replaced peer checkpoint/);
  rejects((value) => {
    value.phases.pop();
  }, /missing checkpoints/);
  rejects((value) => {
    value.token = "other";
  }, stale);
});
test("selection, hold, release and late probe states appear only at their checkpoints", () => {
  rejects((value) => {
    value.phases[1]!.service.held = true;
  }, stale);
  rejects((value) => {
    value.phases[2]!.before.malformedReleased = true;
  }, stale);
  rejects((value) => {
    value.phases[2]!.service.injection = value.phases[3]!.service.injection;
  }, stale);
  rejects((value) => {
    value.phases[3]!.before.late = value.phases[4]!.service.late;
  }, stale);
  rejects((value) => {
    value.phases[0]!.service.owners.push(owner(3, 1));
  }, /victim before launch/);
  rejects((value) => {
    value.phases[0]!.guest = value.phases[1]!.guest;
  }, /victim guest before launch/);
  rejects((value) => {
    value.phases[1]!.service.owners[1]!.heldReads = 1;
  }, /victim held before selection/);
});
test("the armed checkpoint holds the selected reader inside the compiled oversized append", () => {
  rejects((value) => {
    value.phases[2]!.service.owners[1]!.ringReads++;
  }, /not held across the armed checkpoint/);
  rejects((value) => {
    value.phases[2]!.service.owners[1]!.heldReads = 0;
  }, /missing selected victim gate/);
  rejects((value) => {
    value.phases[2]!.guest!.events.pop();
  }, /not waiting inside the oversized append/);
  rejects((value) => {
    value.phases[2]!.guest!.events.at(-2)!.length = 4096;
  }, /not waiting inside the oversized append/);
  rejects((value) => {
    value.phases[2]!.service.owners[1]!.commands.used = 0;
  }, /missing selected victim gate/);
});
test("every checkpoint requires the same live native peer and new presents and queue progress", () => {
  for (const i of all) {
    rejects((value) => {
      value.phases[i]!.service.owners[0]!.device = 99;
    }, /peer disappeared or was replaced/);
    rejects((value) => {
      value.phases[i]!.before.owners[0]!.grant = 99;
    }, /peer disappeared or was replaced/);
    rejects((value) => {
      value.phases[i]!.before.fairness.presents.length = 0;
    }, /missing native peer progress/);
    rejects((value) => {
      value.phases[i]!.service.fairness.queue.length = 0;
    }, /missing native peer progress/);
    rejects((value) => {
      value.phases[i]!.before.fairness.queue.pop();
    }, /native peer progress/);
    rejects((value) => {
      value.phases[i]!.before.fairness.presents.pop();
    }, /native peer progress/);
    rejects((value) => {
      value.phases[i]!.service.fairness.queue[0]!.settlement.kind = "lost";
    }, /native peer progress/);
    rejects((value) => {
      value.phases[i]!.peerPid = 9;
    }, /missing or replaced peer checkpoint/);
    rejects((value) => {
      value.phases[i]!.pixels.center = [255, 0, 0, 255];
    }, /pixel failure/);
  }
});
test("every victim entry authority interval must remain present and clean", () => {
  for (const i of [1, 2, 3, 4]) {
    rejects((value) => {
      value.phases[i]!.guest!.events[0]!.authority!.leaks.push("Atomics.load");
    }, /authority canaries failed/);
    rejects((value) => {
      value.phases[i]!.guest!.pid = 9;
    }, /replaced victim process/);
  }
  for (const i of [2, 3, 4]) {
    rejects((value) => {
      value.phases[i]!.guest!.events[0]!.connection = 2;
    }, /authority interval rewritten or dropped/);
    rejects((value) => {
      value.phases[i]!.guest!.events[1]!.result = 1;
    }, /import positive control missing|interval/);
  }
  rejects((value) => {
    value.phases[4]!.guest!.events.pop();
  }, /authority interval rewritten or dropped/);
});
test("exact production parser terminal reason and mutation evidence are required", () => {
  for (const i of retirement) {
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.terminalReason = 4;
    }, /wrong protocol terminal reason/);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.commands.terminal = 4;
    }, /wrong protocol terminal reason/);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.protocolReads = 0;
    }, /production parser terminal/);
    rejects(
      (value) => {
        value.phases[i]!.service.owners[1]!.protocolReplays = 0;
      },
      /production parser terminal/,
      "nesting",
    );
    rejects((value) => {
      value.phases[i]!.service.injection!.after = 0;
    }, byte);
    rejects((value) => {
      value.phases[i]!.before.injection!.owner = 2;
    }, byte);
    rejects((value) => {
      value.phases[i]!.service.injection!.mode = "chunk";
    }, byte);
    rejects((value) => {
      value.phases[i]!.service.injection!.read = 10;
    }, byte);
    rejects((value) => {
      value.phases[i]!.service.injection!.read = 13;
    }, byte);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.logicalBytes = 4096;
    }, /not the held append/);
  }
  for (const kind of ["chunk", "nesting"]) {
    rejects(
      (value) => {
        value.phases[3]!.service.owners[1]!.peakHeap = 132172;
      },
      /logical assembly service credit/,
      kind,
    );
    rejects(
      (value) => {
        value.phases[3]!.service.injection!.before = 0;
      },
      byte,
      kind,
    );
  }
});
test("all retired ownership and heap credits return to the peer baseline", () => {
  for (const i of retirement) {
    rejects((value) => {
      value.phases[i]!.service.heapBytes++;
    }, /return to peer baseline/);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.frame = true;
    }, /unretired victim ownership/);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.pending = 1;
    }, /unretired victim ownership/);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.readerDisposed = false;
    }, /unretired victim ownership/);
    rejects((value) => {
      value.phases[i]!.service.owners[1]!.surface = 99;
    }, /victim identity changed/);
    rejects((value) => {
      value.phases[i]!.before.connections = 2;
    }, cohort);
  }
  rejects((value) => {
    value.phases[1]!.service.heapBytes = 66086;
  }, /positive victim service credit/);
});
test("late ring publication and revived original work cannot pass", () => {
  rejects((value) => {
    value.phases[4]!.service.owners[1]!.replies.head++;
  }, /Late work published/);
  rejects((value) => {
    value.phases[4]!.service.late!.reads = 1;
  }, /late original work revived/);
  rejects((value) => {
    value.phases[4]!.service.late!.reason = 4;
  }, /late original work revived/);
  rejects((value) => {
    value.phases[4]!.service.owners[1]!.ringReads = 13;
  }, late);
  rejects((value) => {
    value.phases[4]!.service.owners[1]!.protocolReplays = 2;
  }, late);
  rejects((value) => {
    value.phases[4]!.service.injection!.read = 12;
  }, late);
});
test("physical retirement and conservative shared-control debt are separate requirements", () => {
  rejects((value) => {
    value.stop.physicallyStopped = false;
  }, /physical retirement/);
  rejects((value) => {
    value.stop.exit.code = 0;
  }, /physical retirement/);
  rejects((value) => {
    value.stop.pid = 9;
  }, /physical retirement/);
  rejects((value) => {
    value.stop.snapshot.holders[2]!.state = "released";
  }, /monotonic debt/);
  rejects((value) => {
    value.peerExit.snapshot.holders.pop();
  }, /live accounting/);
  rejects((value) => {
    value.peerExit.pid = 9;
  }, /replaced peer at exit/);
});
test("every service credit observation must be a finite integer", () => {
  for (const i of all) {
    rejects((value) => {
      value.phases[i]!.before.heapBytes = NaN;
    }, /observation/);
    rejects((value) => {
      value.phases[i]!.service.heapBytes = 0.5;
    }, /invalid integer observation/);
  }
});
test("the existing complete runner includes malformed isolation before ownership and fairness", () => {
  const source = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  expect(source).toContain('import { malformedCases } from "./gpu-malformed-browser.js"');
  expect(source.indexOf("await malformedCases(page")).toBeLessThan(
    source.indexOf("await ownershipCases(page"),
  );
});

test("the compiled victim must report its exact parser-failure stage and errno", () => {
  for (const text of [
    "GPU_FAIL",
    "GPU_FAIL stage=device status=-64",
    "GPU_FAIL stage=fairness-append status=-58",
    "GPU_FAIL stage=fairness-append status=-64 trailing",
    "GPU_FAIL stage=fairness-append status=-64\nGPU_FAIL stage=device status=-64",
  ]) {
    rejects((value) => {
      value.stop.text = text;
    }, /compiled victim failure/);
  }
});

test("nested parser closure requires the actual terminal import after the valid closed reply", () => {
  for (const old of ["GPU_FAIRNESS_PUBLISHED", "stage=completions", "status=-64"]) {
    rejects(
      (value) => {
        value.stop.text = value.stop.text.replace(old, "unrelated");
      },
      /compiled victim failure/,
      "nesting",
    );
  }
  for (const text of [
    "GPU_FAIRNESS_PUBLISHED\nGPU_UNEXPECTED kind=12 token=0\nGPU_FAIL stage=unexpected-completion status=-28\n",
    "GPU_FAIRNESS_PUBLISHED\nGPU_UNEXPECTED kind=12 token=0\nGPU_FAIL stage=completions status=-64\n",
    "GPU_FAIRNESS_PUBLISHED\nGPU_FAIL stage=completions status=-48\n",
    "GPU_FAIRNESS_PUBLISHED\nGPU_FAIL stage=completions status=-64 trailing\n",
    "GPU_FAIRNESS_PUBLISHED\nGPU_FAIL stage=completions status=-64\nGPU_FAIL stage=device status=-64\n",
  ]) {
    rejects(
      (value) => {
        value.stop.text = text;
      },
      /compiled victim failure/,
      "nesting",
    );
  }
});

test("each screenshot bracket requires new presents and completed queue work", () => {
  for (const index of all) {
    rejects((value) => {
      value.phases[index]!.service.fairness.presents = structuredClone(
        value.phases[index]!.before.fairness.presents,
      );
    }, /fresh native peer progress/);
    rejects((value) => {
      value.phases[index]!.service.fairness.queue = structuredClone(
        value.phases[index]!.before.fairness.queue,
      );
    }, /fresh native peer progress/);
  }
});
test("the unchanged peer must own a presenter in every snapshot", () => {
  for (const index of all) {
    rejects((value) => {
      value.phases[index]!.before.owners[0]!.presenter = false;
    }, /peer presenter ownership/);
    rejects((value) => {
      value.phases[index]!.service.owners[0]!.presenter = false;
    }, /peer presenter ownership/);
  }
});
test("replayed old completions cannot count as fresh screenshot-bracket work", () => {
  for (const index of all) {
    rejects((value) => {
      value.phases[index]!.service.fairness.queue.forEach((item) => {
        item.settlement.at = 1;
        item.start = 0;
      });
    }, /fresh native peer observation/);
  }
});
test("a repeated canary label cannot replace independent observed canaries", () => {
  rejects((value) => {
    value.phases[1]!.guest!.events[0]!.authority!.canaries.fill("fake");
  }, /distinct authority canaries/);
});
