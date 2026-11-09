import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const controls = "tests/page-runner/browser-controls-runner.ts";
async function discover(failure = ""): Promise<{ code: number; commands: string[][] }> {
  const root = await mkdtemp(join(tmpdir(), "controls-discovery-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(join(root, "scripts"));
    await copyFile(
      join(import.meta.dir, "../scripts/test-browser.ts"),
      join(root, "scripts/test-browser.ts"),
    );
    await writeFile(
      join(root, "scripts/browser-command.ts"),
      `import { appendFileSync } from "node:fs";
export async function runBrowserSuite(command: string[]) {
  const args=command.slice(1);
  appendFileSync("commands.jsonl", JSON.stringify(args)+"\\n");
  if(args[0] === ${JSON.stringify(controls)} && args.includes(process.env.FAIL_CONTROL ?? ""))
    throw new Error("Control command failed");
}
`,
    );
    const launched = Bun.spawn([process.execPath, "scripts/test-browser.ts"], {
      cwd: root,
      env: { ...process.env, WAFFLE_BROWSER_GROUP: "serial", FAIL_CONTROL: failure },
      stdout: "ignore",
      stderr: "pipe",
    });
    child = launched;
    const [code] = await Promise.all([launched.exited, new Response(launched.stderr).text()]);
    const commands: string[][] = (await readFile(join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { code, commands };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}

for (const failure of ["", "--prepare", "chromium", "webkit"])
  test(`reporter controls prepare once and keep engine failures blocking: ${failure || "pass"}`, async () => {
    const result = await discover(failure);
    expect(result.code).toBe(failure ? 1 : 0);
    expect(result.commands.filter((command) => command[0] === controls)).toEqual([
      [controls, "--prepare"],
      [controls, "chromium", "--prepared"],
      [controls, "webkit", "--prepared"],
    ]);
    const lastControl = result.commands.findIndex(
      (command) => command[0] === controls && command[1] === "webkit",
    );
    expect(result.commands[lastControl + 1]).toEqual([
      "tests/process-recycling-browser-runner.ts",
      "--page-controls",
      "chromium",
    ]);
  });
