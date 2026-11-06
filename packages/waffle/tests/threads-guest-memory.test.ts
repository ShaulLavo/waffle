import { expect, test } from "bun:test";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { claimOutcome, markStarted, processOutcome, readOutcome } from "../proc/outcome.ts";
import { guestFixture } from "./threads-guest-fixture.ts";
import { guestModule, i32, i64, call, store } from "./threads-guest-module.ts";

const ioImport = (name: string) => ({ name, params: [0x7f, 0x7f, 0x7f, 0x7f] });
const invoke = (fd: number, iovs = 128, count = 1, out = 160) =>
  i32(fd).concat(i32(iovs), i32(count), i32(out), call(0));
function iovec(memory: WebAssembly.Memory, address = 256, size = 4) {
  const view = new DataView(memory.buffer);
  view.setUint32(128, address, true);
  view.setUint32(132, size, true);
}
async function run(
  fixture: Awaited<ReturnType<typeof guestFixture>>,
  initial: number[],
  imports = [ioImport("fd_write")],
) {
  const module = await compileThreadGuest(guestModule({ imports, initial }));
  const guest = fixture.launch(module, { kind: "initial" });
  await guest.ready;
  guest.enter();
  await guest.idle;
  return guest;
}

test("invalid iovec/output spans reject before service effects, including signed wasm32 pointers", async () => {
  const fixture = await guestFixture();
  try {
    iovec(fixture.memory);
    const body = store(32, invoke(fixture.writerFd, 128, 1, -1)).concat(
      store(36, invoke(fixture.writerFd, -2147483648)),
      store(40, invoke(fixture.writerFd, 128, -1)),
    );
    await run(fixture, body);
    expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 3))).toEqual([21, 21, 21]);
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.reader.tryRead([new Uint8Array(4)])).toBe(-6);
  } finally {
    await fixture.dispose();
  }
});

test("regular-file read traverses the real delayed FS service while a sibling writes stdout", async () => {
  const fixture = await guestFixture();
  try {
    markStarted(fixture.outcome);
    iovec(fixture.memory);
    const read = await compileThreadGuest(
      guestModule({ imports: [ioImport("fd_read")], secondary: store(32, invoke(fixture.fd)) }),
    );
    const blocked = fixture.launch(read, { kind: "secondary", tid: 2, startArg: 0 });
    await blocked.ready;
    blocked.enter();
    await fixture.event("held");
    expect(blocked.events.some((event) => event.kind === "host-idle")).toBe(false);
    iovec(fixture.memory, 300, 4);
    new Uint8Array(fixture.memory.buffer, 300, 4).set([66, 67, 68, 69]);
    // The read has copied its original iovec metadata before the sibling changes it.
    const write = await compileThreadGuest(
      guestModule({
        imports: [ioImport("fd_write")],
        secondary: store(36, invoke(fixture.writerFd, 128, 1, 164)),
      }),
    );
    const sibling = fixture.launch(write, { kind: "secondary", tid: 3, startArg: 0 });
    await sibling.ready;
    sibling.enter();
    await sibling.idle;
    const bytes = new Uint8Array(4);
    expect(fixture.reader.tryRead([bytes])).toBe(4);
    expect(Array.from(bytes)).toEqual([66, 67, 68, 69]);
    expect(new Uint32Array(fixture.memory.buffer)[36 / 4]).toBe(0);
    fixture.send({ kind: "release" });
    await blocked.idle;
    expect(Array.from(new Uint8Array(fixture.memory.buffer, 256, 4))).toEqual([65, 65, 65, 65]);
    expect(new Uint32Array(fixture.memory.buffer)[160 / 4]).toBe(4);
    expect(fixture.resource.offset).toBe(4);
    expect(fixture.failures).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("terminal with a pending cold read fences late guest-memory publication", async () => {
  const fixture = await guestFixture();
  try {
    iovec(fixture.memory);
    new Uint8Array(fixture.memory.buffer, 160, 4).fill(77);
    new Uint8Array(fixture.memory.buffer, 256, 4).fill(88);
    const module = await compileThreadGuest(
      guestModule({ imports: [ioImport("fd_read")], initial: store(32, invoke(fixture.fd)) }),
    );
    const guest = fixture.launch(module, { kind: "initial" });
    await guest.ready;
    guest.enter();
    await fixture.event("held");
    claimOutcome(fixture.outcome, processOutcome({ kind: "signaled", code: 9 }));
    fixture.terminal();
    fixture.send({ kind: "release" });
    await guest.idle;
    await fixture.service.drain();
    await guest.owner.retire();
    expect(Array.from(new Uint8Array(fixture.memory.buffer, 160, 4))).toEqual([77, 77, 77, 77]);
    expect(Array.from(new Uint8Array(fixture.memory.buffer, 256, 4))).toEqual([88, 88, 88, 88]);
    expect(new Uint32Array(fixture.memory.buffer)[32 / 4]).toBe(0);
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "signaled", code: 9 });
  } finally {
    await fixture.dispose();
  }
});

test("seek/tell/stat use canonical state and preserve offsets larger than signed i32", async () => {
  const fixture = await guestFixture();
  try {
    const imports = [
      { name: "fd_seek", params: [0x7f, 0x7e, 0x7f, 0x7f] },
      { name: "fd_tell", params: [0x7f, 0x7f] },
      { name: "fd_filestat_get", params: [0x7f, 0x7f] },
    ];
    await run(
      fixture,
      i32(fixture.fd).concat(
        i64(0x100000004n),
        i32(0),
        i32(160),
        call(0),
        [0x1a],
        i32(fixture.fd),
        i32(168),
        call(1),
        [0x1a],
        i32(fixture.fd),
        i32(256),
        call(2),
        [0x1a],
      ),
      imports,
    );
    const view = new DataView(fixture.memory.buffer);
    expect(view.getBigUint64(160, true)).toBe(0x100000004n);
    expect(view.getBigUint64(168, true)).toBe(0x100000004n);
    expect(view.getUint8(256 + 16)).toBe(4);
    expect(view.getBigUint64(256 + 32, true)).toBe(65536n);
  } finally {
    await fixture.dispose();
  }
});

test("argument and environment helpers validate the complete output before any write", async () => {
  const fixture = await guestFixture();
  try {
    const module = await compileThreadGuest(
      guestModule({
        imports: [
          { name: "args_get", params: [0x7f, 0x7f] },
          { name: "environ_get", params: [0x7f, 0x7f] },
          { name: "args_sizes_get", params: [0x7f, 0x7f] },
        ],
        initial: store(32, i32(128).concat(i32(131070), call(0))).concat(
          store(36, i32(132).concat(i32(131070), call(1))),
          store(40, i32(136).concat(i32(-1), call(2))),
        ),
      }),
    );
    new Uint8Array(fixture.memory.buffer, 128, 12).fill(77);
    const guest = fixture.launch(module, { kind: "initial" }, ["long argument"], { TEST: "value" });
    await guest.ready;
    guest.enter();
    await guest.idle;
    expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 3))).toEqual([21, 21, 21]);
    expect(Array.from(new Uint8Array(fixture.memory.buffer, 128, 12))).toEqual(
      Array.from({ length: 12 }, () => 77),
    );
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await fixture.dispose();
  }
});

