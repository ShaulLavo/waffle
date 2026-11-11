import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { fstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nativeMain } from "./native.js";
import { SafariDriver } from "./safari-driver.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";

const udid = "C4D2FFD4-A0D2-4608-B180-35854521B830";
const output = "owned launcher stdout\nowned launcher stderr\n";
const launcherFailure = "LOCAL_LAUNCHER_BOUNDARY";
const adapter: SuiteAdapter<null> = {
  suite: "launcher-log-control",
  inventory: () => [{ id: "unused", label: "unused", request: () => null }],
  assets: async () => ({ "/page.js": "" }),
  policy: { listIds: () => ["unused"], check() {} },
  budgets: () => ({ hello: 500, heartbeat: 500, case: 1000, group: 1000, run: 5000 }),
};

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const parent = process.env.STORAGE_SCRATCH_ROOT ?? tmpdir();
  const root = await mkdtemp(join(parent, "wd-log-"));
  try {
    expect(dirname(root)).toBe(resolve(parent));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function launcherBoundary(inspect: () => void = () => {}) {
  let descriptor: number | undefined;
  const spawn = spyOn(childProcess, "spawn").mockImplementation(
    (
      command,
      args?: readonly string[] | childProcess.SpawnOptions,
      options?: childProcess.SpawnOptions,
    ) => {
      expect(command).toBe("/usr/bin/safaridriver");
      expect(args).toEqual(["-p", expect.stringMatching(/^\d+$/)]);
      const stdio = options?.stdio;
      if (!Array.isArray(stdio) || typeof stdio[1] !== "number")
        throw new Error("Launcher did not receive an open output descriptor");
      expect(stdio).toEqual(["ignore", stdio[1], stdio[1]]);
      descriptor = stdio[1];
      expect(fstatSync(descriptor).isFile()).toBe(true);
      const child = childProcess.spawnSync(
        process.execPath,
        [
          "-e",
          'process.stdout.write("owned launcher stdout\\n"); process.stderr.write("owned launcher stderr\\n");',
        ],
        { stdio, timeout: 2000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      inspect();
      throw new Error(launcherFailure);
    },
  );
  return {
    spawn,
    closed() {
      expect(descriptor).toBeDefined();
      if (descriptor === undefined) throw new Error("Missing launcher output descriptor");
      const closed = descriptor;
      expect(() => fstatSync(closed)).toThrow();
    },
  };
}

async function nativeControl(resultPath: string, scratchRoot: string): Promise<number> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("Missing process platform descriptor");
  const previous = process.env.IOS_UDID;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  process.env.IOS_UDID = udid;
  try {
    return await nativeMain(adapter, ["--result", resultPath], {
      scratchRoot,
      port: "ephemeral",
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete process.env.IOS_UDID;
    else process.env.IOS_UDID = previous;
  }
}

test("native launcher output survives actual SDK scratch removal beside a newly nested result", () =>
  withRoot(async (root) => {
    const scratch = join(root, "scratch");
    const resultPath = join(root, "results", "nested", "result.json");
    const boundary = launcherBoundary();
    try {
      expect(await nativeControl(resultPath, scratch)).toBe(2);
      expect(boundary.spawn).toHaveBeenCalledTimes(1);
      boundary.closed();
      expect(await readFile(`${resultPath}.safaridriver.log`, "utf8")).toBe(output);
      expect((await stat(`${resultPath}.safaridriver.log`)).mode & 0o777).toBe(0o600);
      const result = await Bun.file(resultPath).json();
      expect(result.exit).toBe(2);
      expect(
        result.failures.some((item: { detail: string }) => item.detail.includes(launcherFailure)),
      ).toBe(true);
      expect(result.cleanup.scratch.status).toBe("confirmed");
      expect(result.cleanup.session.status).toBe("not-created");
      expect(result.cleanup.launcher.status).toBe("not-created");
      expect(result.cleanup.server.status).toBe("confirmed");
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      boundary.spawn.mockRestore();
    }
  }));

test("retained diagnostics tighten an existing file without changing the parent directory", () =>
  withRoot(async (root) => {
    const resultPath = join(root, "result.json");
    const log = `${resultPath}.safaridriver.log`;
    await chmod(root, 0o750);
    const before = await stat(root);
    await writeFile(log, "previous run\n", { mode: 0o644 });
    const boundary = launcherBoundary();
    try {
      expect(await nativeControl(resultPath, join(root, "scratch"))).toBe(2);
      const result = await Bun.file(resultPath).json();
      expect(
        result.failures.some((item: { detail: string }) => item.detail.includes(launcherFailure)),
      ).toBe(true);
      expect(await readFile(log, "utf8")).toBe(output);
      expect((await stat(log)).mode & 0o777).toBe(0o600);
      const after = await stat(root);
      expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]);
      boundary.closed();
    } finally {
      boundary.spawn.mockRestore();
    }
  }));

test("unopenable native log returns nonzero before any launcher and keeps SDK cleanup", () =>
  withRoot(async (root) => {
    const resultPath = join(root, "result.json");
    const scratch = join(root, "scratch");
    await mkdir(`${resultPath}.safaridriver.log`);
    const boundary = launcherBoundary();
    try {
      expect(await nativeControl(resultPath, scratch)).toBe(2);
      expect(boundary.spawn).not.toHaveBeenCalled();
      const result = await Bun.file(resultPath).json();
      expect(
        result.failures.some((item: { detail: string }) => item.detail.includes("EISDIR")),
      ).toBe(true);
      expect(result.cleanup.launcher.status).toBe("not-created");
      expect(result.cleanup.scratch.status).toBe("confirmed");
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      boundary.spawn.mockRestore();
    }
  }));

test("SafariDriver rejects a missing destination parent before launch", () =>
  withRoot(async (root) => {
    const boundary = launcherBoundary();
    const driver = new SafariDriver(udid, root, undefined, undefined, join(root, "absent", "log"));
    try {
      await expect(driver.start(AbortSignal.timeout(1000))).rejects.toThrow("ENOENT");
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect((await driver.stop()).launcher.status).toBe("not-created");
    } finally {
      await driver.stop();
      boundary.spawn.mockRestore();
    }
  }));

test("callers without a destination still log to scratch and SDK removes that log", () =>
  withRoot(async (root) => {
    let scratch = "";
    const boundary = launcherBoundary(() => {
      expect(Bun.file(join(scratch, "safaridriver.log")).size).toBe(Buffer.byteLength(output));
    });
    try {
      const result = await runPageSuite(
        adapter,
        (owned) => {
          scratch = owned;
          return new SafariDriver(udid, owned);
        },
        { scratchRoot: root, resultPath: join(root, "result.json"), port: "ephemeral" },
      );
      expect(result.exit).toBe(2);
      expect(result.failures.some((item) => item.detail.includes(launcherFailure))).toBe(true);
      expect(boundary.spawn).toHaveBeenCalledTimes(1);
      boundary.closed();
      expect(result.cleanup.scratch.status).toBe("confirmed");
      expect(await Bun.file(join(scratch, "safaridriver.log")).exists()).toBe(false);
      expect(await readdir(root)).toEqual(["result.json"]);
    } finally {
      boundary.spawn.mockRestore();
    }
  }));
