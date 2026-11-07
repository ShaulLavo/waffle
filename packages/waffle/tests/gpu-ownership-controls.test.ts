import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateOwnershipResult } from "./gpu-ownership-browser.js";

function controlSnapshot(live: number, retired: number) {
  return {
    platform: { kind: "bounded" },
    holders: Array.from({ length: live }, () => ({
      label: "guest-control",
      state: "live",
      shape: { kind: "fixed-buffer", length: 67108864 },
    })).concat(
      Array.from({ length: retired }, () => ({
        label: "guest-control",
        state: "debt",
        shape: { kind: "fixed-buffer", length: 5505220 },
      })),
    ),
  };
}
function proof(kind = "append") {
  const owner = (id: number, retired = false) => ({
    id,
    grant: id,
    surface: id,
    device: id,
    state: retired ? "terminal" : "ready",
    devices: retired ? 0 : 1,
    created: 1,
    destroyed: retired ? 1 : 0,
    readerReads: 4,
    ringReads: 4,
    chunkBytes: 65536,
    logicalBytes: 4800184,
    readerDisposed: retired,
    partial: !retired && id === 2,
    heldReads: 1,
    pending: 0,
    payloadBytes: 0,
    replayBusy: false,
    presenter: !retired,
    frame: !retired && id === 2,
    retiredAck: retired,
    commands: {
      head: 1,
      tail: 0,
      capacity: 4194304,
      used: retired ? 0 : 4194304,
      writer: 1,
      terminal: retired ? 4 : 0,
    },
    replies: { head: 0, tail: 0, capacity: 262144, used: 0, writer: 0, terminal: retired ? 4 : 0 },
  });
  const events = [
    { token: "victim", call: 1, name: "append", phase: "enter", connection: 1, length: 32 },
    { token: "victim", call: 1, name: "append", phase: "return", result: 0 },
    { token: "victim", call: 2, name: "completions", phase: "enter", connection: 1, length: 1024 },
    { token: "victim", call: 2, name: "completions", phase: "wait" },
    { token: "victim", call: 2, name: "completions", phase: "return", result: 0 },
    {
      token: "victim",
      call: 3,
      name: kind,
      phase: "enter",
      connection: 1,
      authority: { canaries: Array(33).fill("canary"), leaks: [] },
      length: kind === "append" ? 4800184 : 1024,
    },
    { token: "victim", call: 3, name: kind, phase: "wait" },
  ];
  const phases = ["live", "armed", "blocked", "retired", "released"].map((name, index) => ({
    name,
    pid: 10,
    peerPid: 11,
    token: "victim",
    events: index >= 2 ? events : events.slice(0, 5),
    pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
    service: {
      realm: "realm",
      serial: index + 1,
      responseId: `reply-${index}`,
      token: "case",
      mode: kind,
      at: 20 * (index + 1),
      owners: index < 2 ? [owner(1)] : [owner(1), owner(2, index >= 3)],
      armed: index >= 1,
      held: index >= 2,
      nativeHeld: kind === "completions" && index < 4,
      released: index === 4,
      nativeReleased: index === 4,
      connections: index === 2 ? 2 : 1,
      devicesLive: index === 2 && kind === "append" ? 2 : 1,
      fairness: {
        overflow: false,
        slices: [{ start: 1, end: 2 }],
        presents: Array.from({ length: index + 1 }, (_, n) => ({
          connection: 1,
          at: 20 * (n + 1),
        })),
      },
    },
  }));
  if (kind === "completions") {
    for (const phase of phases) {
      const victim = phase.service.owners.find((item) => item.id === 2);
      if (!victim) continue;
      victim.partial = false;
      victim.presenter = false;
      victim.frame = false;
      victim.devices = 0;
      if (phase.name === "blocked") victim.pending = 1;
      if (phase.name === "retired") victim.destroyed = 0;
    }
  }
  return {
    kind,
    token: "case",
    victim: 2,
    peer: 1,
    phases,
    coverage: {
      native: {
        draw: 1,
        finish: 1,
        submit: 1,
        transferToImageBitmap: 1,
        transferFromImageBitmap: 1,
      },
      readerReads: 1,
      ringReads: 1,
      disposed: 1,
      destroyed: 1,
      nativeRequests: 1,
      presents: 1,
    },
    stop: {
      pid: 10,
      exit: { kind: "signaled", code: 9 },
      grantRetired: true,
      physicallyStopped: true,
      snapshot: controlSnapshot(2, 2),
      ownAuthority: [{ canaries: Array(33).fill("canary"), leaks: [] }],
    },
    controlExit: {
      exit: { kind: "exited", code: 0 },
      ownAuthority: [{ canaries: Array(33).fill("canary"), leaks: [] }],
    },
    peerExit: {
      snapshot: controlSnapshot(1, 3),
      pid: 11,
      exit: { kind: "exited", code: 0 },
      ownAuthority: [{ canaries: Array(33).fill("canary"), leaks: [] }],
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

test("valid blocked append and completion proofs retain their target classifications", () => {
  expect(() => validateOwnershipResult(proof())).not.toThrow();
  expect(() => validateOwnershipResult(proof("completions"))).not.toThrow();
});

test("missing observer coverage fails closed before acceptance", () => {
  const value = proof();
  value.coverage.ringReads = 0;
  expect(() => validateOwnershipResult(value)).toThrow("coverage");
});

test("pre-import and already-returned kills are not blocked import evidence", () => {
  const missing = proof();
  missing.phases[2]!.events.pop();
  expect(() => validateOwnershipResult(missing)).toThrow("import");
  const returned = proof();
  returned.phases[2]!.events.push({
    token: "victim",
    call: 3,
    name: "append",
    phase: "return",
    result: 0,
  });
  expect(() => validateOwnershipResult(returned)).toThrow("import");
});

test("missing, replaced and non-presenting survivors fail independently", () => {
  const missing = proof();
  missing.phases[3]!.service.owners.shift();
  expect(() => validateOwnershipResult(missing)).toThrow("peer");
  const replaced = proof();
  replaced.phases[3]!.service.owners[0]!.device = 99;
  expect(() => validateOwnershipResult(replaced)).toThrow("peer");
  const stale = proof();
  stale.phases[3]!.service.fairness.presents = stale.phases[2]!.service.fairness.presents;
  expect(() => validateOwnershipResult(stale)).toThrow("present");
});

test("stale snapshots, wrong correlations and incomplete physical stop fail", () => {
  const stale = proof();
  stale.phases[3]!.service.serial = stale.phases[2]!.service.serial;
  expect(() => validateOwnershipResult(stale)).toThrow("snapshot");
  const wrong = proof();
  wrong.phases[3]!.service.token = "other";
  expect(() => validateOwnershipResult(wrong)).toThrow("snapshot");
  const notStopped = proof();
  notStopped.stop.physicallyStopped = false;
  expect(() => validateOwnershipResult(notStopped)).toThrow("stop");
});

test("victim ring/partial/presenter/device leaks and late resurrection fail", () => {
  for (const field of ["partial", "presenter", "frame", "replayBusy"] as const) {
    const value = proof();
    value.phases[3]!.service.owners[1]![field] = true;
    expect(() => validateOwnershipResult(value)).toThrow("retire");
  }
  const late = proof("completions");
  late.phases[4]!.service.owners[1]!.destroyed = 0;
  expect(() => validateOwnershipResult(late)).toThrow("Late");
  const reply = proof("completions");
  reply.phases[2]!.service.owners[1]!.replies.used = 16;
  expect(() => validateOwnershipResult(reply)).toThrow("completion");
  const ring = proof();
  ring.phases[2]!.service.owners[1]!.commands.used = 0;
  expect(() => validateOwnershipResult(ring)).toThrow("append");
});

test("entry without an actual inner import wait and absent victim canaries fail", () => {
  const noWait = proof();
  noWait.phases[2]!.events.pop();
  expect(() => validateOwnershipResult(noWait)).toThrow("import");
  const noAuthority = proof();
  const entry = noAuthority.phases[2]!.events.find(
    (event) => event.call === 3 && event.phase === "enter",
  )!;
  entry.authority = undefined;
  expect(() => validateOwnershipResult(noAuthority)).toThrow();
});

test("late publications, reopened victim resources and reset debt fail", () => {
  const revived = proof();
  revived.phases[4]!.service.owners[1]!.state = "ready";
  expect(() => validateOwnershipResult(revived)).toThrow("retire");
  const debt = proof();
  debt.stop.snapshot.holders[2]!.state = "released";
  expect(() => validateOwnershipResult(debt)).toThrow("debt");
  const published = proof();
  published.phases[4]!.service.owners[1]!.replies.head++;
  expect(() => validateOwnershipResult(published)).toThrow("Late work");
  const cohort = proof();
  cohort.phases[4]!.service.connections = 2;
  expect(() => validateOwnershipResult(cohort)).toThrow("cohort");
});

test("unmet unchanged timing targets are reported, never converted into hardware qualification", () => {
  const value = proof();
  value.phases[4]!.service.fairness.slices[0]!.end = 14;
  value.phases[4]!.service.fairness.presents.at(-1)!.at = 300;
  expect(validateOwnershipResult(value)).toMatchObject({
    targets: { sliceMs: 8, peerGapMs: 100 },
    targetStatus: "not-met",
    sliceTargetMet: false,
    peerGapTargetMet: false,
    hardwareQualified: false,
  });
});

test("the existing blocking runner always bundles and executes the ownership proof", () => {
  const source = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  expect(source).toContain('import { ownershipCases } from "./gpu-ownership-browser.js"');
  expect(source).toContain('routes["/gpu/service-worker.ts/ownership"] = await browserBundle(');
  expect(source).toContain("const ownership = await ownershipCases(page, url, available);");
  expect(source.indexOf("await ownershipCases(page")).toBeLessThan(
    source.indexOf("await fairnessCases(page"),
  );
});
