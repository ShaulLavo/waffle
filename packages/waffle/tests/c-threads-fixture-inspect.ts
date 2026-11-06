import { inspectThreadFixture } from "./threads-fixture-inspect.ts";

export function inspectCThreadFixture(bytes: Uint8Array<ArrayBuffer>) {
  const inspected = inspectThreadFixture(bytes);
  const memory = inspected.imports.find((entry) => entry.kind === "memory");
  return {
    imports: inspected.imports,
    exports: inspected.exports,
    start: inspected.start === null ? null : { index: inspected.start.index },
    sharedMemory: memory
      ? { minimum: memory.minimum, maximum: memory.maximum, shared: memory.shared }
      : null,
    hasThreadSpawn: inspected.imports.some(
      (entry) =>
        entry.kind === "function" && entry.module === "wasi" && entry.name === "thread-spawn",
    ),
    hasThreadStart: inspected.exports.some(
      (entry) => entry.kind === "function" && entry.name === "wasi_thread_start",
    ),
    fixed32MiBImportCompatible:
      memory !== undefined && memory.minimum <= 512 && memory.maximum >= 512 && memory.shared,
  };
}
