import { expect, test } from "bun:test";
import type { Resource, Stream } from "../core/descriptors.ts";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { markStarted, readOutcome, claimOutcome, processOutcome } from "../proc/outcome.ts";
import { guestFixture } from "./threads-guest-fixture.ts";
import { guestModule, i32, call, store } from "./threads-guest-module.ts";

const rightsBase = 0xfedcba9876543210n;
const rightsInheriting = 0x8123456789abcdefn;
const fdstatImport = { name: "fd_fdstat_get", params: [0x7f, 0x7f] };
const query = (fd: number, out: number, index = 0) => i32(fd).concat(i32(out), call(index));
type Fixture = Awaited<ReturnType<typeof guestFixture>>;

async function run(fixture: Fixture, body: number[], poison = false) {
  const module = await compileThreadGuest(guestModule({ imports: [fdstatImport], initial: body }));
  const guest = fixture.launch(module, { kind: "initial" }, [], {}, poison);
  await guest.ready;
  guest.enter();
  await guest.idle;
  return guest;
}

function record(memory: WebAssembly.Memory, at: number) {
  const view = new DataView(memory.buffer);
  return {
    filetype: view.getUint8(at),
    flags: view.getUint16(at + 2, true),
    rightsBase: view.getBigUint64(at + 8, true),
    rightsInheriting: view.getBigUint64(at + 16, true),
  };
}

function stream(kind: Stream["kind"], fdflags = 4): Stream {
  const unexpected = (): never => {
    throw new Error("fdstat consumed a stream");
  };
  return { kind, fdflags, read: unexpected, write: unexpected, readiness: unexpected };
}

for (const kind of ["file", "directory", "pipe", "terminal", "device", "socket"] as const) {
  test(`canonical fdstat reports ${kind} without rights or I/O`, async () => {
    const fixture = await guestFixture();
    try {
      const resource: Resource =
        kind === "file"
          ? { kind, handle: fixture.resource.handle, offset: 91, append: true, fdflags: 30 }
          : kind === "directory"
            ? { kind, handle: fixture.resource.handle }
            : stream(kind);
      const fd = fixture.descriptors.open(resource, 0n, 0n);
      const entry = fixture.descriptors.get(fd)!;
      const references = entry.description.references;
      const expected = {
        kind: "ok",
        value: {
          filetype: { file: 4, directory: 3, pipe: 0, terminal: 2, device: 2, socket: 6 }[kind],
          flags: kind === "file" ? 31 : kind === "directory" ? 0 : 4,
          rightsBase: 0n,
          rightsInheriting: 0n,
        },
      };
      await run(fixture, store(32, query(fd, 256)).concat(store(36, query(fd, 280))));
      expect(record(fixture.memory, 256)).toEqual(expected.value);
      expect(record(fixture.memory, 280)).toEqual(expected.value);
      expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 2))).toEqual([0, 0]);
      expect(entry.description.references).toBe(references);
      if (resource.kind === "file") expect(resource.offset).toBe(91);
      expect(fixture.events.some((event) => event.kind === "held")).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
}

