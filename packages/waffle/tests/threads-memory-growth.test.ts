import { expect, test } from "bun:test";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { claimOutcome, markStarted, processOutcome, readOutcome } from "../proc/outcome.ts";
import { guestFixture } from "./threads-guest-fixture.ts";
import { guestModule, i32, call, store, wait32, wait64 } from "./threads-guest-module.ts";

const grow = () => store(24, i32(1).concat([0x40, 0]));
const ioImport = (name: string) => ({ name, params: [0x7f, 0x7f, 0x7f, 0x7f] });
const exitImport = { name: "proc_exit", params: [0x7f], result: false };
const address = 2 * 65536 + 256;
const count = address + 8;
function invoke(fd: number, index = 0) {
  return i32(fd).concat(i32(128), i32(1), i32(count), call(index));
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("growth guest observation timed out");
    await Bun.sleep(1);
  }
}
async function secondary(
  fixture: Awaited<ReturnType<typeof guestFixture>>,
  module: WebAssembly.Module,
  tid: number,
) {
  const guest = fixture.launch(module, { kind: "secondary", tid, startArg: 0 });
  await guest.ready;
  guest.enter();
  await guest.idle;
  return guest;
}

test("native guest growth supports service I/O above the old boundary and refreshes after sibling growth", async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const old = memory.buffer;
  const fixture = await guestFixture(memory);
  try {
    markStarted(fixture.outcome);
    const body = grow().concat(
      store(128, i32(address)),
      store(132, i32(4)),
      store(address, i32(0x44434241)),
      store(32, invoke(fixture.writerFd)),
      store(36, invoke(fixture.fd, 1)),
    );
    const module = await compileThreadGuest(
      guestModule({
        imports: [ioImport("fd_write"), ioImport("fd_read")],
        secondary: body,
      }),
    );
    const guest = fixture.launch(module, { kind: "secondary", tid: 2, startArg: 0 });
    await guest.ready;
    guest.enter();
    await fixture.event("held");
    expect(old.byteLength).toBe(131072);
    expect(memory.buffer.byteLength).toBe(196608);
    const output = new Uint8Array(4);
    expect(fixture.reader.tryRead([output])).toBe(4);
    expect(Array.from(output)).toEqual([65, 66, 67, 68]);
    const sibling = await compileThreadGuest(guestModule({ secondary: grow() }));
    await secondary(fixture, sibling, 3);
    expect(memory.buffer.byteLength).toBe(262144);
    fixture.send({ kind: "release" });
    await guest.idle;
    expect(new DataView(memory.buffer).getUint32(count, true)).toBe(4);
    expect(Array.from(new Uint8Array(memory.buffer, address, 4))).toEqual([65, 65, 65, 65]);
    expect(Array.from(new Uint32Array(memory.buffer, 32, 2))).toEqual([0, 0]);
    expect(fixture.failures).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

for (const width of [4, 8] as const) {
  for (const outcome of ["exit-zero", "kill"] as const) {
    test(`wait${width * 8} keeps its captured SAB across sibling growth and ${outcome}`, async () => {
      const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
      const fixture = await guestFixture(memory);
      try {
        const initial = await compileThreadGuest(
          guestModule({
            initial: (width === 4 ? wait32(0) : wait64(0)).concat(store(64, i32(99))),
          }),
        );
        const parent = fixture.launch(initial, { kind: "initial" });
        await parent.ready;
        parent.enter();
        await until(() => parent.events.some((event) => event.kind === "wait-registered"));
        const registration = parent.events.find((event) => event.kind === "wait-registered");
        if (registration?.kind !== "wait-registered")
          throw new Error("missing native wait registration");
        expect(registration.registration.bytes).toBe(131072);
        const sibling = await compileThreadGuest(guestModule({ secondary: grow() }));
        await secondary(fixture, sibling, 2);
        expect(memory.buffer.byteLength).toBe(196608);
        expect(registration.registration.bytes).toBe(131072);
        expect(fixture.retainedWaits.size).toBe(1);
        expect(parent.events.some((event) => event.kind === "host-idle")).toBe(false);
        if (outcome === "exit-zero") {
          const exit = await compileThreadGuest(
            guestModule({ imports: [exitImport], secondary: i32(0).concat(call(0)) }),
          );
          await secondary(fixture, exit, 3);
        } else {
          claimOutcome(fixture.outcome, processOutcome({ kind: "signaled", code: 9 }));
          fixture.terminal();
        }
        await parent.idle;
        expect(readOutcome(fixture.outcome)).toMatchObject(
          outcome === "exit-zero" ? { kind: "exited", code: 0 } : { kind: "signaled", code: 9 },
        );
        expect(new Uint32Array(memory.buffer)[16]).toBe(0);
        expect(fixture.retainedWaits.size).toBe(0);
        expect(fixture.descriptors.get(fixture.fd)).toBeDefined();
        expect(fixture.failures).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    });
  }
}

test("start-section wait captures its buffer before ready and cannot enter after grown-memory exit zero", async () => {
  const fixture = await guestFixture(
    new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true }),
  );
  try {
    const module = await compileThreadGuest(
      guestModule({ start: wait64(0), initial: store(64, i32(99)) }),
    );
    const guest = fixture.launch(module, { kind: "initial" });
    await until(() => guest.events.some((event) => event.kind === "wait-registered"));
    expect(guest.events.some((event) => event.kind === "ready")).toBe(false);
    const sibling = await compileThreadGuest(
      guestModule({ imports: [exitImport], secondary: grow().concat(i32(0), call(0)) }),
    );
    await secondary(fixture, sibling, 2);
    await guest.idle;
    expect(fixture.memory.buffer.byteLength).toBe(196608);
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
    expect(new Uint32Array(fixture.memory.buffer)[16]).toBe(0);
    expect(fixture.retainedWaits.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

test("cancel after growth prevents late payload and scalar writes above the old boundary", async () => {
  const fixture = await guestFixture(
    new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true }),
  );
  try {
    const module = await compileThreadGuest(
      guestModule({
        imports: [ioImport("fd_read")],
        initial: grow().concat(
          store(128, i32(address)),
          store(132, i32(4)),
          store(address, i32(0x55555555)),
          store(count, i32(0x77777777)),
          store(32, invoke(fixture.fd)),
          store(64, i32(99)),
        ),
      }),
    );
    const guest = fixture.launch(module, { kind: "initial" });
    await guest.ready;
    guest.enter();
    await fixture.event("held");
    const sibling = await compileThreadGuest(guestModule({ secondary: grow() }));
    await secondary(fixture, sibling, 2);
    claimOutcome(fixture.outcome, processOutcome({ kind: "exited", code: 0 }));
    fixture.terminal();
    fixture.send({ kind: "release" });
    await guest.idle;
    await fixture.service.drain();
    await guest.owner.retire();
    const view = new DataView(fixture.memory.buffer);
    expect(view.getUint32(address, true)).toBe(0x55555555);
    expect(view.getUint32(count, true)).toBe(0x77777777);
    expect(view.getUint32(64, true)).toBe(0);
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
  } finally {
    await fixture.dispose();
  }
});
