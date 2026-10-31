import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createRuntime, type Runtime } from "../../waffle/runtime.ts";
import { defineProgramPackage } from "../../waffle/programs/catalog.ts";
import type { HostCommandContext } from "waffle/proc/command";
import { PipeController } from "../../waffle/proc/pipes.ts";
import { commandShell } from "../../waffle/tests/program-host-command-fixture.ts";
import { procps } from "../src/catalog.ts";

type Shell = Awaited<ReturnType<typeof commandShell>>;
let runtime: Runtime | undefined;
let cleanup: Array<() => void | Promise<void>> = [];
let release: Array<() => void> = [];
afterEach(async () => {
  for (const resolve of release) resolve();
  release = [];
  await runtime?.dispose();
  runtime = undefined;
  for (const close of cleanup.toReversed()) await close();
  cleanup = [];
});

function create() {
  runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  return runtime;
}

function gate() {
  const deferred = Promise.withResolvers<void>();
  release.push(deferred.resolve);
  return deferred;
}

async function setup(granted = false) {
  const owner = create();
  await owner.programs.onDemand(procps);
  const shell = await commandShell(owner, cleanup, {
    signalDelegation: { packages: granted ? [procps] : [] },
  });
  await shell.file(1, "/out");
  await shell.file(2, "/err");
  return { owner, shell };
}

const stdio = [
  { parent: 1, child: 1 },
  { parent: 2, child: 2 },
];
async function run(shell: Shell, name: string, args: string[] = []) {
  const child = await shell.spawn(`/bin/${name}`, [name].concat(args), stdio);
  const result = await child.collect();
  const stdout = new TextDecoder().decode(await runtime!.filesystem.readFile("/out"));
  const stderr = new TextDecoder().decode(await runtime!.filesystem.readFile("/err"));
  return { child, result, stdout, stderr };
}

async function target(owner: Runtime, shell: Shell, path = "/fixture", arg = "owned") {
  const ended = gate();
  const physical = gate();
  await owner.programs.onDemand(
    defineProgramPackage({
      name: path,
      programs: [
        {
          path,
          command: {
            load:
              async () =>
              async ({ abort }) => {
                abort.addEventListener("abort", () => ended.resolve(), { once: true });
                if (abort.aborted) ended.resolve();
                await ended.promise;
                await physical.promise;
                return 0;
              },
          },
        },
      ],
    }),
  );
  const child = await shell.spawn(path, [path, arg]);
  return { ...child, ended, physical };
}

function definition(name: string) {
  const entry = procps.programs.find((program) => program.path === `/usr/bin/${name}`);
  if (!entry) throw new Error(`Missing ${name}`);
  return entry.command;
}

// Test-only scheduling hooks keep the real context and genuine runtime grant. No send callback
// is supplied to the production adapter, and no host or raw supervisor signal is used.
function intercept(name: string, before: (context: HostCommandContext) => void) {
  const def = definition(name);
  const load = def.load;
  const spy = spyOn(def, "load").mockImplementation(async () => {
    const command = await load();
    return (context) =>
      command({
        ...context,
        processes: {
          snapshot: () => {
            const rows = context.processes.snapshot();
            before(context);
            return rows;
          },
        },
      });
  });
  cleanup.push(() => {
    spy.mockRestore();
  });
  return spy;
}

test("optional catalog is lazy, and aliases and picks retain one definition and loader", async () => {
  const owner = create();
  const def = definition("ps");
  const load = spyOn(def, "load");
  cleanup.push(() => {
    load.mockRestore();
  });
  expect(procps.pick("ps", "/bin/ps").programs).toEqual([procps.programs[0]!]);
  expect(procps.pick("/bin/ps").programs[0]).toBe(procps.programs[0]);
  await owner.programs.onDemand(procps.pick("ps"));
  expect(load).not.toHaveBeenCalled();
  expect(owner.programs.get("ps")!.state).toEqual({ kind: "registered" });
  await Promise.all([
    owner.programs.get("ps")!.preload(),
    owner.programs.get("/bin/ps")!.preload(),
  ]);
  expect(load).toHaveBeenCalledTimes(1);
  const shell = await commandShell(owner, cleanup);
  await shell.file(1, "/out");
  expect(
    await (
      await shell.spawn("/bin/ps", ["arbitrary-argv0", "-e", "-o", "comm="], stdio.slice(0, 1))
    ).collect(),
  ).toMatchObject({ code: 0 });
  expect(load).toHaveBeenCalledTimes(1);
  await owner.programs.get("ps")!.remove();
  expect(await (await shell.spawn("/usr/bin/ps")).collect()).toMatchObject({
    kind: "start-failed",
    error: "ENOENT",
  });
});

