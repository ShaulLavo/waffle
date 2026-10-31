import * as git from "isomorphic-git";
import { FileSystem } from "isomorphic-git/models";
import {
  arity,
  clean,
  exists,
  GitFailure,
  identity,
  options,
  output,
  text,
  type GitContext,
} from "./git-context";

export async function gitStash(context: GitContext, args: readonly string[]) {
  const parsed = options(
    args,
    ["--index", "-u", "--include-untracked"],
    ["-m", "--message", "--format"],
  );
  const op = parsed.paths[0] ?? "push";
  if (parsed.flags.has("--index") && op !== "apply" && op !== "pop")
    throw new GitFailure("--index requires stash apply or pop", 129);
  if (parsed.named.has("--format") && op !== "list")
    throw new GitFailure("--format requires stash list", 129);
  if (
    (parsed.named.has("-m") ||
      parsed.named.has("--message") ||
      parsed.flags.has("-u") ||
      parsed.flags.has("--include-untracked")) &&
    op !== "push"
  )
    throw new GitFailure("message and untracked options require stash push", 129);
  if (op === "list") return list(context, parsed);
  if (!["push", "apply", "pop", "drop", "clear"].includes(op))
    throw new GitFailure(`unsupported stash operation '${op}'`, 129);
  arity(parsed.paths, 0, op === "push" || op === "clear" ? 1 : 2);
  const entries = await stashEntries(context);
  const refIdx = stashIndex(parsed.paths[1]);
  if (op !== "push" && op !== "clear" && refIdx >= entries.length)
    throw new GitFailure("no stash entry found", 1);
  if (op === "push") return push(context, parsed);
  if (op === "clear" || op === "drop") {
    await git.stash({ ...context, op, refIdx });
    return;
  }
  await apply(context, entries[refIdx].oid, parsed.flags.has("--index"));
  if (op === "pop") await git.stash({ ...context, op: "drop", refIdx });
}

function stashIndex(value?: string) {
  if (value === undefined) return 0;
  const match = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(value);
  const index = match ? Number(match[1] ?? match[2]) : NaN;
  if (!Number.isSafeInteger(index)) throw new GitFailure("invalid stash reference", 129);
  return index;
}

async function list(context: GitContext, parsed: ReturnType<typeof options>) {
  arity(parsed.paths, 1);
  const format = parsed.named.get("--format");
  if (format && format !== "%gs") throw new GitFailure("only stash --format=%gs is supported", 129);
  const entries = await stashEntries(context);
  await output(
    context,
    entries
      .map(({ message }, index) => `${format ? "" : `stash@{${index}}: `}${message}\n`)
      .join(""),
  );
}

async function stashEntries(context: GitContext) {
  const path = `${context.dir}/.git/logs/refs/stash`;
  if (!(await exists(context.fs, path))) return [];
  return (await text(context.fs, path))
    .trimEnd()
    .split("\n")
    .reverse()
    .filter(Boolean)
    .map((line) => {
      const oid = line.split(" ")[1];
      if (!/^[a-f0-9]{40}$/.test(oid) || !line.includes("\t"))
        throw new GitFailure("invalid stash reflog");
      return { oid, message: line.slice(line.indexOf("\t") + 1) };
    });
}

async function push(context: GitContext, parsed: ReturnType<typeof options>) {
  if (await exists(context.fs, `${context.dir}/.git/MERGE_HEAD`))
    throw new GitFailure("finish or abort the current merge first", 1);
  const rows = await git.statusMatrix(context);
  const untracked =
    parsed.flags.has("-u") || parsed.flags.has("--include-untracked")
      ? rows.filter(([, head, , stage]) => head === 0 && stage === 0).map(([path]) => path)
      : [];
  const tracked = rows.filter(([, head, , stage]) => head !== 0 || stage !== 0);
  if (
    !untracked.length &&
    !tracked.some(([, head, work, stage]) => head !== work || head !== stage)
  )
    return;
  const head = await git.resolveRef({ ...context, ref: "HEAD" });
  const branch = (await git.currentBranch(context)) ?? "(no branch)";
  const message = parsed.named.get("-m") ?? parsed.named.get("--message");
  const subject = (await git.readCommit({ ...context, oid: head })).commit.message.split("\n")[0];
  const label = message
    ? `On ${branch}: ${message}`
    : `WIP on ${branch}: ${head.slice(0, 7)} ${subject}`;
  const oid = await snapshot(context, head, tracked, untracked, label);
  await saveEntry(context, oid, label);
  await git.checkout({ ...context, ref: head, noUpdateHead: true, force: true });
  for (const path of untracked) await context.fs.promises.unlink(`${context.dir}/${path}`);
}

