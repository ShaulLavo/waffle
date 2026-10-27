import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  fileUtilityEnvironment,
  initialTree,
  type FileTree,
} from "../tests/helpers/file-utility-cases.ts";

export async function recordFileUtilityCase(bash: string, script: string) {
  await mkdir(resolve(".build"), { recursive: true });
  const scratch = await mkdtemp(resolve(".build/file-utility-oracle-"));
  try {
    await seedNativeTree(scratch);
    const expected = spawnSync(bash, ["-c", script], {
      env: fileUtilityEnvironment,
      cwd: scratch,
      timeout: 5000,
    });
    if (expected.error) throw expected.error;
    return {
      diagnosticBytes: Array.from(expected.stderr),
      result: {
        status: expected.status,
        stdout: Array.from(expected.stdout),
        stderr: expected.stderr.length > 0,
        tree: await nativeTree(scratch),
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function seedNativeTree(scratch: string) {
  for (const [path, bytes] of Object.entries(initialTree)) {
    if (bytes === null) await mkdir(resolve(scratch, path));
    else await writeFile(resolve(scratch, path), Uint8Array.from(bytes));
  }
}

async function nativeTree(root: string, prefix = ""): Promise<FileTree> {
  const result: FileTree = {};
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name;
    result[path] = entry.isDirectory() ? null : Array.from(await readFile(resolve(root, path)));
    if (entry.isDirectory()) Object.assign(result, await nativeTree(root, `${path}/`));
  }
  return result;
}
