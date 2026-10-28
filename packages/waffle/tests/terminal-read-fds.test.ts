import { expect, test } from "bun:test";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";
import { claimOutcome } from "../proc/outcome.js";
import { nonblockGuest } from "./fixtures/wasi-nonblock.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw Error(result.code);
  return result.value;
}

function fixture() {
  const root = createWorkerProcessTransport();
  const input = createTerminalInput({ capacity: 64 });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const writes: [number, number][] = [];
  const policy = createTerminalInputPolicy({
    input,
    tryWrite(target, chunks) {
      const count = chunks.reduce((total, chunk) => total + chunk.length, 0);
      writes.push([target, count]);
      return count;
    },
    outputReadiness: () => ({ writable: true }),
  });
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    checkActive() {},
    policy,
  });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  const group = must(authority.createGroup({ initialMode: "raw" }));
  const member = must(authority.admitExisting({ group, pid: root.pid }));
  const lease = must(authority.acquire({ group, expected: null }));
  const streams = { 0: attachment.resolve(0), 1: attachment.resolve(1), 2: attachment.resolve(2) };
  for (const target of [0, 1, 2] as const) streams[target].fdflags = 4;
  const guest = nonblockGuest(streams);
  for (const fd of [0, 1, 2]) expect(guest.call("fd_fdstat_set_flags", fd, 4)).toBe(0);
  return {
    root,
    input,
    display,
    authority,
    member,
    group,
    lease,
    streams,
    guest,
    writes,
    cleanup() {
      try {
        guest.wasi.descriptors.dispose();
      } finally {
        attachment.dispose();
        display.close("disposed");
      }
    },
  };
}

test("real WASI fd 0/1/2 reads and readiness share one foreground input cursor", () => {
  const f = fixture();
  try {
    expect(f.input.push(new TextEncoder().encode("abcdef"))).toBe(6);
    const sequence = [1, 0, 2, 2, 1, 0];
    const read: number[] = [];
    for (const [index, fd] of sequence.entries()) {
      for (const target of [0, 1, 2] as const)
        expect(f.streams[target].readiness()).toMatchObject({
          readable: true,
          nbytes: 6 - index,
          writable: target !== 0,
        });
      expect(f.guest.io("fd_read", fd)).toBe(0);
      expect(f.guest.view.getUint32(264, true)).toBe(1);
      read.push(new Uint8Array(f.guest.memory.buffer)[4096]!);
      expect(f.input.available()).toBe(5 - index);
    }
    expect(new TextDecoder().decode(new Uint8Array(read))).toBe("abcdef");
    for (const target of [0, 1, 2] as const) {
      expect(f.streams[target].readiness().readable).toBe(false);
      expect(f.guest.io("fd_read", target)).toBe(6);
    }
    f.input.close();
    for (const target of [0, 1, 2] as const) {
      expect(f.streams[target].readiness().readable).toBe(true);
      expect(f.guest.io("fd_read", target)).toBe(0);
      expect(f.guest.view.getUint32(264, true)).toBe(0);
    }
    expect(f.guest.io("fd_write", 0)).toBe(8);
    expect(f.guest.io("fd_write", 1)).toBe(0);
    expect(f.guest.io("fd_write", 2)).toBe(0);
    expect(f.writes).toEqual([
      [1, 1],
      [2, 1],
    ]);
  } finally {
    f.cleanup();
  }
});

for (const target of [0, 1, 2] as const)
  test(`WASI requires FD_READ on terminal fd ${target} without consuming input`, () => {
    const f = fixture();
    try {
      expect(f.input.push(new Uint8Array([65]))).toBe(1);
      const entry = f.guest.wasi.descriptors.get(target)!;
      expect(
        f.guest.call(
          "fd_fdstat_set_rights",
          target,
          entry.rightsBase & ~2n,
          entry.rightsInheriting,
        ),
      ).toBe(0);
      expect(f.guest.io("fd_read", target)).toBe(76);
      expect(f.guest.view.getUint32(264, true)).toBe(0xabcdef);
      expect(f.input.available()).toBe(1);
      expect(f.guest.io("fd_read", target === 0 ? 1 : 0)).toBe(0);
      expect(f.input.available()).toBe(0);
    } finally {
      f.cleanup();
    }
  });

for (const denied of ["background", "removed member", "dead process"] as const)
  test(`all terminal read targets preserve the ${denied} guard`, () => {
    const f = fixture();
    try {
      expect(f.input.push(new Uint8Array([65]))).toBe(1);
      if (denied === "background") must(f.authority.release({ lease: f.lease, restore: null }));
      if (denied === "removed member") must(f.authority.removeMember(f.member.member));
      if (denied === "dead process")
        claimOutcome(workerProcessState(f.root).signals.outcome, { kind: "signaled", code: 9 });
      for (const target of [0, 1, 2] as const) {
        expect(f.streams[target].readiness().readable).toBe(false);
        expect(f.guest.io("fd_read", target)).toBe(denied === "dead process" ? 8 : 6);
        expect(f.input.available()).toBe(1);
      }
    } finally {
      f.cleanup();
    }
  });
