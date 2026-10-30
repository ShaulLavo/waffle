import { expect, test } from "bun:test";
import { createRuntime } from "../../waffle/runtime.ts";
import { ExecutableRegistry } from "../../waffle/proc/registry.ts";
import { ProcessSupervisor } from "../../waffle/proc/supervisor.ts";
import { checkedSignal } from "../../waffle/proc/types.ts";
import { processRows } from "../src/index.ts";

// These controls distinguish runtime support from this package's unimplemented command adapter.
test("real Runtime rejects incomplete Wasm definitions but accepts unloaded host commands", async () => {
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  let launched = 0;
  let loaded = 0;
  try {
    runtime.registerAdapter("procps-gap-control", () => {
      launched++;
      throw new Error("incomplete Wasm definitions must not reach this launcher");
    });
    await runtime.filesystem.mkdirp("/usr/bin");
    await runtime.filesystem.writeFile("/usr/bin/ps", "procps registration control\n");
    expect(() =>
      Reflect.apply(runtime.registerProgram, runtime, [
        "/usr/bin/ps",
        { adapter: "procps-gap-control" },
      ]),
    ).toThrow("Compiled modules require cooperative: true");
    expect(() =>
      Reflect.apply(runtime.registerProgram, runtime, [
        "/usr/bin/ps",
        { adapter: "procps-gap-control", cooperative: true },
      ]),
    ).toThrow("Program module must provide a compiled WebAssembly.Module");
    const supervisor = await (await runtime.processes()).ready();
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, {
      executable: "/usr/bin/ps",
      argv: ["ps", "-e", "-o", "pid"],
      cwd: "/",
      env: {},
      job: -1,
      fds: [],
    });
    await supervisor.start(child);
    expect(supervisor.get(child)?.result).toMatchObject({ kind: "start-failed", error: "ENOEXEC" });
    expect(launched).toBe(0);
    const release = runtime.registerProgram("/usr/bin/procps-contract-control", {
      command: {
        load: async () => {
          loaded++;
          throw new Error("registration-only control must not load a command");
        },
      },
    });
    expect(loaded).toBe(0);
    release();
    expect(loaded).toBe(0);
  } finally {
    await runtime.dispose();
  }
  expect(runtime.disposed).toBe(true);
}, 15_000);

test("ordinary supervisor authority still denies a pkill sibling without delegated signals", () => {
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch: () => {
      throw new Error("no guest is launched by this reservation control");
    },
  });
  try {
    const root = supervisor.createRoot();
    const request = {
      executable: "/bin/fixture",
      argv: ["fixture", "owned"],
      cwd: "/",
      env: {},
      job: -1,
      fds: [],
    };
    const target = supervisor.reserveSpawn(root, request);
    const pkill = supervisor.reserveSpawn(root, {
      ...request,
      executable: "/usr/bin/pkill",
      argv: ["pkill", "-P", String(root), "fixture"],
    });
    expect(processRows(supervisor.table.values())).toEqual([
      { pid: target, parentPid: root, comm: "fixture", args: "fixture owned" },
      { pid: pkill, parentPid: root, comm: "pkill", args: `pkill -P ${root} fixture` },
    ]);
    expect(supervisor.canSignal(pkill, target)).toBe(false);
    expect(supervisor.canSignal(root, target)).toBe(true);
    expect(supervisor.get(target)?.result).toBeNull();
  } finally {
    supervisor.dispose();
  }
  expect(Array.from(supervisor.table.values())).toEqual([]);
});

test("current Waffle signal validation still rejects signal zero and unsupported stop signals", () => {
  for (const signal of [1, 2, 9, 10, 13, 15, 18, 64]) expect(checkedSignal(signal)).toBe(signal);
  for (const signal of [0, 19, 20, 21, 22, 32, 33, 65])
    expect(() => checkedSignal(signal)).toThrow();
});
