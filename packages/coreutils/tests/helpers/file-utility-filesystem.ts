import type { Runtime } from "waffle";
import { initialTree, type FileTree } from "./file-utility-cases.ts";

export async function seedFileUtilityTree(runtime: Runtime) {
  await runtime.filesystem.mkdirp("/tmp/spec");
  for (const [path, bytes] of Object.entries(initialTree)) {
    if (bytes === null) await runtime.filesystem.mkdirp(`/tmp/spec/${path}`);
    else await runtime.filesystem.writeFile(`/tmp/spec/${path}`, Uint8Array.from(bytes));
  }
}

export async function fileUtilityTree(runtime: Runtime, prefix = ""): Promise<FileTree> {
  const result: FileTree = {};
  const entry = await runtime.filesystem.lookup(`/tmp/spec/${prefix}`);
  if (entry?.kind !== "dir") throw new Error("Missing case directory");
  for (const [name, child] of entry.children) {
    const path = prefix + name;
    result[path] =
      child.kind === "dir"
        ? null
        : Array.from((await runtime.filesystem.readFile(`/tmp/spec/${path}`))!);
    if (child.kind === "dir") Object.assign(result, await fileUtilityTree(runtime, `${path}/`));
  }
  return result;
}
