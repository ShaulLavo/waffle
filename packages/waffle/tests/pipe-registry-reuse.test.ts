import { expect, test } from "bun:test";
import * as production from "../proc/pipes.js";
import { PipeRealm } from "./fixtures/pipe-interleave.ts";
import { workerMessage } from "./fixtures/worker-message.ts";

// Registry cells are reused once their last hold drops. These tests pin down the one rule that
// makes reuse safe: nothing that can still act on a cell (a paused operation, a retained
// endpoint, a delayed revoke, a dead Worker) ever reaches the cell's next occupant.
type Pipes = typeof production;
type Registry = InstanceType<Pipes["PipePublicationRegistry"]>;
type Controller = InstanceType<Pipes["PipeController"]>;
type Endpoint = ReturnType<Controller["retain"]>;
type Handle = production.PipeEndpointHandle;

const { PipeErrno, PipePublicationRegistry, attachPipeEndpoint, pipeLayoutOf, pipeRingOffset } =
  production;

/** Cell index behind one ring's mapping word: 0 published, 1 consumed. */
function mappedCell(handle: Handle, cursor: 0 | 1): number {
  const word = Atomics.load(new Int32Array(handle.buffer, pipeRingOffset(handle) + 24, 2), cursor);
  if (word <= 0) throw new Error("ring cursor is not in the registry");
  return (word - 1) & 0xffff;
}
/** Cell indices every ring of the pipe maps. */
function mappedCells(handle: Handle): number[] {
  const layout = pipeLayoutOf(handle);
  const cells: number[] = [];
  for (let ring = 0; ring < handle.maxWriters + handle.maxReaders; ring++) {
    const mapping = new Int32Array(handle.buffer, 40 + ring * layout.ringBytes + 24, 2);
    for (const word of mapping) if (word > 0) cells.push((word - 1) & 0xffff);
  }
  return cells.sort((a, b) => a - b);
}
function smallPipe(pipes: Pipes, registry: Registry): Controller {
  return new pipes.PipeController({
    registry,
    capacity: 8,
    maxWriters: 1,
    maxReaders: 1,
    relay: "manual",
  });
}
/** Reader first, so the writer's ring binds its consumed cursor to the reader directly. */
function openPair(pipe: Controller, reader: number, writer: number): [Endpoint, Endpoint] {
  const read = pipe.retain(reader, "read");
  return [read, pipe.retain(writer, "write")];
}
function roundTrip([reader, writer]: [Endpoint, Endpoint], value: number): void {
  expect(writer.tryWrite([new Uint8Array([value])])).toBe(1);
  const output = new Uint8Array(4);
  expect(reader.tryRead([output])).toBe(1);
  expect(output[0]).toBe(value);
  expect(reader.tryRead([output])).toBe(-PipeErrno.AGAIN);
}
function registry(maxCells: number, pipes: Pipes = production): Registry {
  const created = new pipes.PipePublicationRegistry({
    processCapacity: 8,
    cellsPerProcess: 1,
    maxCells,
  });
  for (let pid = 1; pid <= 6; pid++) created.registerProcess(pid);
  return created;
}

for (const point of ["read.loaded", "read.copied"] as const)
  for (const fate of ["revoked", "collected"] as const)
    test(`a reader paused at ${point} keeps its cell while the pipe retires (owners ${fate})`, () => {
      const page = new PipeRealm(),
        guest = new PipeRealm();
      const cells = registry(16, page.pipes);
      const pipe = smallPipe(page.pipes, cells);
      const [hostReader, writer] = openPair(pipe, 2, 1);
      const reader = guest.adopt(hostReader);
      // The direct reader consumes the writer's ring: its consuming CAS acts on this cell.
      const held = mappedCell(writer.handle(), 1);
      let bystander: [Endpoint, Endpoint] | undefined;
      guest.pause(point, () => {
        pipe.revoke(2);
        writer.close();
        if (fate === "collected") {
          cells.collectProcess(1);
          cells.collectProcess(2);
        }
        expect(pipe.closed).toBe(true);
        // A new pipe takes released cells. Its cursors still hold exactly the value the
        // paused reader expects, so only the hold keeps the reader's CAS off them.
        bystander = openPair(smallPipe(page.pipes, cells), 4, 3);
        expect(mappedCells(bystander[0].handle())).not.toContain(held);
      });
      expect(writer.tryWrite([new Uint8Array([9])])).toBe(1);
      const result = reader.tryRead([new Uint8Array(1)]);
      expect(guest.settled).toBe(true);
      expect(result).not.toBe(1);
      roundTrip(bystander!, 7);
      roundTrip(bystander!, 8);
      // The reader's hold was the cell's last one: it is free now.
      expect(cells.cellsInUse).toBe(4);
    });

