import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCleanupError, runOwned } from "../scripts/owned-command.ts";

const runners = ["storage", "storage-lock", "process-recycling"];
const fixture = `
import { existsSync, writeFileSync } from "node:fs";
const names = ${JSON.stringify(runners)};
const name = process.argv[1].split("/").at(-1).replace("-browser-runner.ts", "");
if (process.argv.slice(2).join(",") !== "chromium,firefox,webkit") throw Error("missing engine");
writeFileSync(name + ".started", "");
while (!names.every((entry) => existsSync(entry + ".started"))) await Bun.sleep(10);
writeFileSync(name + ".finished", "all engines");
if (process.env.MATRIX_FAIL === name) throw Error("fixture failure");
`;

async function matrix(failing: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "waffle-browser-matrix-"));
  let cleanupError: CommandCleanupError | undefined;
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "tests"));
    await copyFile(
      join(import.meta.dir, "../scripts/test-browser.ts"),
      join(root, "scripts/test-browser.ts"),
    );
    await copyFile(
      join(import.meta.dir, "../scripts/owned-command.ts"),
      join(root, "scripts/owned-command.ts"),
    );
    for (const runner of runners)
      await writeFile(join(root, "tests", `${runner}-browser-runner.ts`), fixture);
    let failure: unknown;
    try {
      await runOwned([process.execPath, "scripts/test-browser.ts"], {
        cwd: root,
        env: { ...process.env, MATRIX_FAIL: failing },
        timeoutMs: 5000,
      });
    } catch (error) {
      cleanupError = error instanceof CommandCleanupError ? error : undefined;
      failure = error;
    }
    expect(cleanupError).toBeUndefined();
    expect(failure instanceof Error).toBe(failing !== "");
    for (const runner of runners)
      expect(await readFile(join(root, `${runner}.finished`), "utf8")).toBe("all engines");
  } finally {
    if (cleanupError) console.error(`Retained browser matrix scratch: ${root}`, cleanupError);
    else await rm(root, { recursive: true, force: true });
  }
}

test("browser matrix launches all suites concurrently with every engine", async () => {
  await matrix("");
}, 15_000);

test("a failed browser suite remains blocking without hiding the other suites", async () => {
  await matrix("storage");
}, 15_000);
