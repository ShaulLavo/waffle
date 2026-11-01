import { expect, test } from "bun:test";
import { createSupervisedWaitImports, type CapturedWaitRegistration } from "../interrupt/wait.ts";
import { ThreadWaitOwner } from "../thread/lane.ts";

function fixture() {
  const thread = { directory: "wait-owner", pid: 17, tid: 2 };
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
  const waits = new Int32Array(new SharedArrayBuffer(12));
  const retained = new Set<CapturedWaitRegistration>();
  const released: number[] = [];
  const failures: unknown[] = [];
  let terminal = false;
  const owner = new ThreadWaitOwner({
    thread,
    memory,
    waits,
    terminal: () => terminal,
    retain(registration) {
      retained.add(registration);
      return () => {
        retained.delete(registration);
        released.push(registration.generation);
      };
    },
    failed: (cause) => {
      failures.push(cause);
    },
  });
  const register = (generation: number, buffer = memory.buffer) => {
    if (!(buffer instanceof SharedArrayBuffer)) throw new Error("shared fixture required");
    return {
      kind: "wait-registered",
      thread,
      registration: { generation, address: 8, width: 8, buffer },
    };
  };
  const clear = (generation: number) => owner.receive({ kind: "wait-cleared", thread, generation });
  const idle = () => owner.receive({ kind: "host-idle", thread });
  return {
    thread,
    memory,
    waits,
    retained,
    released,
    failures,
    owner,
    register,
    clear,
    idle,
    terminal: () => {
      terminal = true;
      owner.beginTerminal();
    },
  };
}

test("parked-buffer aliases retire only for their generation and exact thread incarnation", () => {
  const f = fixture();
  try {
    const first = f.register(1);
    expect(f.owner.receive(first)).toBe(true);
    expect(f.retained.size).toBe(1);
    expect(
      f.owner.receive({ kind: "wait-cleared", thread: { ...f.thread, pid: 18 }, generation: 1 }),
    ).toBe(false);
    f.clear(1);
    expect(f.memory.grow(1)).toBe(1);
    const second = f.register(2);
    expect(f.owner.receive(second)).toBe(true);
    f.clear(1);
    expect(f.retained.size).toBe(1);
    expect(f.owner.receive(first)).toBe(false);
    expect(f.released).toEqual([1]);
    f.clear(2);
    f.clear(2);
    expect(f.retained.size).toBe(0);
    expect(f.released).toEqual([1, 2]);
    f.idle();
    expect(f.owner.receive(f.register(3))).toBe(false);
  } finally {
    f.idle();
  }
});

test("a clear received before a delayed registration prevents resurrecting its buffer", () => {
  const f = fixture();
  try {
    f.clear(2);
    expect(f.owner.receive(f.register(2))).toBe(false);
    expect(f.owner.receive(f.register(1))).toBe(false);
    expect(f.retained.size).toBe(0);
    expect(f.owner.receive(f.register(3))).toBe(true);
    f.idle();
    expect(f.released).toEqual([3]);
  } finally {
    f.idle();
  }
});

test("failed teardown retains the parked alias and reports once rather than inventing idle", () => {
  const f = fixture();
  f.owner.receive(f.register(1));
  f.terminal();
  f.owner.fail(new Error("native stop unconfirmed"));
  f.owner.fail(new Error("duplicate stop failure"));
  expect(f.retained.size).toBe(1);
  expect(f.released).toEqual([]);
  expect(f.failures).toHaveLength(1);
  f.idle();
  expect(f.released).toEqual([1]);
});

test("the wait import captures one buffer before registration and a sibling's growth", () => {
  const f = fixture();
  const old = f.memory.buffer;
  const registrations: CapturedWaitRegistration[] = [];
  const clears: number[] = [];
  const imports = createSupervisedWaitImports(f.memory, f.waits, () => 0, {
    registered(registration) {
      registrations.push(registration);
      f.memory.grow(1);
    },
    cleared: (generation) => {
      clears.push(generation);
    },
  });
  expect(imports.__waffle_wait64(8, 1n, 0n, 0)).toBe(1);
  expect(Object.is(registrations[0]?.buffer, old)).toBe(true);
  expect(Object.is(registrations[0]?.buffer, f.memory.buffer)).toBe(false);
  expect(clears).toEqual([1]);
  expect(Atomics.load(f.waits, 0)).toBe(0);
});

for (const failure of ["retain", "release"] as const) {
  test(`failed wait ${failure} keeps ownership as debt and never retries a receipt`, () => {
    const thread = { directory: "debt", pid: 1, tid: 2 };
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const buffer = memory.buffer;
    if (!(buffer instanceof SharedArrayBuffer)) throw new Error("shared memory required");
    let releases = 0;
    const failures: unknown[] = [];
    const owner = new ThreadWaitOwner({
      thread,
      memory,
      waits: new Int32Array(new SharedArrayBuffer(12)),
      terminal: () => false,
      retain() {
        if (failure === "retain") throw new Error("retention failed");
        return () => {
          releases++;
          throw new Error("release failed");
        };
      },
      failed: (cause) => {
        failures.push(cause);
      },
    });
    owner.receive({
      kind: "wait-registered",
      thread,
      registration: { generation: 1, address: 8, width: 8, buffer },
    });
    owner.receive({ kind: "wait-cleared", thread, generation: 1 });
    owner.receive({ kind: "wait-cleared", thread, generation: 1 });
    owner.receive({ kind: "host-idle", thread });
    expect(failures).toHaveLength(1);
    expect(releases).toBe(failure === "retain" ? 0 : 1);
  });
}
