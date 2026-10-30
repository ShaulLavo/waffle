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
      "signals",
      "stderr",
      "stdin",
      "stdout",
    ]);
    await context.stdout.write(new TextEncoder().encode(context.request.argv.join(" ")));
    return 3;
  };
  const compiledModule = spyOn(WebAssembly, "Module");
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
    expect(compiledModule).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    expect(compileStreaming).not.toHaveBeenCalled();
  } finally {
    compiledModule.mockRestore();
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

import { commandShell } from "./program-host-command-fixture.js";
import { PipeController } from "../proc/pipes.js";
import { CommandStdioError, type HostCommandContext } from "../proc/command.js";
let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

test("command stdio writes real redirected files and keeps a shared append offset", async () => {
  const owner = create();
  await owner.programs.onDemand(
    command(async ({ stdout, stderr }) => {
      await stdout.write(new TextEncoder().encode("redirected stdout\n"));
      await stderr.write(new TextEncoder().encode("separate stderr\n"));
      return 0;
    }),
  );
  const shell = await commandShell(owner, cleanups);
  await shell.file(1, "/out");
  await shell.file(2, "/err");
  const result = await shell.spawn(
    "/usr/bin/fixture",
    ["fixture"],
    [
      { parent: 1, child: 1 },
      { parent: 2, child: 2 },
    ],
  );
  expect(await result.collect()).toMatchObject({ kind: "exited", code: 0 });
  expect(new TextDecoder().decode(await owner.filesystem.readFile("/out"))).toBe(
    "redirected stdout\n",
  );
  expect(new TextDecoder().decode(await owner.filesystem.readFile("/err"))).toBe(
    "separate stderr\n",
  );
  const second = await shell.spawn(
    "/opt/fixture",
    ["fixture"],
    [
      { parent: 1, child: 1 },
      { parent: 2, child: 2 },
    ],
  );
  expect(await second.collect()).toMatchObject({ kind: "exited", code: 0 });
  expect(new TextDecoder().decode(await owner.filesystem.readFile("/out"))).toBe(
    "redirected stdout\n".repeat(2),
  );
});

test("stdio copies at least one MiB through real pipes under backpressure", async () => {
  const owner = create();
  const started = deferred();
  await owner.programs.onDemand(
    command(async ({ stdin, stdout }) => {
      started.resolve();
      for (;;) {
        const bytes = await stdin.read();
        if (!bytes) return 0;
        await stdout.write(bytes);
      }
    }),
  );
  const shell = await commandShell(owner, cleanups);
  const input = new PipeController({ capacity: 4096, relay: "manual" });
  const output = new PipeController({ capacity: 4096, relay: "manual" });
  cleanups.push(
    () => input.dispose(),
    () => output.dispose(),
  );
  const writer = input.retain(shell.root, "write");
  const reader = output.retain(shell.root, "read");
  cleanups.push(
    () => writer.close(),
    () => reader.close(),
  );
  shell.descriptors.openAt(0, input.retain(shell.root, "read"), 2n, 0n);
  shell.descriptors.openAt(1, output.retain(shell.root, "write"), 64n, 0n);
  const process = await shell.spawn(
    "/bin/fixture",
    ["fixture"],
    [
      { parent: 0, child: 0 },
      { parent: 1, child: 1 },
    ],
  );
  shell.descriptors.close(0);
  shell.descriptors.close(1);
  await started.promise;
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 17 }, (_, index) => index % 251);
  const received = new Uint8Array(bytes.length);
  const writing = (async () => {
    let at = 0;
    while (at < bytes.length) {
      const count = writer.tryWrite([bytes.subarray(at, at + 4096)]);
      if (count === -6) await writer.waitWritable();
      else {
        expect(count).toBeGreaterThan(0);
        at += count;
      }
    }
    writer.close();
  })();
  let at = 0;
  for (;;) {
    const chunk = new Uint8Array(4096);
    const count = reader.tryRead([chunk]);
    if (count === -6) {
      await reader.waitReadable();
      continue;
    }
    if (!count) break;
    expect(count).toBeGreaterThan(0);
    received.set(chunk.subarray(0, count), at);
    at += count;
  }
  await writing;
  expect(await process.collect()).toMatchObject({ kind: "exited", code: 0 });
  expect(at).toBe(bytes.length);
  expect(received).toEqual(bytes);
});

