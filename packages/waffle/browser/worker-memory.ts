import {
  BigInt64ArrayConstructor,
  BigIntConstructor,
  atomicsStore,
  objectEntries,
  objectCreate,
  reflectApply,
  isSharedArrayBuffer,
  sharedArrayBufferByteLength,
  wasmMemoryByteLength,
} from "../proc/intrinsics.js";

function sampledCall(call: Function, sample: () => void): Function {
  return (...args: unknown[]) => {
    sample();
    try {
      return reflectApply(call, undefined, args);
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
  let memory: WebAssembly.Memory | undefined;
  const sample = () => {
    if (memory) atomicsStore(cell, 0, BigIntConstructor(wasmMemoryByteLength(memory)));
  };
  return {
    bind(value: WebAssembly.Memory) {
      memory = value;
      sample();
    },
    sample,
    imports(imports: WebAssembly.Imports): WebAssembly.Imports {
      const linked: WebAssembly.Imports = objectCreate(null);
      const namespaces = objectEntries(imports);
      for (let index = 0; index < namespaces.length; index++) {
        const [name, namespace] = namespaces[index]!;
        linked[name] = sampledNamespace(namespace, sample);
      }
      return linked;
    },
  };
}

function sampledNamespace(
  namespace: WebAssembly.ModuleImports,
  sample: () => void,
): WebAssembly.ModuleImports {
  const linked: WebAssembly.ModuleImports = objectCreate(null);
  const entries = objectEntries(namespace);
  for (let index = 0; index < entries.length; index++) {
    const [name, value] = entries[index]!;
    linked[name] = typeof value === "function" ? sampledCall(value, sample) : value;
  }
  return linked;
}

/** Imported memory is observable even when a start section traps before exports exist. */
export function bindImportedMemory(
  module: WebAssembly.Module,
  imports: WebAssembly.Imports,
  bind: (memory: WebAssembly.Memory) => void,
): void {
  const entries = WebAssembly.Module.imports(module);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.kind !== "memory") continue;
    const memory = imports[entry.module]?.[entry.name];
    if (memory instanceof WebAssembly.Memory) bind(memory);
  }
}
