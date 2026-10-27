import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { findDirectories, findFiles } from "../tests/helpers/find-cases.ts";

export async function findOracle(context: TestContext) {
  const root = resolve(".build/find-oracle");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(`${root}/run-`);
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of findDirectories) await mkdir(resolve(directory, path), { recursive: true });
  for (const [path, contents] of findFiles) await writeFile(resolve(directory, path), contents);
  return (script: string) => nativeFind(script, directory);
}

function nativeFind(script: string, directory: string) {
  return new Promise<{ status: number; stdout: Buffer; stderr: Buffer }>((done, reject) => {
    execFile(
      "bash",
      ["-c", script],
      {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        const status = error?.code ?? 0;
        if (typeof status !== "number") return reject(error);
        done({ status, stdout, stderr });
      },
    );
  });
}
