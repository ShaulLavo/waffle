import { afterEach, expect, spyOn, test } from "bun:test";
import { createRuntime, type HostCommand, type Runtime } from "../index.js";
import { defineProgramPackage } from "../programs/index.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createProgramShell } from "./fixtures/program-shell.js";

let runtime: Runtime | undefined;
let tables: DescriptorTable[] = [];
let releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  await runtime?.dispose();
  runtime = undefined;
  for (const table of tables) table.dispose();
  tables = [];
});
function create(): Runtime {
  return (runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
    },
  }));
}
function deferred() {
  const gate = Promise.withResolvers<void>();
  releases.push(gate.resolve);
  return gate;
}
function command(run: HostCommand, load = async () => run) {
  return defineProgramPackage({
    name: "commands",
    programs: [
      {
        path: "/usr/bin/fixture",
        aliases: ["/bin/fixture", "/opt/fixture"],
        command: { load },
      },
    ],
  });
}
async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

test("module-less commands execute without compiling Wasm or exposing runtime authority", async () => {
  const owner = create();
  let loads = 0;
  const pkg = command(
    async (context) => {
      expect("module" in context).toBe(false);
      expect("service" in context).toBe(false);
      expect("supervisor" in context).toBe(false);
      await context.stdout.write(new TextEncoder().encode(context.request.argv.join(" ")));
      return 3;
    },
    async () => {
      loads++;
      return pkgRun;
    },
  );
  const pkgRun: HostCommand = async (context) => {
    expect(Object.keys(context).sort()).toEqual([
      "abort",
      "parentPid",
      "pid",
      "processes",
      "request",
      "stderr",
      "stdin",
      "stdout",
    ]);
    await context.stdout.write(new TextEncoder().encode(context.request.argv.join(" ")));
    return 3;
  };
  const compile = spyOn(WebAssembly, "compile");
  const compileStreaming = spyOn(WebAssembly, "compileStreaming");
  try {
    await owner.programs.onDemand(pkg);
    expect(loads).toBe(0);
    const shell = await createProgramShell(owner, tables);
    expect(await shell.access("/usr/bin/fixture")).toBe(0);
    expect(loads).toBe(0);
    expect(await shell.exec("/bin/fixture", ["fixture", "hello"])).toMatchObject({
      kind: "exited",
      code: 3,
    });
    expect(shell.output.join("")).toBe("fixture hello");
    expect(loads).toBe(1);
    expect(compile).not.toHaveBeenCalled();
    expect(compileStreaming).not.toHaveBeenCalled();
  } finally {
    compile.mockRestore();
    compileStreaming.mockRestore();
  }
});

test("aliases and picks share lazy preparation, preload, and retry after failure", async () => {
  const owner = create();
  const loading = deferred();
  let loads = 0;
  const run: HostCommand = async () => 0;
  const pkg = command(run, async () => {
    loads++;
    await loading.promise;
    return run;
  });
  await owner.programs.onDemand(pkg.pick("fixture"));
  const shell = await createProgramShell(owner, tables);
  const attempts = ["/usr/bin/fixture", "/bin/fixture", "/opt/fixture"].map((path) =>
    shell.exec(path, ["fixture"]),
  );
  const preload = owner.programs.get("fixture")!.preload();
  loading.resolve();
  await preload;
  expect(await Promise.all(attempts)).toMatchObject([{ code: 0 }, { code: 0 }, { code: 0 }]);
  expect(loads).toBe(1);
  expect(owner.programs.get("fixture")!.state).toEqual({ kind: "loaded" });
});

test("live marker admission does not execute a deleted or replaced command", async () => {
  const owner = create();
  let entered = 0;
  await owner.programs.onDemand(
    command(async () => {
      entered++;
      return 0;
    }),
  );
  const shell = await createProgramShell(owner, tables);
  await owner.filesystem.remove("/bin/fixture");
  expect(await shell.exec("/bin/fixture", ["fixture"])).toMatchObject({
    kind: "start-failed",
    error: "ENOENT",
  });
  await owner.filesystem.writeFile("/usr/bin/fixture", "not a marker\n");
  expect(await shell.exec("/usr/bin/fixture", ["fixture"])).toMatchObject({
    kind: "start-failed",
    error: "ENOEXEC",
  });
  expect(entered).toBe(0);
});

test("removal closes admission synchronously and waits for a pending loader", async () => {
  const owner = create();
  const loading = deferred();
  const entered = deferred();
  let calls = 0;
  await owner.programs.onDemand(
    command(
      async () => {
        calls++;
        return 0;
      },
      async () => {
        entered.resolve();
        await loading.promise;
        return async () => {
          calls++;
          return 0;
        };
      },
    ),
  );
  const shell = await createProgramShell(owner, tables);
  const executing = shell.exec("/bin/fixture", ["fixture"]);
  await entered.promise;
  const handle = owner.programs.get("fixture")!;
  const removal = handle.remove();
  expect(handle.state).toEqual({ kind: "removed" });
  let removed = false;
  void removal.then(() => {
    removed = true;
  });
  expect(await failure(handle.preload())).toBeInstanceOf(Error);
  expect(await shell.exec("/opt/fixture", ["fixture"])).toMatchObject({ kind: "start-failed" });
  expect(removed).toBe(false);
  loading.resolve();
  await executing;
  await removal;
  expect(calls).toBe(0);
});
