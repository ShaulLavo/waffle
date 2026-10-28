import { expect, test } from "bun:test";
import { bootstrap, type WorkerExecutor, type WorkerBindingsContext } from "../browser/worker.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import {
  failingMemoryObservationGuest,
  namedMemoryImportGuest,
} from "./fixtures/memory-observation-guest.js";

const empty = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);
function run(module: WebAssembly.Module, executor: WorkerExecutor, observe = true) {
  const connection = createFilesystemConnection();
  const memoryObservation = new SharedArrayBuffer(8);
  const bytes = new BigInt64Array(memoryObservation);
  Atomics.store(bytes, 0, -1n);
  const errors: string[] = [];
  const pending = bootstrap(
    {
      module,
      args: [],
      env: {},
      filesystem: connection.client,
      memoryObservation: observe ? memoryObservation : undefined,
    },
    {
      ...executor,
      setup(context) {
        context.fs.preopen = () => 1;
        context.fs.retain = () => {};
        context.fs.release = () => {};
        executor.setup?.(context);
      },
    },
    {
      crossOriginIsolated: true,
      postMessage(message) {
        if (message.type === "error") errors.push(message.message);
      },
    },
  ).finally(() => {
    connection.client.port.close();
    connection.server.port.close();
  });
  return { bytes, pending, errors };
}

for (const imported of [false, true])
  test(`trapping instantiation reports only observable actual memory, imported=${imported}`, async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
    const f = run(failingMemoryObservationGuest(imported), {
      namespaces: () => ({ env: { memory } }),
      run: () => 0,
    });
    await f.pending;
    expect(f.errors).toHaveLength(1);
    expect(Atomics.load(f.bytes, 0)).toBe(imported ? 65536n : -1n);
  });

test("cancellation fences late memory binding and completion", async () => {
  const entered = Promise.withResolvers<
    WorkerBindingsContext & { bindMemory(memory: WebAssembly.Memory): void }
  >();
  const completion = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  const instance = new WebAssembly.Instance(empty);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw Error("fixture memory missing");
  let rejected = false;
  const f = run(empty, {
    async instantiate(_imports, context) {
      context.bindMemory(memory);
      entered.resolve(context);
      await completion.promise;
      try {
        context.bindMemory(new WebAssembly.Memory({ initial: 4 }));
      } catch {
        rejected = true;
      }
      late.resolve();
      return instance;
    },
    run: () => 0,
  });
  try {
    const context = await entered.promise;
    context.finish({ code: 0 });
    await f.pending;
    expect(Atomics.load(f.bytes, 0)).toBe(65536n);
    completion.resolve();
    await late.promise;
    expect(rejected).toBe(true);
    expect(Atomics.load(f.bytes, 0)).toBe(65536n);
  } finally {
    completion.resolve();
    await f.pending;
    await late.promise;
  }
});

test("an executor cannot replace a bound memory and finish samples the original", async () => {
  const f = run(empty, {
    instantiate(_imports, context) {
      context.bindMemory(new WebAssembly.Memory({ initial: 2 }));
      context.bindMemory(new WebAssembly.Memory({ initial: 4 }));
      throw Error("unreachable");
    },
    run: () => 0,
  });
  await f.pending;
  expect(f.errors[0]).toContain("replace bound process memory");
  expect(Atomics.load(f.bytes, 0)).toBe(131072n);
});

function frozenProperty(name: string, value: object | (() => number), inherited: boolean) {
  const owner = Object.defineProperty({}, name, { value });
  Object.freeze(owner);
  return Object.freeze(inherited ? Object.create(owner) : owner);
}
for (const namespaceInherited of [false, true])
  for (const memberInherited of [false, true]) {
    test(`bootstrap preserves frozen named imports, namespace inherited=${namespaceInherited}, member inherited=${memberInherited}`, async () => {
      let calls = 0;
      const ping = () => {
        calls++;
        return 42;
      };
      const namespace = frozenProperty("ping", ping, memberInherited);
      const imports = frozenProperty("env", namespace, namespaceInherited);
      const module = namedMemoryImportGuest();
      const baseline = new WebAssembly.Instance(module, imports).exports._start;
      if (typeof baseline !== "function") throw Error("fixture entry missing");
      baseline();
      expect(calls).toBe(1);
      const f = run(module, {
        namespaces: () => ({ env: { ping } }),
        imports: () => imports,
        run: () => 0,
      });
      await f.pending;
      expect(f.errors).toEqual([]);
      expect(calls).toBe(2);
      expect(Atomics.load(f.bytes, 0)).toBe(65536n);
    });
  }

for (const observe of [false, true])
  test(`r708 custom instance group keeps side-module imports, observed=${observe}`, async () => {
    const sideModule = namedMemoryImportGuest();
    let calls = 0;
    let completeImports: WebAssembly.Imports | undefined;
    const f = run(
      empty,
      {
        imports(imports) {
          completeImports = Object.assign(imports, { env: { ping: () => ++calls && 42 } });
          return completeImports;
        },
        instantiate(imports, context) {
          if (!completeImports) throw Error("imports hook did not run");
          expect(imports).toBe(completeImports);
          const side = new WebAssembly.Instance(sideModule, imports);
          const start = side.exports._start;
          if (typeof start !== "function") throw Error("fixture entry missing");
          start();
          return new WebAssembly.Instance(context.request.module, imports);
        },
        run: () => 0,
      },
      observe,
    );
    await f.pending;
    console.log(JSON.stringify({ observe, calls, errors: f.errors }));
    expect(f.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(Atomics.load(f.bytes, 0)).toBe(observe ? 65536n : -1n);
  });

test("custom instantiation still samples bootstrap host-call growth before completion", async () => {
  let memory: WebAssembly.Memory | undefined;
  let calls = 0;
  const ping = () => {
    if (!memory) throw Error("memory not bound");
    memory.grow(1);
    calls++;
    return 42;
  };
  const f = run(namedMemoryImportGuest(), {
    namespaces: () => ({ env: { ping } }),
    instantiate(imports, context) {
      const instance = new WebAssembly.Instance(context.request.module, imports);
      const exported = instance.exports.memory;
      if (!(exported instanceof WebAssembly.Memory)) throw Error("fixture memory missing");
      memory = exported;
      context.bindMemory(memory);
      const start = instance.exports._start;
      if (typeof start !== "function") throw Error("fixture entry missing");
      start();
      expect(Atomics.load(new BigInt64Array(context.request.memoryObservation!), 0)).toBe(131072n);
      return instance;
    },
    run: () => 0,
  });
  await f.pending;
  expect(f.errors).toEqual([]);
  expect(calls).toBe(2);
  expect(Atomics.load(f.bytes, 0)).toBe(196608n);
});