test("ps and pgrep execute against real admitted rows, not host metadata or argv0 names", async () => {
  const { owner, shell } = await setup();
  const fixture = await target(owner, shell, "/owned-alpha", "argv with spaces");
  const foreign = await commandShell(owner, cleanup);
  await target(owner, foreign, "/foreign-alpha");
  const ps = await run(shell, "ps", [
    "-p",
    String(fixture.pid),
    "-o",
    "pid=,ppid=,comm=,args=",
    "-ww",
  ]);
  expect(ps.result).toMatchObject({ kind: "exited", code: 0 });
  expect(ps.stdout).toBe(
    `${String(fixture.pid).padStart(7)} ${String(shell.root).padStart(7)} owned-alpha     /owned-alpha argv with spaces\n`,
  );
  expect(ps.stderr).toBe("");
  shell.descriptors.close(1);
  await shell.file(1, "/out");
  const pgrep = await run(shell, "pgrep", ["-fa", "alpha"]);
  expect(pgrep.result).toMatchObject({ code: 0 });
  expect(pgrep.stdout).toBe(`${fixture.pid} /owned-alpha argv with spaces\n`);
});

test("pkill without a controller grant denies delivery and reports absent authority", async () => {
  const { owner, shell } = await setup();
  const fixture = await target(owner, shell);
  const result = await run(shell, "pkill", ["-x", "fixture"]);
  expect(result.result).toMatchObject({ code: 1 });
  expect(result.stderr).toBe("pkill: delegated signal authority is absent\n");
  expect(shell.supervisor.get(fixture.pid)?.result).toBeNull();
});

test.each(["TERM", "INT", "KILL", "PIPE"])(
  "granted pkill %s signals an owned sibling and removal waits for physical completion",
  async (signal) => {
    const { owner, shell } = await setup(true);
    const fixture = await target(owner, shell);
    const sent = await run(shell, "pkill", [`-${signal}`, "-x", "fixture"]);
    expect(sent.result).toMatchObject({ kind: "exited", code: 0 });
    expect(sent.stderr).toBe("");
    const code = { TERM: 15, INT: 2, KILL: 9, PIPE: 13 }[signal];
    expect(await fixture.collect()).toMatchObject({ kind: "signaled", code });
    let removed = false;
    const removing = owner.programs
      .get("fixture")!
      .remove()
      .then(() => {
        removed = true;
      });
    await Promise.resolve();
    expect(removed).toBe(false);
    fixture.physical.resolve();
    await removing;
    expect(removed).toBe(true);
  },
);

test("no match and unsupported signal zero do not signal an owned target", async () => {
  const { owner, shell } = await setup(true);
  const fixture = await target(owner, shell);
  expect((await run(shell, "pkill", ["absent"])).result).toMatchObject({ code: 1 });
  const zero = await run(shell, "pkill", ["-0", "fixture"]);
  expect(zero.result).toMatchObject({ code: 2 });
  expect(zero.stderr).toContain("unsupported: signal zero");
  expect(shell.supervisor.get(fixture.pid)?.result).toBeNull();
});

test("a stale selected target is missing, not a successful planned send", async () => {
  let sends = 0;
  intercept("pkill", (context) => {
    const row = context.processes.snapshot().find((row) => row.executable === "/fixture");
    expect(context.signals!.send(row!.pid, 15)).toBe("sent");
    sends++;
  });
  const { owner, shell } = await setup(true);
  const fixture = await target(owner, shell);
  const result = await run(shell, "pkill", ["fixture"]);
  expect(result.result).toMatchObject({ code: 1 });
  expect(result.stderr).toBe(`pkill: ${fixture.pid}: target is missing or has exited\n`);
  expect(sends).toBe(1);
  fixture.physical.resolve();
  await fixture.collect();
});

test("partial delivery succeeds only after a real send and preserves stale-target diagnostics", async () => {
  intercept("pkill", (context) => {
    const row = context.processes.snapshot().find((row) => row.executable === "/fixture-old");
    expect(context.signals!.send(row!.pid, 15)).toBe("sent");
  });
  const { owner, shell } = await setup(true);
  const stale = await target(owner, shell, "/fixture-old");
  const live = await target(owner, shell, "/fixture-live");
  const result = await run(shell, "pkill", ["^fixture-"]);
  expect(result.result).toMatchObject({ code: 0 });
  expect(result.stderr).toBe(`pkill: ${stale.pid}: target is missing or has exited\n`);
  stale.physical.resolve();
  live.physical.resolve();
  expect(await stale.collect()).toMatchObject({ kind: "signaled", code: 15 });
  expect(await live.collect()).toMatchObject({ kind: "signaled", code: 15 });
});

