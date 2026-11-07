import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateMalformedResult } from "./gpu-malformed-browser.js";

function cleanAuthority() {
  return { canaries: Array.from({ length: 33 }, () => "canary"), leaks: [] as string[] };
}
function ledger(live: number, retired: number) {
  return { platform: { kind: "bounded" }, holders: Array.from({ length: live + retired }, (_, i) => ({
    label: "guest-control", state: i < live ? "live" : "debt",
    shape: { length: i < live ? 67108864 : 5505220 },
  })) };
}
function owner(id: number, terminal = false) {
  return {
    id, grant: id, surface: id, device: id, created: 1, destroyed: terminal ? 1 : 0,
    state: terminal ? "terminal" : "ready", terminalReason: terminal ? 2 : 0,
    devices: terminal ? 0 : 1, pending: 0, payloadBytes: 0, replayBusy: false,
    presenter: !terminal, frame: !terminal && id === 3, partial: false,
    readerDisposed: terminal, retiredAck: terminal, readerReads: 10, ringReads: 10,
    heldReads: 10, logicalBytes: 4800184, protocolReads: terminal ? 1 : 0,
    protocolReplays: terminal ? 1 : 0, peakHeap: terminal ? 4932356 : 132172,
    commands: { head: 100, tail: terminal ? 80 : 0, used: terminal ? 20 : 4194304,
      capacity: 4194304, writer: 1, terminal: terminal ? 2 : 0 },
    replies: { head: 32, tail: 32, used: 0, capacity: 262144, writer: 0, terminal: terminal ? 2 : 0 },
  };
}
function proof(kind = "header") {
  const events = ["append", "completions"].flatMap((name, i) => [
    { token: "victim", name, call: i + 1, phase: "enter", connection: 1, authority: cleanAuthority() },
    { token: "victim", name, call: i + 1, phase: "return", result: 0 },
  ]);
  const injection = { owner: 3, mode: kind, read: kind === "chunk" ? 12 : 11,
    offset: kind === "header" ? 0 : kind === "chunk" ? 12 : 44,
    before: kind === "header" ? 69636 : kind === "chunk" ? 65512 : 12,
    after: kind === "header" ? 4294901761 : kind === "chunk" ? 65520 : 4097 };
  const phases = ["live", "ready", "armed", "retired", "released"].map((name, i) => {
    const snapshot = (serial: number) => ({
      realm: "realm", token: "case", mode: kind, serial, responseId: `response-${serial}`, at: serial * 20,
      armed: i >= 2, held: i >= 2, malformedReleased: i >= 3,
      injection: i >= 3 ? injection : undefined,
      late: i === 4 ? { reads: 0, kind: "terminal", reason: 2 } : undefined,
      heapBytes: i === 1 || i === 2 ? 132172 : 66086,
      connections: i === 1 || i === 2 ? 2 : 1, devicesLive: i === 1 || i === 2 ? 2 : 1,
      frameTexturesLive: i === 1 || i === 2 ? 1 : 0,
      presentCanvasesLive: i === 1 || i === 2 ? 2 : 1,
      owners: i ? [owner(2), owner(3, i >= 3)] : [owner(2)],
      fairness: { overflow: false, slices: [{ connection: 2, start: 1, end: 2 }],
        presents: Array.from({ length: i + 1 }, (_, n) => ({ connection: 2, at: 20 * (n + 1) })),
        queue: Array.from({ length: i + 1 }, (_, n) => ({ connection: 2, start: n,
          settlement: { kind: "completed", at: n + 1 } })),
      },
    });
    return { name, peerPid: 3, guest: { pid: 4, token: "victim", events },
      pixels: { center: [0, 255, 0, 255], corner: [0, 0, 0, 255] },
      before: snapshot(i * 2 + 1), service: snapshot(i * 2 + 2) };
  });
  return { kind, token: "case", peer: 2, victim: 3, phases,
    coverage: { readerReads: 1, ringReads: 1, disposed: 1, destroyed: 1, nativeRequests: 3, presents: 1,
      native: { draw: 1, finish: 1, submit: 1, transferToImageBitmap: 1, transferFromImageBitmap: 1 } },
    controlExit: { exit: { kind: "exited", code: 0 }, ownAuthority: [cleanAuthority()] },
    stop: { pid: 4, exit: { kind: "exited", code: 1 }, grantRetired: true, physicallyStopped: true,
      ownAuthority: [cleanAuthority()], snapshot: ledger(2, 2), text: "GPU_FAIL" },
    peerExit: { pid: 3, exit: { kind: "exited", code: 0 }, ownAuthority: [cleanAuthority()], snapshot: ledger(1, 3) },
    final: { connections: 0, devicesLive: 0, heapBytes: 0, frameTexturesLive: 0, presentCanvasesLive: 0 },
  };
}