async function snapshot(
  context: GitContext,
  head: string,
  tracked: git.StatusRow[],
  untracked: string[],
  message: string,
) {
  const indexPath = `${context.dir}/.git/index`;
  const original = (await exists(context.fs, indexPath))
    ? await context.fs.promises.readFile(indexPath)
    : undefined;
  const author = await identity(context, "AUTHOR");
  const committer = await identity(context, "COMMITTER");
  const commit = (parent: string[], message: string) =>
    git.commit({ ...context, parent, message, author, committer, noUpdateBranch: true });
  try {
    const index = await commit([head], "index on stash base");
    await stageWorktree(context, tracked);
    const work = await commit([head], message);
    const tree = (await git.readCommit({ ...context, oid: work })).commit.tree;
    const parent = [head, index];
    if (untracked.length) parent.push(await untrackedCommit(context, untracked, commit));
    return await git.commit({
      ...context,
      parent,
      tree,
      message,
      author,
      committer,
      noUpdateBranch: true,
    });
  } finally {
    if (original !== undefined) await context.fs.promises.writeFile(indexPath, original);
    else if (await exists(context.fs, indexPath)) await context.fs.promises.unlink(indexPath);
  }
}

async function stageWorktree(context: GitContext, rows: git.StatusRow[]) {
  for (const [filepath, , work] of rows) {
    if (work === 0) await git.remove({ ...context, filepath });
    else await git.add({ ...context, filepath, force: true });
  }
}

async function untrackedCommit(
  context: GitContext,
  paths: string[],
  commit: (parent: string[], message: string) => Promise<string>,
) {
  await git.remove({ ...context, filepath: await git.listFiles(context) });
  for (const filepath of paths) await git.add({ ...context, filepath });
  return commit([], "untracked files on stash base");
}

async function saveEntry(context: GitContext, oid: string, message: string) {
  const author = await identity(context, "AUTHOR");
  const timestamp = author.timestamp ?? Math.floor(Date.now() / 1000);
  const offset = author.timezoneOffset ?? new Date().getTimezoneOffset();
  const zone = `${offset > 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  const old = (await stashEntries(context))[0]?.oid ?? "0".repeat(40);
  const path = `${context.dir}/.git/logs/refs/stash`;
  const log = (await exists(context.fs, path)) ? await text(context.fs, path) : "";
  await new FileSystem(context.fs).mkdir(`${context.dir}/.git/logs/refs`);
  await context.fs.promises.writeFile(
    path,
    `${log}${old} ${oid} ${author.name} <${author.email}> ${timestamp} ${zone}\t${message}\n`,
  );
  await git.writeRef({ ...context, ref: "refs/stash", value: oid, force: true });
}

async function apply(context: GitContext, oid: string, restoreIndex: boolean) {
  await clean(context);
  const { commit } = await git.readCommit({ ...context, oid });
  const [base, index, untracked] = commit.parent;
  if (!base || !index || commit.parent.length > 3) throw new GitFailure("invalid stash commit");
  if ((await git.resolveRef({ ...context, ref: "HEAD" })) !== base)
    throw new GitFailure("stash apply currently requires its original HEAD", 1);
  const loose = untracked ? await git.listFiles({ ...context, ref: untracked }) : [];
  for (const path of loose) {
    if (await exists(context.fs, `${context.dir}/${path}`))
      throw new GitFailure(`untracked file '${path}' would be overwritten`, 1);
  }
  await git.checkout({ ...context, ref: oid, noUpdateHead: true, dryRun: true });
  await git.checkout({ ...context, ref: oid, noUpdateHead: true });
  const ref = restoreIndex ? index : base;
  const paths = new Set(
    (await git.listFiles(context)).concat(await git.listFiles({ ...context, ref })),
  );
  for (const filepath of paths) await git.resetIndex({ ...context, filepath, ref });
  for (const filepath of loose) {
    const { blob } = await git.readBlob({ ...context, oid: untracked, filepath });
    await new FileSystem(context.fs).write(`${context.dir}/${filepath}`, blob);
  }
}