test("removing pkill after selection revokes genuine authority without signaling its target", async () => {
  let removing: Promise<void> | undefined;
  intercept("pkill", () => {
    removing = runtime!.programs.get("pkill")!.remove();
  });
  const { owner, shell } = await setup(true);
  const fixture = await target(owner, shell);
  const result = await run(shell, "pkill", ["fixture"]);
  expect(result.result).toMatchObject({ code: 1 });
  expect(result.stderr).toBe(`pkill: ${fixture.pid}: delegated signal authority was revoked\n`);
  expect(shell.supervisor.get(fixture.pid)?.result).toBeNull();
  await removing;
  expect(await (await shell.spawn("/bin/pkill")).collect()).toMatchObject({ kind: "start-failed" });
});

async function outputPipe(shell: Shell) {
  const pipe = new PipeController({ capacity: 4096, relay: "manual" });
  const reader = pipe.retain(shell.root, "read");
  cleanup.push(
    () => pipe.dispose(),
    () => reader.close(),
  );
  shell.descriptors.close(1);
  shell.descriptors.openAt(1, pipe.retain(shell.root, "write"), 64n, 0n);
  return reader;
}

test("ps output crosses a bounded pipe without consuming stdin, and uninstall fences its writes", async () => {
  const { owner, shell } = await setup();
  const fixture = await target(owner, shell, "/fixture", "x".repeat(24_000));
  const reader = await outputPipe(shell);
  const child = await shell.spawn(
    "/bin/ps",
    ["ps", "-p", String(fixture.pid), "-o", "args=", "-ww"],
    [{ parent: 1, child: 1 }],
  );
  shell.descriptors.close(1);
  await reader.waitReadable();
  let removed = false;
  const removing = owner.programs
    .get("ps")!
    .remove()
    .then(() => {
      removed = true;
    });
  await Promise.resolve();
  expect(removed).toBe(false);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = new Uint8Array(1024);
    const count = reader.tryRead([chunk]);
    if (count === -6) {
      await reader.waitReadable();
      continue;
    }
    if (count === 0) break;
    expect(count).toBeGreaterThan(0);
    chunks.push(chunk.slice(0, count));
  }
  expect(await child.collect()).toMatchObject({ code: 0 });
  await removing;
  expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(`/fixture ${"x".repeat(24_000)}\n`);
});

test("broken output pipes deliver SIGPIPE and missing stdout cannot report success", async () => {
  const { shell } = await setup();
  const reader = await outputPipe(shell);
  reader.close();
  const child = await shell.spawn("/bin/ps", ["ps", "-e", "-o", "pid"], [{ parent: 1, child: 1 }]);
  shell.descriptors.close(1);
  expect(await child.collect()).toMatchObject({ kind: "signaled", code: 13 });
  const missing = await shell.spawn("/bin/ps", ["ps", "-e", "-o", "pid"]);
  expect(await missing.collect()).toMatchObject({ kind: "exited", code: 126 });
});

test("delegated abort cancels blocked ps output and releases the removal fence", async () => {
  const { owner, shell } = await setup(true);
  await target(owner, shell, "/fixture", "x".repeat(24_000));
  const reader = await outputPipe(shell);
  const child = await shell.spawn(
    "/bin/ps",
    ["ps", "-e", "-o", "args=", "-ww"],
    [{ parent: 1, child: 1 }],
  );
  shell.descriptors.close(1);
  await reader.waitReadable();
  const cancel = await shell.spawn("/bin/pkill", ["pkill", "-x", "ps"]);
  expect(await cancel.collect()).toMatchObject({ code: 0 });
  expect(await child.collect()).toMatchObject({ kind: "signaled", code: 15 });
  await owner.programs.get("ps")!.remove();
});

test("runtime disposal cancels blocked procps output and keeps caller ownership", async () => {
  const { owner, shell } = await setup();
  const fixture = await target(owner, shell, "/fixture", "x".repeat(24_000));
  const reader = await outputPipe(shell);
  const child = await shell.spawn(
    "/bin/ps",
    ["ps", "-e", "-o", "args=", "-ww"],
    [{ parent: 1, child: 1 }],
  );
  shell.descriptors.close(1);
  await reader.waitReadable();
  let disposed = false;
  const disposing = owner.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  fixture.physical.resolve();
  await child.exit;
  await disposing;
  expect(owner.disposed).toBe(true);
  expect(Array.from(shell.supervisor.table.values())).toEqual([]);
});