for (const failure of ["closed", "failed", "terminal"] as const) {
  test(`${failure} service retirement prevents late scalar output publication`, async () => {
    const fixture = await guestFixture();
    try {
      new Uint8Array(fixture.memory.buffer, 160, 8).fill(77);
      fixture.setAfterDispatch(() => {
        if (failure === "failed") throw new Error("injected service reply failure");
        if (failure === "terminal") {
          claimOutcome(fixture.outcome, processOutcome({ kind: "exited", code: 0 }));
          fixture.terminal();
          return;
        }
        void fixture.guests[0]!.owner.retire();
      });
      await run(fixture, i32(fixture.fd).concat(i32(160), call(0), [0x1a], store(32, i32(99))), [
        { name: "fd_tell", params: [0x7f, 0x7f] },
      ]);
      expect(Array.from(new Uint8Array(fixture.memory.buffer, 160, 8))).toEqual(
        Array.from({ length: 8 }, () => 77),
      );
      expect(new Uint32Array(fixture.memory.buffer)[32 / 4]).toBe(0);
      expect(fixture.failures).toHaveLength(failure === "failed" ? 1 : 0);
      if (failure === "terminal")
        expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
    } finally {
      await fixture.dispose();
    }
  });
}

test("captured lane and local imports still work after guest native replacement", async () => {
  const fixture = await guestFixture();
  try {
    iovec(fixture.memory);
    new Uint8Array(fixture.memory.buffer, 256, 4).set([65, 66, 67, 68]);
    const module = await compileThreadGuest(
      guestModule({
        imports: [
          ioImport("fd_write"),
          { name: "args_sizes_get", params: [0x7f, 0x7f] },
          { name: "args_get", params: [0x7f, 0x7f] },
          { name: "environ_get", params: [0x7f, 0x7f] },
          { name: "clock_time_get", params: [0x7f, 0x7e, 0x7f] },
          { name: "random_get", params: [0x7f, 0x7f] },
        ],
        initial: store(32, invoke(fixture.writerFd)).concat(
          i32(64),
          i32(68),
          call(1),
          [0x1a],
          i32(72),
          i32(512),
          call(2),
          [0x1a],
          i32(76),
          i32(576),
          call(3),
          [0x1a],
          i32(1),
          i64(0n),
          i32(80),
          call(4),
          [0x1a],
          i32(1024),
          i32(64),
          call(5),
          [0x1a],
        ),
      }),
    );
    const guest = fixture.launch(
      module,
      { kind: "initial" },
      ["snapshot"],
      { TEST: "value" },
      true,
    );
    await guest.ready;
    guest.enter();
    await guest.idle;
    const view = new DataView(fixture.memory.buffer);
    expect(guest.events.some((event) => event.kind === "poison-armed")).toBe(true);
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
    expect(view.getUint32(64, true)).toBe(1);
    expect(view.getUint32(68, true)).toBe(9);
    expect(new TextDecoder().decode(new Uint8Array(fixture.memory.buffer, 512, 9))).toBe(
      "snapshot\0",
    );
    expect(new TextDecoder().decode(new Uint8Array(fixture.memory.buffer, 576, 11))).toBe(
      "TEST=value\0",
    );
    expect(view.getBigUint64(80, true)).toBeGreaterThan(0n);
    expect(
      Array.from(new Uint8Array(fixture.memory.buffer, 1024, 64)).some((byte) => byte !== 0),
    ).toBe(true);
    const bytes = new Uint8Array(4);
    expect(fixture.reader.tryRead([bytes])).toBe(4);
    expect(Array.from(bytes)).toEqual([65, 66, 67, 68]);
  } finally {
    await fixture.dispose();
  }
});
