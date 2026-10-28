import * as git from "isomorphic-git";
import type { GitFilesystem } from "../../src/git-types";
import type { GitLocalState } from "../../scripts/record-git-local";
import { conflictStatus } from "../../src/git-index";

export async function gitSnapshot(
  fs: GitFilesystem,
  dir: string,
  expected: Readonly<Record<string, GitLocalState["history"][string] | undefined>>,
): Promise<GitLocalState> {
  const files: Record<string, string> = {};
  await readDirectory(fs, dir, "", files);
  const branchNames = await git.listBranches({ fs, dir });
  const commits = new Map<string, Awaited<ReturnType<typeof git.readCommit>>>();
  const rawRefs: Record<string, string> = {};
  for (const ref of branchNames) {
    const oid = await git.resolveRef({ fs, dir, ref });
    rawRefs[`refs/heads/${ref}`] = oid;
    await history(fs, dir, oid, commits);
  }
  const labels = new Map<string, string>();
  for (const [oid, { commit }] of commits) {
    const entry = Object.entries(expected).find(
      ([, value]) => value?.subject === commit.message.split("\n")[0],
    );
    labels.set(oid, entry?.[0] ?? `unknown:${commit.message.split("\n")[0]}`);
  }
  const rows = await git.statusMatrix({ fs, dir });
  const { porcelain } = await import("../../src/git-context");
  return {
    files,
    head: (await git.currentBranch({ fs, dir })) ?? "",
    refs: Object.fromEntries(
      Object.entries(rawRefs).map(([ref, oid]) => [ref, label(labels, oid)]),
    ),
    history: Object.fromEntries(
      Array.from(commits, ([oid, { commit }]) => [
        label(labels, oid),
        {
          subject: commit.message.split("\n")[0],
          parents: commit.parent.map((parent) => label(labels, parent)),
        },
      ]),
    ),
    status: porcelain(rows, await conflictStatus({ fs, dir })),
    stash: await stash(fs, dir),
  };
}

function label(labels: Map<string, string>, oid: string) {
  const value = labels.get(oid);
  if (!value) throw new Error(`Unobserved commit ${oid}`);
  return value;
}

async function readDirectory(
  fs: GitFilesystem,
  dir: string,
  prefix: string,
  files: Record<string, string>,
) {
  for (const name of await fs.promises.readdir(`${dir}/${prefix}`)) {
    if (name === ".git") continue;
    const path = prefix ? `${prefix}/${name}` : name;
    await readEntry(fs, dir, path, files);
  }
}

async function readEntry(
  fs: GitFilesystem,
  dir: string,
  path: string,
  files: Record<string, string>,
) {
  const stat = await fs.promises.stat(`${dir}/${path}`);
  if (stat.isDirectory()) return readDirectory(fs, dir, path, files);
  const bytes = await fs.promises.readFile(`${dir}/${path}`);
  files[path] = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
}

async function history(
  fs: GitFilesystem,
  dir: string,
  oid: string,
  commits: Map<string, Awaited<ReturnType<typeof git.readCommit>>>,
) {
  if (commits.has(oid)) return;
  const result = await git.readCommit({ fs, dir, oid });
  commits.set(oid, result);
  for (const parent of result.commit.parent) await history(fs, dir, parent, commits);
}

async function stash(fs: GitFilesystem, dir: string) {
  try {
    const raw = await fs.promises.readFile(`${dir}/.git/logs/refs/stash`, "utf8");
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return text
      .trimEnd()
      .split("\n")
      .reverse()
      .map((line) => line.slice(line.indexOf("\t") + 1));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
