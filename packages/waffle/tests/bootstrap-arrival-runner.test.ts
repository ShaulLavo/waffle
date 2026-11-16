import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBrowserSuite } from "../scripts/browser-command.js";

for (const dispatcher of [false, true])
  test.skipIf(process.platform !== "linux")(
    `bootstrap runner shares its outer supervisor, dispatcher TMPDIR=${dispatcher}`,
    async () => {
      const base = await realpath(existsSync("/work/tmp") ? "/work/tmp" : "/tmp");
      const prefix = join(base, "bha-");
      const length = dispatcher ? 47 : "/home/runner/work/_temp".length;
      const root = await mkdtemp(prefix + "x".repeat(length - prefix.length - 6));
      try {
        expect((await realpath(root)).length).toBe(length);
        await mkdir(join(root, "scripts"));
        await mkdir(join(root, "tests/page-runner"), { recursive: true });
        for (const file of ["browser-command.ts", "browser-supervisor.ts", "owned-command.ts"])
          await copyFile(resolve(import.meta.dir, "../scripts", file), join(root, "scripts", file));
        await copyFile(
          join(import.meta.dir, "bootstrap-arrival-browser-runner.ts"),
          join(root, "tests/bootstrap-arrival-browser-runner.ts"),
        );
        await writeFile(join(root, "owner-data"), "retained");
        await writeFile(
          join(root, "tests/page-runner/bootstrap-arrival-browser.test.ts"),
          `import { test, expect } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { BrowserRunnerLifecycle } from ${JSON.stringify(join(import.meta.dir, "browser-runner-lifecycle.ts"))};
test("actual lifecycle accepts the runner's physical scratch", async () => {
  const lifecycle = new BrowserRunnerLifecycle(60000, 5000, undefined, "caller");
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT, "bac-"));
  try {
    await lifecycle.init(dirname(root));
    const tmp = await realpath(process.env.TMPDIR);
    expect(tmp.length).toBeLessThanOrEqual(48);
    await writeFile(join(process.env.PROBE, "observed.json"), JSON.stringify({ tmp, scratch: process.env.SCRATCH, owned: process.env.STORAGE_SCRATCH_ROOT, shm: process.env.WAFFLE_BROWSER_SHM_ROOT }));
  } finally { await lifecycle.close(); await rm(root, { recursive: true, force: true }); }
});`,
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PROBE: root,
          TMPDIR: root,
          STORAGE_SCRATCH_ROOT: root,
        };
        if (dispatcher) env.SCRATCH = root;
        else delete env.SCRATCH;
        await runBrowserSuite(
          [process.execPath, join(root, "tests/bootstrap-arrival-browser-runner.ts"), "webkit"],
          { cwd: root, env },
        );
        const observed: unknown = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
        if (
          !observed ||
          typeof observed !== "object" ||
          !("shm" in observed) ||
          typeof observed.shm !== "string"
        )
          throw new Error("Missing supervisor shared-memory ownership");
        expect(existsSync(observed.shm)).toBe(false);
        expect(observed).toMatchObject({
          owned: expect.stringMatching(new RegExp(`^${root}/wb-[^/]+$`)),
        });
        if (dispatcher) expect(observed).toMatchObject({ tmp: root, scratch: root });
        expect(await readFile(join(root, "owner-data"), "utf8")).toBe("retained");
        expect((await readdir(root)).sort()).toEqual([
          "observed.json",
          "owner-data",
          "scripts",
          "tests",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