test("uninstall during lazy preparation never enters the adapter", async () => {
  const loading = gate();
  const entered = gate();
  const def = definition("ps");
  const original = def.load;
  let ran = false;
  const spy = spyOn(def, "load").mockImplementation(async () => {
    entered.resolve();
    await loading.promise;
    const command = await original();
    return (context) => {
      ran = true;
      return command(context);
    };
  });
  cleanup.push(() => {
    spy.mockRestore();
  });
  const { owner, shell } = await setup();
  const pending = shell.spawn("/bin/ps", ["ps", "-e", "-o", "pid"]);
  await entered.promise;
  const removing = owner.programs.get("ps")!.remove();
  loading.resolve();
  expect(await (await pending).collect()).toMatchObject({ kind: "start-failed" });
  await removing;
  expect(ran).toBe(false);
});

test("a real grant denies foreign roots and the controller root, then is revoked on exit", async () => {
  let foreignPid = 0;
  let rootPid = 0;
  let captured: HostCommandContext | undefined;
  intercept("pkill", (context) => {
    captured = context;
    expect(context.signals!.send(foreignPid, 15)).toBe("denied");
    expect(context.signals!.send(rootPid, 15)).toBe("denied");
  });
  const { owner, shell } = await setup(true);
  rootPid = shell.root;
  const foreign = await commandShell(owner, cleanup);
  const foreignTarget = await target(owner, foreign, "/foreign-fixture");
  foreignPid = foreignTarget.pid;
  const own = await target(owner, shell, "/own-fixture");
  expect((await run(shell, "pkill", ["-x", "own-fixture"])).result).toMatchObject({ code: 0 });
  expect(shell.supervisor.get(foreignPid)?.result).toBeNull();
  expect(shell.supervisor.get(shell.root)?.result).toBeNull();
  expect(captured!.signals!.send(foreignPid, 15)).toBe("revoked");
  own.physical.resolve();
  await own.collect();
});

test("abort during a failed-send diagnostic never signals the next selected target", async () => {
  const blocked = gate();
  const physical = gate();
  const def = definition("pkill");
  const load = def.load;
  const spy = spyOn(def, "load").mockImplementation(async () => {
    const command = await load();
    return (context) =>
      command(
        context.request.argv[1] !== "^fixture-"
          ? context
          : {
              ...context,
              processes: {
                snapshot: () => {
                  const rows = context.processes.snapshot();
                  const stale = rows.find((row) => row.executable === "/fixture-old");
                  expect(context.signals!.send(stale!.pid, 15)).toBe("sent");
                  return rows;
                },
              },
              stderr: {
                write: async (bytes) => {
                  blocked.resolve();
                  await physical.promise;
                  await context.stderr.write(bytes);
                },
              },
            },
      );
  });
  cleanup.push(() => {
    spy.mockRestore();
  });
  const { owner, shell } = await setup(true);
  const stale = await target(owner, shell, "/fixture-old");
  const live = await target(owner, shell, "/fixture-live");
  const child = await shell.spawn("/bin/pkill", ["pkill", "^fixture-"], stdio);
  await blocked.promise;
  const cancel = await shell.spawn("/bin/pkill", ["pkill", "-x", "pkill"]);
  expect(await cancel.collect()).toMatchObject({ code: 0 });
  expect(await child.collect()).toMatchObject({ kind: "signaled", code: 15 });
  let removed = false;
  const removing = owner.programs
    .get("pkill")!
    .remove()
    .then(() => {
      removed = true;
    });
  await Promise.resolve();
  expect(removed).toBe(false);
  physical.resolve();
  await removing;
  expect(shell.supervisor.get(live.pid)?.result).toBeNull();
  stale.physical.resolve();
  await stale.collect();
});

test("a picked alias retains the catalog identity used for signal grants", async () => {
  const owner = create();
  await owner.programs.onDemand(procps.pick("/bin/pkill"));
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: [procps] } });
  const fixture = await target(owner, shell);
  const child = await shell.spawn("/bin/pkill", ["pkill", "-x", "fixture"]);
  expect(await child.collect()).toMatchObject({ kind: "exited", code: 0 });
  fixture.physical.resolve();
  expect(await fixture.collect()).toMatchObject({ kind: "signaled", code: 15 });
});

test("failed diagnostic writes are runtime failures, not parser-status success", async () => {
  const { shell } = await setup();
  const child = await shell.spawn("/bin/pgrep", ["pgrep", "--not-supported"]);
  expect(await child.collect()).toMatchObject({ kind: "exited", code: 126 });
});