test.each([15, 9])(
  "signal %s revokes capabilities without claiming the callback physically stopped",
  async (signal) => {
    const owner = create();
    const entered = deferred();
    const physical = deferred();
    let context: HostCommandContext | undefined;
    let disposed = 0;
    const base = command(async (value) => {
      context = value;
      entered.resolve();
      await physical.promise;
      return 0;
    });
    await owner.programs.onDemand({
      ...base,
      dispose: async () => {
        disposed++;
      },
    });
    const shell = await commandShell(owner, cleanups);
    const process = await shell.spawn("/bin/fixture");
    await entered.promise;
    await shell.service.kill(process.pid, signal);
    expect(await process.exit).toMatchObject({ kind: "signaled", code: signal });
    expect(context!.abort.aborted).toBe(true);
    expect(await failure(context!.stdout.write(new Uint8Array([1])))).toMatchObject({
      code: "CANCELED",
    });
    expect(() => context!.processes.snapshot()).toThrow(CommandStdioError);
    const handle = owner.programs.get("fixture")!;
    const removing = handle.remove();
    let removed = false;
    void removing.then(() => {
      removed = true;
    });
    await Promise.resolve();
    expect(removed).toBe(false);
    expect(disposed).toBe(0);
    physical.resolve();
    await removing;
    expect(disposed).toBe(1);
  },
);

test.each([0, 3, 255, 256, 1.5])("return value %s maps to a real process outcome", async (code) => {
  const owner = create();
  await owner.programs.onDemand(command(async () => code));
  const shell = await commandShell(owner, cleanups);
  const process = await shell.spawn("/bin/fixture");
  expect(await process.collect()).toMatchObject({
    kind: "exited",
    code: Number.isInteger(code) && code <= 255 ? code : 126,
  });
});

test("synchronous callback throws are execution failures, and missing fds report EBADF", async () => {
  const owner = create();
  const pkg = command(async ({ stdin, stdout }) => {
    expect(await failure(stdin.read())).toMatchObject({ code: "EBADF" });
    expect(await failure(stdout.write(new Uint8Array([1])))).toMatchObject({ code: "EBADF" });
    throw new Error("command failed");
  });
  await owner.programs.onDemand(pkg);
  const shell = await commandShell(owner, cleanups);
  const process = await shell.spawn("/bin/fixture");
  expect(await process.collect()).toMatchObject({ kind: "exited", code: 126 });
});

test("a failed loader is observable and retryable, while non-functions fail startup", async () => {
  const owner = create();
  let loads = 0;
  const run: HostCommand = async () => 0;
  await owner.programs.onDemand(
    command(run, async () => {
      if (++loads === 1) throw new Error("unavailable");
      return run;
    }),
  );
  const shell = await commandShell(owner, cleanups);
  expect(await (await shell.spawn("/bin/fixture")).collect()).toMatchObject({
    kind: "start-failed",
    error: "EIO",
  });
  expect(owner.programs.get("fixture")!.state).toMatchObject({ kind: "error" });
  expect(await (await shell.spawn("/opt/fixture")).collect()).toMatchObject({
    kind: "exited",
    code: 0,
  });
  expect(loads).toBe(2);
  await owner.programs.get("fixture")!.remove();
  owner.registerProgram("/bad", {
    // @ts-expect-error The runtime also rejects dynamically supplied non-command payloads.
    command: { load: async () => 7 },
  });
  await owner.filesystem.writeFile("/bad", "bad command\n");
  expect(await (await shell.spawn("/bad")).collect()).toMatchObject({ kind: "start-failed" });
});

test("a registered script rejects command interpreters but a live shebang rewrites argv", async () => {
  const owner = create();
  let args: readonly string[] = [];
  await owner.programs.onDemand(
    command(async ({ request }) => {
      args = request.argv;
      return 0;
    }),
  );
  await owner.programs.onDemand({
    name: "scripts",
    programs: [
      {
        path: "/registered",
        script: { interpreter: "/bin/fixture", source: async () => "script" },
      },
    ],
  });
  await owner.filesystem.writeFile("/shebang", "#!/bin/fixture --argument\ntext");
  const shell = await commandShell(owner, cleanups);
  expect(await (await shell.spawn("/registered")).collect()).toMatchObject({
    kind: "start-failed",
    error: "ENOEXEC",
  });
  expect(await (await shell.spawn("/shebang", ["shebang", "tail"])).collect()).toMatchObject({
    kind: "exited",
    code: 0,
  });
  expect(args).toEqual(["/bin/fixture", "--argument", "/shebang", "tail"]);
});

test("a broken stdout pipe delivers the real SIGPIPE outcome", async () => {
  const owner = create();
  await owner.programs.onDemand(
    command(async ({ stdout }) => {
      await stdout.write(new Uint8Array(8192));
      return 0;
    }),
  );
  const shell = await commandShell(owner, cleanups);
  const output = new PipeController({ capacity: 4096, relay: "manual" });
  cleanups.push(() => output.dispose());
  const reader = output.retain(shell.root, "read");
  shell.descriptors.openAt(1, output.retain(shell.root, "write"), 64n, 0n);
  reader.close();
  const process = await shell.spawn("/bin/fixture", ["fixture"], [{ parent: 1, child: 1 }]);
  shell.descriptors.close(1);
  expect(await process.collect()).toMatchObject({ kind: "signaled", code: 13 });
});