test("real guest/lane/service fdstat preserves unsigned 64-bit rights and current APPEND flags", async () => {
  const fixture = await guestFixture();
  try {
    const entry = fixture.descriptors.get(fixture.fd)!;
    entry.rightsBase = rightsBase;
    entry.rightsInheriting = rightsInheriting;
    fixture.resource.offset = 19;
    Object.assign(fixture.resource, { append: true, fdflags: 30 });
    const references = entry.description.references;
    let calls = 0;
    fixture.setAfterDispatch(() => {
      if (++calls === 1) Object.assign(fixture.resource, { append: false, fdflags: 31 });
    });
    new Uint8Array(fixture.memory.buffer, 255, 50).fill(77);
    await run(fixture, store(32, query(fixture.fd, 256)).concat(store(36, query(fixture.fd, 280))));
    expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 2))).toEqual([0, 0]);
    expect(record(fixture.memory, 256)).toEqual({
      filetype: 4,
      flags: 31,
      rightsBase,
      rightsInheriting,
    });
    expect(record(fixture.memory, 280)).toEqual({
      filetype: 4,
      flags: 30,
      rightsBase,
      rightsInheriting,
    });
    expect(new Uint8Array(fixture.memory.buffer)[255]).toBe(77);
    expect(new Uint8Array(fixture.memory.buffer)[304]).toBe(77);
    expect(fixture.resource.offset).toBe(19);
    expect(entry.description.references).toBe(references);
    expect(fixture.requests.map(({ request }) => request)).toEqual([
      { kind: "fdstat", fd: fixture.fd },
      { kind: "fdstat", fd: fixture.fd },
    ]);
    expect(fixture.failures).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("guest fdstat checks all 24 output bytes before service admission and changes no invalid span", async () => {
  const fixture = await guestFixture();
  try {
    const end = fixture.memory.buffer.byteLength;
    new Uint8Array(fixture.memory.buffer, end - 24, 24).fill(77);
    const body = store(32, query(fixture.fd, end - 23)).concat(
      store(36, query(fixture.fd, -1)),
      store(40, query(fixture.fd, -2147483648)),
      store(44, query(999, end)),
    );
    await run(fixture, body);
    expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 4))).toEqual([21, 21, 21, 21]);
    expect(Array.from(new Uint8Array(fixture.memory.buffer, end - 24, 24))).toEqual(
      Array(24).fill(77),
    );
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await fixture.dispose();
  }
});

test("guest fdstat leaves absent and closed fd output unchanged, with filestat kept distinct", async () => {
  const fixture = await guestFixture();
  try {
    fixture.descriptors.get(fixture.fd)!.rightsBase = 0n;
    const module = await compileThreadGuest(
      guestModule({
        imports: [
          fdstatImport,
          { name: "fd_close", params: [0x7f] },
          { name: "fd_filestat_get", params: [0x7f, 0x7f] },
        ],
        initial: store(32, query(999, 256)).concat(
          store(36, query(fixture.fd, 280, 2)),
          store(40, query(fixture.fd, 344)),
          i32(fixture.fd),
          call(1),
          [0x1a],
          store(44, query(fixture.fd, 368)),
        ),
      }),
    );
    new Uint8Array(fixture.memory.buffer, 256, 136).fill(77);
    const guest = fixture.launch(module, { kind: "initial" });
    await guest.ready;
    guest.enter();
    await guest.idle;
    expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 4))).toEqual([8, 76, 0, 8]);
    expect(Array.from(new Uint8Array(fixture.memory.buffer, 256, 88))).toEqual(Array(88).fill(77));
    expect(record(fixture.memory, 344).rightsBase).toBe(0n);
    expect(Array.from(new Uint8Array(fixture.memory.buffer, 368, 24))).toEqual(Array(24).fill(77));
  } finally {
    await fixture.dispose();
  }
});

test("fdstat reacquires guest memory after service resumption and shared growth", async () => {
  const fixture = await guestFixture(
    new WebAssembly.Memory({ initial: 2, maximum: 3, shared: true }),
  );
  try {
    const old = fixture.memory.buffer;
    fixture.setAfterDispatch(() => {
      fixture.memory.grow(1);
    });
    await run(fixture, store(32, query(fixture.fd, old.byteLength - 24)));
    expect(fixture.memory.buffer.byteLength).toBe(old.byteLength + 65536);
    expect(new Int32Array(fixture.memory.buffer)[8]).toBe(0);
    expect(record(fixture.memory, old.byteLength - 24).filetype).toBe(4);
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
  } finally {
    await fixture.dispose();
  }
});

for (const mode of ["closed", "failed", "terminal"] as const) {
  test(`fdstat ${mode} reply cannot publish guest output`, async () => {
    const fixture = await guestFixture();
    try {
      new Uint8Array(fixture.memory.buffer, 256, 24).fill(77);
      fixture.setAfterDispatch(() => {
        if (mode === "failed") throw new Error("injected fdstat reply failure");
        if (mode === "closed") {
          void fixture.guests[0]!.owner.retire();
          return;
        }
        claimOutcome(fixture.outcome, processOutcome({ kind: "signaled", code: 9 }));
        fixture.terminal();
      });
      await run(fixture, query(fixture.fd, 256).concat([0x1a], store(32, i32(99))));
      expect(Array.from(new Uint8Array(fixture.memory.buffer, 256, 24))).toEqual(
        Array(24).fill(77),
      );
      expect(new Int32Array(fixture.memory.buffer)[8]).toBe(0);
      expect(fixture.failures).toHaveLength(mode === "failed" ? 1 : 0);
    } finally {
      await fixture.dispose();
    }
  });
}

