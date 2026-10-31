import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { after, before, test, type TestContext } from "node:test";
import type { GuestLauncher, RuntimeProcessContext } from "waffle";
import { PYTHON_ARGV0, type PythonPayloadManifest } from "../src/python-payload.ts";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "../test/node-worker-host.ts";
import { wasiCat } from "../../waffle/tests/fixtures/wasi-cat.ts";

const runtimeTest = {
  skip:
    process.env.PYTHON_ALIAS_RUNTIME === "1"
      ? false
      : "Set PYTHON_ALIAS_RUNTIME=1 after preparing Waffle Node exports",
  timeout: 10_000,
};
const paths = ["/usr/bin/python", "/usr/bin/python3", "/bin/python3"];
const nodeRoot = new URL(".", import.meta.resolve("waffle"));
const worker = new URL(import.meta.resolve("waffle/browser/preview1-worker"));
const files = new Map([
  ["/Lib/os.py", new TextEncoder().encode("# lifecycle fixture, not CPython\n")],
  [
    "/cross-build/wasm32-wasip1/pybuilddir.txt",
    new TextEncoder().encode("build/lib.wasi-wasm32-3.15"),
  ],
]);
const manifest: PythonPayloadManifest = {
  format: 1,
  cpython: "5e58eaad7c58df58dfa8ea549c87996e01dd1077",
  argv0: PYTHON_ARGV0,
  files: Array.from(files, ([path, bytes]) => ({
    path,
    url: `https://python.test/files${path}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })),
};
const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const isolationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
before(installNodeWorkers);
after(async () => {
  await stopNodeWorkers();
  restoreGlobal("Worker", workerDescriptor);
  restoreGlobal("crossOriginIsolated", isolationDescriptor);
});
function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
function deferred() {
  return Promise.withResolvers<void>();
}
const launchWorker: GuestLauncher = (context, service) =>
  service.launchWorker(context, {
    workerUrl: worker.href,
    request: {
      module: context.module,
      args: context.request.argv,
      env: context.request.env,
      interruptible: context.interruptible,
    },
  });

function heldLauncher({
  guests,
  started,
  stopped,
  terminating,
}: {
  guests: RuntimeProcessContext[];
  started: ReturnType<typeof deferred>[];
  stopped: ReturnType<typeof deferred>[];
  terminating: ReturnType<typeof deferred>[];
}): GuestLauncher {
  return (guest) => {
    const index = guests.length;
    guests.push(guest);
    guest.started();
    started[index]?.resolve();
    return {
      terminate: async () => {
        terminating[index]?.resolve();
        await stopped[index]?.promise;
      },
    };
  };
}

async function fixture(context: TestContext, launcher = launchWorker) {
  const { createRuntime, declareSharedMemoryPlatform } = await import("waffle");
  const { createPythonPackage } = await import("../src/index.ts");
  const { installPython } = await import("../src/install.ts");
  const { createProgramTestRoot } = await import("../../../tools/program-test-root.ts");
  const runtime = createRuntime({
    sharedMemory: declareSharedMemoryPlatform({ kind: "unbounded" }),
    filesystem: { mode: "memory", workerURL: new URL("browser/fs-worker.js", nodeRoot) },
    programs: { launcher },
  });
  const releases: Array<() => void> = [];
  const roots: Awaited<ReturnType<typeof createProgramTestRoot>>[] = [];
  let installation: Awaited<ReturnType<typeof installPython>> | undefined;
  context.after(async () => {
    for (const release of releases) release();
    await Promise.all(roots.map((root) => root.dispose()));
    await runtime.dispose();
    await installation?.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  });
  const fetched: string[] = [];
  const entered = deferred();
  const gate = deferred();
  releases.push(gate.resolve);
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith("python-stdlib.json")) return Response.json(manifest);
    if (url.endsWith("python.wasm")) {
      entered.resolve();
      await gate.promise;
      return new Response(wasiCat());
    }
    const bytes = files.get(new URL(url).pathname.slice("/files".length));
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  });
  const options = {
    wasmUrl: "https://python.test/python.wasm",
    payloadUrl: "https://python.test/python-stdlib.json",
  };
  return {
    runtime,
    fetched,
    entered: entered.promise,
    release: gate.resolve,
    async root() {
      const root = await createProgramTestRoot(runtime);
      roots.push(root);
      return root;
    },
    async install(kind: "collection" | "installer") {
      if (kind === "installer") {
        installation = await installPython(runtime, { ...options, launcher });
        assert.deepEqual(installation.executables, paths);
        assert.deepEqual(installation.path, ["/usr/bin", "/bin"]);
        return installation.dispose;
      }
      const catalog = createPythonPackage(runtime, options);
      await runtime.programs.onDemand(catalog.pick("/usr/bin/python3"), catalog.pick("python"));
      const handle = runtime.programs.get("python");
      assert.ok(handle);
      assert.equal(runtime.programs.status().length, 1);
      for (const path of paths) assert.equal(runtime.programs.get(path), handle);
      return handle.remove;
    },
    hold(gate: ReturnType<typeof deferred>) {
      releases.push(gate.resolve);
    },
  };
}

for (const kind of ["collection", "installer"] as const) {
  test(
    `${kind}: Python aliases load one WASI fixture and preserve argv, cwd, and exit status`,
    runtimeTest,
    async (context) => {
      const launches: RuntimeProcessContext[] = [];
      const state = await fixture(context, (guest, service) => {
        launches.push(guest);
        return launchWorker(guest, service);
      });
      const dispose = await state.install(kind);
      for (const path of paths)
        assert.equal((await state.runtime.filesystem.lookup(path))?.kind, "file");
      assert.deepEqual(state.fetched, []);
      await state.runtime.filesystem.mkdirp("/home/guest");
      const root = await state.root();
      const args = ["-I", "-B", "-u", "-c", "unchanged", "", "two words", "β", "-m", "--version"];
      const executions = paths.map((executable) =>
        root.exec({
          executable,
          argv: [executable].concat(args),
          cwd: "/home/guest",
          env: { PWD: "/stale", TOKEN: "kept" },
        }),
      );
      await state.entered;
      assert.equal(launches.length, 0);
      state.release();
      const results = await Promise.all(executions);
      for (const result of results) assert.deepEqual(result, { status: 2, stdout: "", stderr: "" });
      assert.equal(launches.length, paths.length);
      for (const launched of launches) {
        assert.deepEqual(launched.request.argv, [PYTHON_ARGV0].concat(args));
        assert.equal(launched.request.cwd, "/home/guest");
        assert.deepEqual(launched.request.env, { PWD: "/home/guest", TOKEN: "kept" });
        assert.equal(launched.module, launches[0]?.module);
      }
      assert.equal(state.fetched.length, files.size + 2);
      assert.equal(new Set(state.fetched).size, state.fetched.length);
      if (kind === "collection") await state.runtime.programs.preload("python", "/bin/python3");
      assert.equal(state.fetched.length, files.size + 2);
      await dispose();
      for (const path of paths.concat(Array.from(files.keys())))
        assert.equal(await state.runtime.filesystem.lookup(path), undefined);
      assert.equal(state.runtime.disposed, false);
    },
  );

  test(
    `${kind}: disposal joins canonical and alias loading without resurrection`,
    runtimeTest,
    async (context) => {
      let launches = 0;
      const state = await fixture(context, () => {
        launches++;
        throw new Error("unexpected launch");
      });
      const dispose = await state.install(kind);
      const root = await state.root();
      const running = paths.map((executable) =>
        root.exec({
          executable,
          argv: [executable, "--version"],
          cwd: "/",
          env: {},
        }),
      );
      await state.entered;
      let disposed = false;
      const disposal = dispose();
      assert.equal(dispose(), disposal);
      void disposal.then(() => {
        disposed = true;
      });
      await setImmediate();
      assert.equal(disposed, false);
      state.release();
      for (const result of await Promise.all(running)) assert.equal(result.status, 127);
      await disposal;
      assert.equal(launches, 0);
      for (const path of paths.concat(Array.from(files.keys())))
        assert.equal(await state.runtime.filesystem.lookup(path), undefined);
      assert.equal(state.fetched.length, files.size + 2);
    },
  );

  test(
    `${kind}: canonical and alias consumers share the physical-stop payload fence`,
    runtimeTest,
    async (context) => {
      const started = [deferred(), deferred()];
      const stopped = [deferred(), deferred()];
      const terminating = [deferred(), deferred()];
      const guests: RuntimeProcessContext[] = [];
      const state = await fixture(context, heldLauncher({ guests, started, stopped, terminating }));
      for (const gate of stopped) state.hold(gate);
      const dispose = await state.install(kind);
      state.release();
      const root = await state.root();
      const executions = paths.slice(0, 2).map((executable) =>
        root.exec({
          executable,
          argv: [executable, "--version"],
          cwd: "/",
          env: {},
        }),
      );
      await Promise.all(started.map((gate) => gate.promise));
      let disposed = false;
      const disposal = dispose().then(() => {
        disposed = true;
      });
      for (const guest of guests) guest.exit(7);
      await Promise.all(terminating.map((gate) => gate.promise));
      assert.equal(disposed, false);
      assert.ok(await state.runtime.filesystem.lookup("/Lib/os.py"));
      stopped[0]?.resolve();
      await executions[0];
      assert.equal(disposed, false);
      assert.ok(await state.runtime.filesystem.lookup("/Lib/os.py"));
      stopped[1]?.resolve();
      for (const result of await Promise.all(executions)) assert.equal(result.status, 7);
      await disposal;
      assert.equal(await state.runtime.filesystem.lookup("/Lib/os.py"), undefined);
    },
  );
}