test("full-pipe writes remain pending and removal waits for unawaited runtime I/O", async () => {
  const owner = create();
  const entered = deferred();
  const returnCode = deferred();
  let write: Promise<void> | undefined;
  await owner.programs.onDemand(
    command(async ({ stdout }) => {
      write = stdout.write(new Uint8Array(8192));
      entered.resolve();
      await returnCode.promise;
      return 0;
    }),
  );
  const { reader, child: process } = await stdoutCommand(owner);
  await entered.promise;
  let written = false;
  void write!.then(() => {
    written = true;
  });
  await Promise.resolve();
  expect(written).toBe(false);
  const removing = owner.programs.get("fixture")!.remove();
  let removed = false;
  void removing.then(() => {
    removed = true;
  });
  expect(removed).toBe(false);
  const bytes = new Uint8Array(4096);
  for (let read = 0; read < 8192;) {
    const count = reader.tryRead([bytes]);
    if (count === -6) {
      await reader.waitReadable();
      continue;
    }
    expect(count).toBeGreaterThan(0);
    read += count;
  }
  await write;
  expect(written).toBe(true);
  expect(removed).toBe(false);
  returnCode.resolve();
  expect(await process.collect()).toMatchObject({ code: 0 });
  await removing;
});

test("SIGCHLD is ignored and disposal waits for both callbacks and preparation", async () => {
  const owner = create();
  const entered = deferred();
  const physical = deferred();
  const loading = deferred();
  const loaderEntered = deferred();
  let aborted = false;
  let otherEntered = false;
  await owner.programs.onDemand(
    command(async ({ abort }) => {
      entered.resolve();
      await physical.promise;
      aborted = abort.aborted;
      return 0;
    }),
  );
  await owner.programs.onDemand({
    name: "loading",
    programs: [
      {
        path: "/loading",
        command: {
          load: async () => {
            loaderEntered.resolve();
            await loading.promise;
            return async () => {
              otherEntered = true;
              return 0;
            };
          },
        },
      },
    ],
  });
  const shell = await commandShell(owner, cleanups);
  const running = await shell.spawn("/bin/fixture");
  await entered.promise;
  await shell.service.kill(running.pid, 17);
  expect(shell.supervisor.get(running.pid)?.result).toBeNull();
  const preparing = failure(shell.spawn("/loading"));
  await loaderEntered.promise;
  let disposed = false;
  const disposal = owner.dispose();
  void disposal.then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  physical.resolve();
  await running.exit;
  expect(disposed).toBe(false);
  loading.resolve();
  await preparing;
  await disposal;
  expect(aborted).toBe(true);
  expect(otherEntered).toBe(false);
  runtime = undefined;
  const next = create();
  await next.dispose();
  runtime = undefined;
});

test("failed physical I/O cleanup retains disposal debt and the page guard", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./program-host-command-debt.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stdout).toContain("physical cleanup debt rejects disposal and retains the page guard");
  expect(stderr).toContain("injected physical I/O cleanup failure");
});

test("the page entry keeps command execution and stdio in lazy import chunks", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("../runtime.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: false,
  });
  expect(built.success).toBe(true);
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  expect(entry).toBeDefined();
  const text = await entry!.text();
  expect(text).not.toContain("function runCommand(");
  expect(text).not.toContain("class CommandStdio ");
  const chunks = await Promise.all(
    built.outputs.filter((output) => output.kind === "chunk").map((output) => output.text()),
  );
  expect(chunks.some((text) => text.includes("function runCommand("))).toBe(true);
  expect(chunks.some((text) => text.includes("class CommandStdio "))).toBe(true);
});

test("cancellation fences a pending unawaited pipe write without releasing the callback hold", async () => {
  const owner = create();
  const entered = deferred();
  const physical = deferred();
  let pending: Promise<void> | undefined;
  await owner.programs.onDemand(
    command(async ({ stdout }) => {
      pending = stdout.write(new Uint8Array(16384));
      entered.resolve();
      await physical.promise;
      return 0;
    }),
  );
  const { shell, child } = await stdoutCommand(owner);
  await entered.promise;
  await shell.service.kill(child.pid, 15);
  expect(await child.exit).toMatchObject({ kind: "signaled", code: 15 });
  expect(await failure(pending!)).toMatchObject({ code: "CANCELED" });
  const removal = owner.programs.get("fixture")!.remove();
  let removed = false;
  void removal.then(() => {
    removed = true;
  });
  await Promise.resolve();
  expect(removed).toBe(false);
  physical.resolve();
  await removal;
});

async function stdoutCommand(owner: Runtime) {
  const shell = await commandShell(owner, cleanups);
  const output = new PipeController({ capacity: 4096, relay: "manual" });
  cleanups.push(() => output.dispose());
  const reader = output.retain(shell.root, "read");
  cleanups.push(() => reader.close());
  shell.descriptors.openAt(1, output.retain(shell.root, "write"), 64n, 0n);
  const child = await shell.spawn("/bin/fixture", ["fixture"], [{ parent: 1, child: 1 }]);
  shell.descriptors.close(1);
  return { shell, reader, child };
}