test("an endpoint and controller retained across retirement never reach the cells' next pipe", () => {
  const cells = registry(16);
  const pipe = smallPipe(production, cells);
  const pair = openPair(pipe, 2, 1);
  roundTrip(pair, 1);
  const old = mappedCells(pair[0].handle());
  const stale = pair.map((endpoint) => structuredClone(endpoint.handle()));
  pair[0].close();
  pair[1].close();
  expect(pipe.closed).toBe(true);
  const next = openPair(smallPipe(production, cells), 4, 3);
  // The new pipe really reuses the old pipe's four cells.
  expect(mappedCells(next[0].handle())).toEqual(old);
  roundTrip(next, 2);
  const values = old.map((index) => Atomics.load(cells.canonical(index), 0));
  const [reader, writer] = stale.map((handle) => attachPipeEndpoint(handle));
  expect(writer!.tryWrite([new Uint8Array([3])])).toBe(-PipeErrno.BADF);
  expect(reader!.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.BADF);
  expect(reader!.readiness().hangup).toBe(true);
  expect(writer!.readiness().writable).toBe(false);
  reader!.close();
  writer!.close();
  // The old controller still holds the old rings: revoking through it freezes only them.
  pipe.revoke(1);
  pipe.revoke(2);
  pipe.pumpRelay();
  expect(() => pipe.retain(5, "write")).toThrow();
  expect(old.map((index) => Atomics.load(cells.canonical(index), 0))).toEqual(values);
  roundTrip(next, 4);
});

test("a delayed revoke of a cell's earlier owner does not freeze its next owner", () => {
  const cells = registry(16);
  const pipe = smallPipe(production, cells);
  const pair = openPair(pipe, 2, 1);
  pair[0].close();
  pair[1].close();
  expect(pipe.closed).toBe(true);
  const next = openPair(smallPipe(production, cells), 4, 3);
  cells.revoke(1);
  cells.revoke(2);
  roundTrip(next, 5);
  cells.revoke(3);
  expect(next[1].tryWrite([new Uint8Array([6])])).toBe(-PipeErrno.BADF);
});

test("a default registry outlives 70000 pipes, more than its 65536 cells", () => {
  const cells = new PipePublicationRegistry();
  cells.registerProcess(1);
  const allocated = new Int32Array(cells.handle().buffer, 0, 1);
  for (let index = 0; index < 70000; index++) {
    const pipe = smallPipe(production, cells);
    const [reader, writer] = openPair(pipe, 1, 1);
    if (writer.tryWrite([new Uint8Array([index & 0xff])]) !== 1)
      throw new Error(`pipe ${index} write failed`);
    const output = new Uint8Array(1);
    if (reader.tryRead([output]) !== 1 || output[0] !== (index & 0xff))
      throw new Error(`pipe ${index} read failed`);
    reader.close();
    writer.close();
    if (!pipe.closed) throw new Error(`pipe ${index} did not retire`);
  }
  // 280000 cell uses. The free stack reuses the same few cells until each runs out of tags
  // after 32767 uses and retires, so only a handful of cells were ever touched.
  expect(cells.cellsInUse).toBe(0);
  expect(Atomics.load(allocated, 0)).toBeLessThanOrEqual(16);
  cells.collectProcess(1);
}, 60000);

test("a cell that runs out of tags retires instead of repeating a reference", () => {
  const cells = registry(4);
  const first = cells.allocate(1);
  cells.leave(first);
  let ref = first;
  for (let use = 1; use < 0x7fff; use++) {
    ref = cells.allocate(1);
    expect(ref & 0xffff).toBe(0);
    cells.leave(ref);
  }
  expect(ref >>> 16).toBe(0x7ffe);
  expect(cells.enter(ref)).toBe(false);
  const next = cells.allocate(1);
  expect(next).toBe(1);
  expect(cells.cellsInUse).toBe(1);
});

const message = (worker: Worker) => workerMessage(worker, "registry worker");

for (const mode of ["read", "write"] as const)
  test(`a Worker terminated mid-${mode} while holding a cell quarantines only that cell`, async () => {
    const cells = registry(16);
    const pipe = smallPipe(production, cells);
    const [reader, writer] = openPair(pipe, 2, 1);
    if (mode === "read") expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    const endpoint = mode === "read" ? reader : writer;
    // A reader holds the writer ring's consumed cell, a writer its published cell.
    const held = mappedCell(writer.handle(), mode === "read" ? 1 : 0);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const child = new Worker(new URL("./fixtures/pipe-reuse-worker.ts", import.meta.url));
    try {
      const paused = message(child);
      child.postMessage({
        handle: structuredClone(endpoint.handle()),
        gate,
        operation: "hold",
        point: mode === "read" ? "read.loaded" : "write.copied",
      });
      expect(await paused).toBe("paused");
      await child.terminate();
      pipe.revoke(1);
      pipe.revoke(2);
      reader.close();
      writer.close();
      expect(pipe.closed).toBe(true);
      // Everything returned but the dead Worker's hold.
      expect(cells.cellsInUse).toBe(1);
      const value = Atomics.load(cells.canonical(held), 0);
      for (let index = 0; index < 200; index++) {
        const next = smallPipe(production, cells);
        const pair = openPair(next, 4, 3);
        expect(mappedCells(pair[0].handle())).not.toContain(held);
        roundTrip(pair, index & 0xff);
        pair[0].close();
        pair[1].close();
        expect(next.closed).toBe(true);
      }
      expect(Atomics.load(cells.canonical(held), 0)).toBe(value);
      expect(cells.cellsInUse).toBe(1);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await child.terminate();
      pipe.dispose();
    }
  });
