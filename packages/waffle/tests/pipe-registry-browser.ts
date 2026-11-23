import {
  PipeController,
  PipeErrno,
  PipePublicationRegistry,
  attachPipeEndpoint,
  attachPipePublicationRegistry,
} from "../proc/pipes.js";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Registry cells on a real engine: a growable registry and a clone made before it grew
 * (length-tracking views over a growable SharedArrayBuffer), 500 pipes reusing 16 cells, a
 * held cell nobody reuses, and endpoints retained across retirement. */
export function browserPipeRegistryReuse(): void {
  const registry = new PipePublicationRegistry({
    processCapacity: 2,
    cellsPerProcess: 1,
    maxCells: 16,
  });
  registry.registerProcess(1);
  registry.registerProcess(2);
  const initial = registry.handle().buffer.byteLength;
  const clone = attachPipePublicationRegistry(structuredClone(registry.handle()));
  const held = registry.allocate(1);
  const heldCursor = clone.canonical(held);
  Atomics.store(heldCursor, 0, 0x1234n);
  for (let index = 0; index < 500; index++) {
    const pipe = new PipeController({
      registry: index % 2 ? registry : clone,
      capacity: 8,
      maxWriters: 1,
      maxReaders: 1,
      relay: "manual",
    });
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(2, "write");
    const stale = attachPipeEndpoint(structuredClone(reader.handle()));
    const output = new Uint8Array(1);
    check(writer.tryWrite([new Uint8Array([index & 0xff])]) === 1, `pipe ${index} write`);
    check(stale.tryRead([output]) === 1 && output[0] === (index & 0xff), `pipe ${index} read`);
    reader.close();
    writer.close();
    check(pipe.closed, `pipe ${index} retired`);
    check(stale.tryRead([output]) === -PipeErrno.BADF, `pipe ${index} stale reader closed`);
  }
  check(registry.cellsInUse === 1, `cells in use ${registry.cellsInUse}`);
  check(registry.handle().buffer.byteLength > initial, "registry grew past its first two cells");
  check(
    clone.handle().buffer.byteLength === registry.handle().buffer.byteLength,
    "the clone sees the growth",
  );
  check(Atomics.load(heldCursor, 0) === 0x1234n, "the held cell was never reused");
  registry.leave(held);
  check(clone.cellsInUse === 0, "the last hold returned the cell");
  registry.collectProcess(1);
  registry.collectProcess(2);
}
