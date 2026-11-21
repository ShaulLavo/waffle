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

const perfNow = performance.now.bind(performance);
const timeOrigin = performance.timeOrigin;
const round = Math.round;

/**
 * Bootstrap steps between the worker's first message and bound memory. Until memory is bound,
 * the sample cell holds `-(epochMicroseconds << 4 | step)`; the page's initial -1 is step 1 at
 * time 0. Readers that want bytes treat every negative value as no sample.
 */
const startProgress = {
  "runtime-loaded": 2,
  "group-joined": 3,
  "modules-loaded": 4,
  "installing-bindings": 5,
  "bindings-installed": 6,
  instantiating: 7,
} as const;
export type StartProgressStep = keyof typeof startProgress;

/** The step and its `performance.now()` time in the reading realm, or undefined. */
export function readStartProgress(
  value: bigint,
): { readonly step: StartProgressStep; readonly at: number } | undefined {
  if (value >= -1n) return undefined;
  const encoded = -value;
  const code = Number(encoded & 15n);
  const at = Number(encoded >> 4n) / 1000 - performance.timeOrigin;
  if (code === startProgress["runtime-loaded"]) return { step: "runtime-loaded", at };
  if (code === startProgress["group-joined"]) return { step: "group-joined", at };
  if (code === startProgress["modules-loaded"]) return { step: "modules-loaded", at };
  if (code === startProgress["installing-bindings"]) return { step: "installing-bindings", at };
  if (code === startProgress["bindings-installed"]) return { step: "bindings-installed", at };
  if (code === startProgress.instantiating) return { step: "instantiating", at };
  return undefined;
}

/** Records a bootstrap step for the page's start states when the broker gave a sample cell. */
export function startStep(
  sampler: ReturnType<typeof createWorkerMemorySampler> | undefined,
  step: StartProgressStep,
): void {
  sampler?.progress(step);
}

/** Worker-local writer. The page owns the never-reused cell and its retirement. */
export function createWorkerMemorySampler(buffer: SharedArrayBuffer) {
  if (!isSharedArrayBuffer(buffer) || sharedArrayBufferByteLength(buffer) !== 8)
    throw new TypeError("memory observation requires one shared 64-bit cell");
  const cell = new BigInt64ArrayConstructor(buffer);
  let lastCapacity: number | undefined;
  let encodedCapacity = 0n;
  let readMemoryByteLength: (() => number) | undefined;
  const sample = () => {
    if (!readMemoryByteLength) return;
    const capacity = readMemoryByteLength();
    if (capacity !== lastCapacity) {
      encodedCapacity = BigIntConstructor(capacity);
      lastCapacity = capacity;
    }
    atomicsStore(cell, 0, encodedCapacity);
  };
  return {
    bind(value: WebAssembly.Memory) {
      readMemoryByteLength = wasmMemoryByteLengthReader(value);
      sample();
    },
    sample,
    /** Start diagnostics for the page; a no-op once memory is bound. */
    progress(step: StartProgressStep) {
      if (readMemoryByteLength) return;
      const micros = BigIntConstructor(round((timeOrigin + perfNow()) * 1000));
      atomicsStore(cell, 0, -((micros << 4n) | BigIntConstructor(startProgress[step])));
    },
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