test("all three complete malformed proofs are accepted without hardware qualification", () => {
  for (const mode of ["header", "chunk", "nesting"]) {
    expect(validateMalformedResult(proof(mode))).toMatchObject({ hardwareQualified: false });
  }
});
test("missing service and victim-context observer coverage fails", () => {
  const value = proof(); value.coverage.ringReads = 0;
  expect(() => validateMalformedResult(value)).toThrow();
  const victim = proof(); victim.phases[1]!.guest.events.length = 0;
  expect(() => validateMalformedResult(victim)).toThrow();
});
test("every checkpoint rejects stale or uncorrelated snapshots", () => {
  for (const i of [0, 1, 2, 3, 4]) {
    const value = proof(); value.phases[i]!.service.responseId = value.phases[i]!.before.responseId;
    expect(() => validateMalformedResult(value)).toThrow();
    const token = proof(); token.phases[i]!.before.token = "other";
    expect(() => validateMalformedResult(token)).toThrow();
  }
});
test("every checkpoint requires the same live native peer and new presents and queue progress", () => {
  for (const i of [0, 1, 2, 3, 4]) {
    const replaced = proof(); replaced.phases[i]!.service.owners[0]!.device = 99;
    expect(() => validateMalformedResult(replaced)).toThrow();
    const absent = proof(); absent.phases[i]!.before.fairness.presents.length = 0;
    expect(() => validateMalformedResult(absent)).toThrow();
    const queue = proof(); queue.phases[i]!.service.fairness.queue.length = 0;
    expect(() => validateMalformedResult(queue)).toThrow();
  }
});
test("every victim entry authority interval must remain present and clean", () => {
  for (const i of [1, 2, 3, 4]) {
    const value = proof(); value.phases[i]!.guest.events[0]!.authority!.leaks.push("Atomics.load");
    expect(() => validateMalformedResult(value)).toThrow();
  }
});
test("exact production parser terminal reason and mutation evidence are required", () => {
  for (const i of [3, 4]) {
    const wrong = proof(); wrong.phases[i]!.service.owners[1]!.terminalReason = 4;
    expect(() => validateMalformedResult(wrong)).toThrow();
    const parser = proof(); parser.phases[i]!.service.owners[1]!.protocolReads = 0;
    expect(() => validateMalformedResult(parser)).toThrow();
    const mutation = proof(); mutation.phases[i]!.service.injection!.after = 0;
    expect(() => validateMalformedResult(mutation)).toThrow();
  }
});
test("all retired ownership and heap credits return to the peer baseline", () => {
  for (const i of [3, 4]) {
    const value = proof(); value.phases[i]!.service.heapBytes++;
    expect(() => validateMalformedResult(value)).toThrow();
    const leak = proof(); leak.phases[i]!.service.owners[1]!.frame = true;
    expect(() => validateMalformedResult(leak)).toThrow();
    const identity = proof(); identity.phases[i]!.service.owners[1]!.surface = 99;
    expect(() => validateMalformedResult(identity)).toThrow();
  }
});
test("late ring publication and revived original work cannot pass", () => {
  const value = proof(); value.phases[4]!.service.owners[1]!.replies.head++;
  expect(() => validateMalformedResult(value)).toThrow();
  const late = proof(); late.phases[4]!.service.late!.reads = 1;
  expect(() => validateMalformedResult(late)).toThrow();
});
test("physical retirement and conservative shared-control debt are separate requirements", () => {
  const value = proof(); value.stop.physicallyStopped = false;
  expect(() => validateMalformedResult(value)).toThrow();
  const debt = proof(); debt.stop.snapshot.holders[2]!.state = "released";
  expect(() => validateMalformedResult(debt)).toThrow();
});
test("every service credit observation must be a finite integer", () => {
  for (const i of [0, 1, 2, 3, 4]) {
    const value = proof(); value.phases[i]!.before.heapBytes = NaN;
    expect(() => validateMalformedResult(value)).toThrow();
  }
});
test("the existing complete runner includes malformed isolation before ownership and fairness", () => {
  const source = readFileSync(new URL("./gpu-browser-runner.ts", import.meta.url), "utf8");
  expect(source).toContain('import { malformedCases } from "./gpu-malformed-browser.js"');
  expect(source.indexOf("await malformedCases(page")).toBeLessThan(source.indexOf("await ownershipCases(page"));
});
