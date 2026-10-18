import { expect, test } from "bun:test";
import {
  ExecutableRegistry,
  ProcessSupervisor,
  type ProcessContext,
  type SpawnRequest,
} from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (executable: string): SpawnRequest => ({
  executable,
  argv: [executable],
  env: {},
  cwd: "/",
  job: 0,
  fds: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("low-level cooperative module registration resolves explicit non-instrumented metadata", async () => {
  const registry = new ExecutableRegistry();
  registry.register("cooperative", { module, adapter: "preview1" });
  expect(await registry.resolve("cooperative")).toEqual({
    module,
    adapter: "preview1",
    interruptible: false,
  });
});

test("shared compilation preserves immutable admission metadata per registered program", async () => {
  const registry = new ExecutableRegistry();
  let loads = 0;
  const load = () => {
    loads++;
    return module;
  };
  const instrumented = { module: load, adapter: "preview1", interruptible: true };
  registry.register("source", instrumented);
  registry.register("cooperative", { module: load, adapter: "preview1", interruptible: false });
  registry.register("engine", { module: load, adapter: "bun:quickjs" });
  instrumented.interruptible = false;
  instrumented.adapter = "mutated";
  const [source, cooperative, engine] = await Promise.all([
    registry.resolve("source"),
    registry.resolve("cooperative"),
    registry.resolve("engine"),
  ]);
  expect(source).toEqual({ module, adapter: "preview1", interruptible: true });
  expect(cooperative).toEqual({ module, adapter: "preview1", interruptible: false });
  expect(engine).toEqual({ module, adapter: "bun:quickjs", interruptible: false });
  expect(loads).toBe(1);
});

test("pending resolution retains admission and adapter when its name is replaced", async () => {
  const registry = new ExecutableRegistry();
  const compilation = deferred<WebAssembly.Module>();
  registry.register("program", {
    module: () => compilation.promise,
    adapter: "preview1",
    interruptible: true,
  });
  const admitted = registry.resolve("program");
  registry.register("program", { module, adapter: "bun:jsc", interruptible: false });
  compilation.resolve(module);
  expect(await admitted).toEqual({ module, adapter: "preview1", interruptible: true });
  expect(await registry.resolve("program")).toEqual({
    module,
    adapter: "bun:jsc",
    interruptible: false,
  });
});

test("independent supervisors receive admission metadata from their shared program registry", async () => {
  const registry = new ExecutableRegistry();
  registry.register("source", { module, adapter: "preview1", interruptible: true });
  registry.register("cooperative", { module, adapter: "preview1", interruptible: false });
  registry.register("quickjs", { module, adapter: "bun:quickjs" });
  registry.register("jsc", { module, adapter: "bun:jsc" });
  const supervisors: ProcessSupervisor[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const contexts: ProcessContext[] = [];
      const supervisor = new ProcessSupervisor({
        registry,
        launch(context) {
          contexts.push(context);
          return { terminate() {} };
        },
      });
      supervisors.push(supervisor);
      const root = supervisor.createRoot();
      for (const name of ["source", "cooperative", "quickjs", "jsc"]) {
        const pid = supervisor.reserveSpawn(root, request(name));
        await supervisor.start(pid);
      }
      expect(
        contexts.map((context) => ({
          name: context.request.executable,
          adapter: context.adapter,
          interruptible: context.interruptible,
        })),
      ).toEqual([
        { name: "source", adapter: "preview1", interruptible: true },
        { name: "cooperative", adapter: "preview1", interruptible: false },
        { name: "quickjs", adapter: "bun:quickjs", interruptible: false },
        { name: "jsc", adapter: "bun:jsc", interruptible: false },
      ]);
    }
  } finally {
    for (const supervisor of supervisors) supervisor.dispose();
  }
});
