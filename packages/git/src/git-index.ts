import { GitIndexManager } from "isomorphic-git/managers";
import { FileSystem } from "isomorphic-git/models";
import type { GitContext } from "./git-context";

/** Read upstream's parsed conflict stages rather than infer them from worktree text. */
export async function conflictStatus(context: Pick<GitContext, "fs" | "dir">) {
  const result = new Map<string, string>();
  await GitIndexManager.acquire(
    { fs: new FileSystem(context.fs), gitdir: `${context.dir}/.git`, cache: {} },
    (index) => {
      for (const entry of index.entries) addConflict(result, entry);
    },
  );
  return result;
}

function addConflict(result: Map<string, string>, entry: unknown) {
  if (!entry || typeof entry !== "object" || !("path" in entry) || !("stages" in entry))
    throw new Error("Invalid upstream index entry");
  if (typeof entry.path !== "string" || !Array.isArray(entry.stages))
    throw new Error("Invalid upstream index stages");
  const stages = entry.stages;
  if (stages[0]) return;
  const mask = (stages[1] ? 1 : 0) | (stages[2] ? 2 : 0) | (stages[3] ? 4 : 0);
  const status = ["", "DD", "AU", "UD", "UA", "DU", "AA", "UU"][mask];
  if (!status) throw new Error("Invalid upstream conflict stages");
  result.set(entry.path, status);
}
