import {
  BigInt64ArrayConstructor,
  BigIntConstructor,
  atomicsStore,
  objectCreate,
  reflectApply,
  isSharedArrayBuffer,
  sharedArrayBufferByteLength,
  wasmMemoryByteLengthReader,
  wasmModuleImports,
} from "../proc/intrinsics.js";

function sampledCall(call: Function, sample: () => void): Function {
  return function (this: unknown, ...args: unknown[]) {
    sample();
    try {
      return reflectApply(call, this, args);
    } finally {
      sample();
    }
  };
}

/** Worker-local writer. The page owns the never-reused cell and its retirement. */
export function createWorkerMemorySampler(buffer: SharedArrayBuffer) {
  if (!isSharedArrayBuffer(buffer) || sharedArrayBufferByteLength(buffer) !== 8)
    throw new TypeError("memory observation requires one shared 64-bit cell");
  const cell = new BigInt64ArrayConstructor(buffer);
  let readMemoryByteLength: (() => number) | undefined;
  const sample = () => {
    if (readMemoryByteLength) atomicsStore(cell, 0, BigIntConstructor(readMemoryByteLength()));
  };
  return {
    bind(value: WebAssembly.Memory) {
      readMemoryByteLength = wasmMemoryByteLengthReader(value);
      sample();
    },
    sample,
    imports(module: WebAssembly.Module, imports: WebAssembly.Imports): WebAssembly.Imports {
      const linked: WebAssembly.Imports = objectCreate(null);
      const entries = wasmModuleImports(module);
      for (let index = 0; index < entries.length; index++)
        copyImport(linked, imports, entries[index]!, sample);
      return linked;
    },
  };
}

function copyImport(
  linked: WebAssembly.Imports,
  imports: WebAssembly.Imports,
  entry: WebAssembly.ModuleImportDescriptor,
  sample: () => void,
): void {
  const namespace = imports[entry.module];
  if (namespace === undefined) return;
  if (namespace === null || (typeof namespace !== "object" && typeof namespace !== "function"))
    throw new TypeError(`import namespace ${entry.module} must be an object`);
  const target = (linked[entry.module] ??= objectCreate(null));
  const value = namespace[entry.name];
  if (value === undefined) return;
  target[entry.name] =
    entry.kind === "function" && typeof value === "function" ? sampledCall(value, sample) : value;
}

/** Imported memory is observable even when a start section traps before exports exist. */
export function bindImportedMemory(
  module: WebAssembly.Module,
  imports: WebAssembly.Imports,
  bind: (memory: WebAssembly.Memory) => void,
): void {
  const entries = wasmModuleImports(module);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.kind !== "memory") continue;
    const memory = imports[entry.module]?.[entry.name];
    if (memory instanceof WebAssembly.Memory) bind(memory);
  }
}
