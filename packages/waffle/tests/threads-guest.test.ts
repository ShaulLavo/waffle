import { describe, expect, test } from "bun:test";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { claimOutcome, markStarted, processOutcome, readOutcome } from "../proc/outcome.ts";
import { readWaitRegistration } from "../interrupt/wait.ts";
import { guestFixture } from "./threads-guest-fixture.ts";
import { guestModule, i32, call, store, notify, wait32, wait64 } from "./threads-guest-module.ts";

const writeImport = { name: "fd_write", params: [0x7f, 0x7f, 0x7f, 0x7f] };
const exitImport = { name: "proc_exit", params: [0x7f], result: false };
const write = (fd: number, out = 160) =>
  i32(fd).concat(i32(128), i32(1), i32(out), call(0), [0x1a]);
function payload(memory: WebAssembly.Memory, value = "child\n") {
  const data = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, 256, data.length).set(data);
  const view = new DataView(memory.buffer);
  view.setUint32(128, 256, true);
  view.setUint32(132, data.length, true);
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("guest observation timed out");
    await Bun.sleep(1);
  }
}

describe("thread guest bridge", () => {
  test("blocked parent admits a real child; spawn commits at ready, not user entry", async () => {
    const fixture = await guestFixture();
    try {
      payload(fixture.memory);
      fixture.descriptors.renumber(fixture.writerFd, 1);
      const module = await compileThreadGuest(
        guestModule({
          imports: [writeImport, { module: "wasi", name: "thread-spawn", params: [0x7f] }],
          initial: store(16, i32(-2147483648).concat(call(1))).concat(
            store(8, i32(1)),
            notify(8),
            wait32(0),
          ),
          secondary: wait32(8).concat(
            store(20, [0x20, 0]),
            store(24, [0x20, 1]),
            write(1),
            store(0, i32(1)),
            notify(0),
          ),
        }),
      );
      fixture.setSpawn(async (startArg) => {
        const child = fixture.launch(module, { kind: "secondary", tid: 2, startArg });
        await child.ready;
        expect(new Int32Array(fixture.memory.buffer)[8 / 4]).toBe(0);
        child.enter();
        return 2;
      });
      const parent = fixture.launch(module, { kind: "initial" });
      await parent.ready;
      expect(fixture.requests).toHaveLength(0);
      parent.enter();
      await parent.idle;
      await fixture.guests[1]!.idle;
      const words = new Uint32Array(fixture.memory.buffer);
      expect(words[4]).toBe(2);
      expect(words[5]).toBe(2);
      expect(words[6]).toBe(0x80000000);
      const bytes = new Uint8Array(6);
      expect(fixture.reader.tryRead([bytes])).toBe(6);
      expect(new TextDecoder().decode(bytes)).toBe("child\n");
      expect(fixture.requests.map(({ call }) => call.thread.tid)).toEqual([1, 2]);
      expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
      expect(fixture.failures).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test("normal secondary return leaves canonical stdout and file descriptors live", async () => {
    const fixture = await guestFixture();
    try {
      markStarted(fixture.outcome);
      payload(fixture.memory);
      fixture.descriptors.renumber(fixture.writerFd, 1);
      const module = await compileThreadGuest(
        guestModule({ imports: [writeImport], secondary: write(1) }),
      );
      const first = fixture.launch(module, { kind: "secondary", tid: 2, startArg: 0 });
      await first.ready;
      first.enter();
      await first.idle;
      expect(first.events.map((event) => event.kind)).toEqual([
        "ready",
        "thread-returned",
        "host-idle",
      ]);
      expect(readOutcome(fixture.outcome)).toBeNull();
      expect(fixture.descriptors.get(fixture.fd)).toBeDefined();
      const second = fixture.launch(module, { kind: "secondary", tid: 3, startArg: 0 });
      await second.ready;
      second.enter();
      await second.idle;
      const bytes = new Uint8Array(12);
      expect(fixture.reader.tryRead([bytes.subarray(0, 6)])).toBe(6);
      expect(fixture.reader.tryRead([bytes.subarray(6)])).toBe(6);
      expect(new TextDecoder().decode(bytes)).toBe("child\nchild\n");
    } finally {
      await fixture.dispose();
    }
  });

  test("secondary exit zero wakes a parked initial wait64 without destructive disposal", async () => {
    const fixture = await guestFixture();
    try {
      const module = await compileThreadGuest(
        guestModule({
          imports: [exitImport],
          initial: wait64(0),
          secondary: i32(0).concat(call(0)),
        }),
      );
      const parent = fixture.launch(module, { kind: "initial" });
      await parent.ready;
      parent.enter();
      await until(() => readWaitRegistration(parent.waits)?.width === 8);
      const child = fixture.launch(module, { kind: "secondary", tid: 2, startArg: 0 });
      await child.ready;
      child.enter();
      await child.idle;
      await parent.idle;
      expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
      expect(child.events.some((event) => event.kind === "thread-returned")).toBe(false);
      expect(readWaitRegistration(parent.waits)).toBeNull();
      expect(fixture.descriptors.get(fixture.fd)).toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  for (const kind of ["initial", "secondary"] as const) {
    test(`${kind} start-section exit never publishes ready or enters exports`, async () => {
      const fixture = await guestFixture();
      try {
        if (kind === "secondary") markStarted(fixture.outcome);
        const module = await compileThreadGuest(
          guestModule({
            imports: [exitImport],
            start: i32(0).concat(call(0)),
            initial: store(64, i32(99)),
            secondary: store(64, i32(99)),
          }),
        );
        const guest = fixture.launch(
          module,
          kind === "initial" ? { kind } : { kind, tid: 2, startArg: 0 },
        );
        await guest.idle;
        expect(guest.events.map((event) => event.kind)).toEqual([
          "process-terminal",
          "process-terminal",
          "host-idle",
        ]);
        expect(new Int32Array(fixture.memory.buffer)[16]).toBe(0);
        expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
      } finally {
        await fixture.dispose();
      }
    });
  }

  test("compiler start-section waits are supervised before ready", async () => {
    const fixture = await guestFixture();
    try {
      const module = await compileThreadGuest(
        guestModule({ start: wait64(0), initial: store(64, i32(99)) }),
      );
      const guest = fixture.launch(module, { kind: "initial" });
      await until(() => readWaitRegistration(guest.waits)?.width === 8);
      expect(guest.events).toEqual([]);
      claimOutcome(fixture.outcome, processOutcome({ kind: "signaled", code: 9 }));
      fixture.terminal();
      await guest.idle;
      expect(new Int32Array(fixture.memory.buffer)[16]).toBe(0);
      expect(guest.events.some((event) => event.kind === "ready")).toBe(false);
      expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "signaled", code: 9 });
    } finally {
      await fixture.dispose();
    }
  });

  test("unknown imports fail honestly and cannot run a later entry", async () => {
    const fixture = await guestFixture();
    try {
      const module = await compileThreadGuest(
        guestModule({ imports: [{ name: "path_open", params: [] }], initial: store(64, i32(99)) }),
      );
      const guest = fixture.launch(module, { kind: "initial" });
      await guest.idle;
      expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "start-failed" });
      expect(guest.events.some((event) => event.kind === "ready")).toBe(false);
      expect(new Int32Array(fixture.memory.buffer)[16]).toBe(0);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });

  test("terminal after ready closes entry permission", async () => {
    const fixture = await guestFixture();
    try {
      const module = await compileThreadGuest(guestModule({ initial: store(64, i32(99)) }));
      const guest = fixture.launch(module, { kind: "initial" });
      await guest.ready;
      claimOutcome(fixture.outcome, processOutcome({ kind: "signaled", code: 9 }));
      fixture.terminal();
      guest.enter();
      await guest.idle;
      expect(new Int32Array(fixture.memory.buffer)[16]).toBe(0);
      expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "signaled", code: 9 });
    } finally {
      await fixture.dispose();
    }
  });

  test("negative spawn is failure, never an uncreated successful thread", async () => {
    const fixture = await guestFixture();
    try {
      const module = await compileThreadGuest(
        guestModule({
          imports: [{ module: "wasi", name: "thread-spawn", params: [0x7f] }],
          initial: store(64, i32(88).concat(call(0))),
        }),
      );
      const guest = fixture.launch(module, { kind: "initial" });
      await guest.ready;
      guest.enter();
      await guest.idle;
      expect(new Int32Array(fixture.memory.buffer)[16]).toBe(-6);
      expect(fixture.guests).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
});

test("ordinary precompiled modules cannot bypass supervised wait admission", async () => {
  const fixture = await guestFixture();
  try {
    const guest = fixture.launch(
      new WebAssembly.Module(guestModule({ initial: store(64, i32(99)) })),
      { kind: "initial" },
    );
    await guest.idle;
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "start-failed" });
    expect(guest.events.some((event) => event.kind === "ready")).toBe(false);
    expect(new Int32Array(fixture.memory.buffer)[16]).toBe(0);
  } finally {
    await fixture.dispose();
  }
});