test("a real pipe's repeated fdstat is non-consuming and subsequent read keeps its bytes", async () => {
  const fixture = await guestFixture();
  try {
    expect(fixture.writer.tryWrite([new Uint8Array([65, 66])])).toBe(2);
    const fd = fixture.descriptors.open(fixture.reader, rightsBase, rightsInheriting);
    await run(fixture, store(32, query(fd, 256)).concat(store(36, query(fd, 280))), true);
    expect(record(fixture.memory, 256)).toEqual({
      filetype: 0,
      flags: 0,
      rightsBase,
      rightsInheriting,
    });
    expect(record(fixture.memory, 280)).toEqual(record(fixture.memory, 256));
    const bytes = new Uint8Array(2);
    expect(fixture.reader.tryRead([bytes])).toBe(2);
    expect(Array.from(bytes)).toEqual([65, 66]);
    expect(fixture.guests[0]!.events.some((event) => event.kind === "poison-armed")).toBe(true);
    expect(readOutcome(fixture.outcome)).toMatchObject({ kind: "exited", code: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("fdstat observes canonical metadata while another lane holds the same file's cold read", async () => {
  const fixture = await guestFixture();
  try {
    markStarted(fixture.outcome);
    const view = new DataView(fixture.memory.buffer);
    view.setUint32(128, 512, true);
    view.setUint32(132, 4, true);
    const reading = await compileThreadGuest(
      guestModule({
        imports: [{ name: "fd_read", params: [0x7f, 0x7f, 0x7f, 0x7f] }],
        secondary: store(32, i32(fixture.fd).concat(i32(128), i32(1), i32(160), call(0))),
      }),
    );
    const reader = fixture.launch(reading, { kind: "secondary", tid: 2, startArg: 0 });
    await reader.ready;
    reader.enter();
    await fixture.event("held");
    const entry = fixture.descriptors.get(fixture.fd)!;
    entry.rightsBase = 0n;
    const references = entry.description.references;
    const querying = await compileThreadGuest(
      guestModule({
        imports: [fdstatImport],
        secondary: store(36, query(fixture.fd, 256)),
      }),
    );
    const queryGuest = fixture.launch(querying, { kind: "secondary", tid: 3, startArg: 0 });
    await queryGuest.ready;
    queryGuest.enter();
    await queryGuest.idle;
    expect(view.getUint32(36, true)).toBe(0);
    expect(record(fixture.memory, 256).rightsBase).toBe(0n);
    expect(entry.description.references).toBe(references);
    expect(fixture.resource.offset).toBe(0);
    expect(reader.events.some((event) => event.kind === "host-idle")).toBe(false);
    fixture.send({ kind: "release" });
    await reader.idle;
    expect(view.getUint32(160, true)).toBe(4);
    expect(fixture.resource.offset).toBe(4);
  } finally {
    fixture.send({ kind: "release" });
    await fixture.dispose();
  }
});

test("remapped standard descriptors report their resource, not their descriptor number", async () => {
  const fixture = await guestFixture();
  try {
    const entry = fixture.descriptors.get(fixture.fd)!;
    fixture.descriptors.inherit(0, entry);
    fixture.descriptors.openAt(37, stream("terminal", 4), rightsBase, rightsInheriting);
    await run(fixture, store(32, query(0, 256)).concat(store(36, query(37, 280))));
    expect(record(fixture.memory, 256).filetype).toBe(4);
    expect(record(fixture.memory, 280)).toEqual({
      filetype: 2,
      flags: 4,
      rightsBase,
      rightsInheriting,
    });
    expect(Array.from(new Int32Array(fixture.memory.buffer, 32, 2))).toEqual([0, 0]);
  } finally {
    await fixture.dispose();
  }
});
