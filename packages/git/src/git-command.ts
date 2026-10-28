import * as git from "isomorphic-git";
import type { GitFilesystem, GitInvocation } from "./git-types";
import {
  absolute,
  arity,
  GitFailure,
  options,
  output,
  pathspec,
  selected,
  porcelain,
  type GitContext,
} from "./git-context";
import { gitBranch, gitCheckout, gitCommit, gitLog, gitSwitch } from "./git-history";
import { gitDiff } from "./git-diff";
import { gitMerge } from "./git-merge";
import { gitStash } from "./git-stash";
import { conflictStatus } from "./git-index";

export async function runGit(fs: GitFilesystem, invocation: GitInvocation): Promise<number> {
  try {
    if (!invocation.cwd.startsWith("/")) throw new GitFailure("cwd must be absolute", 129);
    const [command, ...args] = invocation.argv;
    if (command === "--version") {
      await invocation.stdout(
        new TextEncoder().encode(`git version isomorphic-git ${git.version()}\n`),
      );
      return 0;
    }
    if (command === "init") return await gitInit(fs, invocation, args);
    if (
      ![
        "add",
        "commit",
        "status",
        "log",
        "diff",
        "branch",
        "checkout",
        "switch",
        "merge",
        "stash",
        "config",
      ].includes(command)
    )
      throw new GitFailure(`unsupported local command '${command ?? ""}'`, 129);
    const dir = await git.findRoot({ fs, filepath: invocation.cwd });
    const context = { fs, dir, invocation };
    const status = await dispatch(context, command, args);
    return typeof status === "number" ? status : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await invocation.stderr(new TextEncoder().encode(`git: ${message}\n`));
    return error instanceof GitFailure ? error.status : 128;
  }
}

async function dispatch(context: GitContext, command: string, args: readonly string[]) {
  switch (command) {
    case "add":
      return gitAdd(context, args);
    case "commit":
      return gitCommit(context, args);
    case "status":
      return gitStatus(context, args);
    case "log":
      return gitLog(context, args);
    case "diff":
      return gitDiff(context, args);
    case "branch":
      return gitBranch(context, args);
    case "checkout":
      return gitCheckout(context, args);
    case "switch":
      return gitSwitch(context, args);
    case "merge":
      return gitMerge(context, args);
    case "stash":
      return gitStash(context, args);
    case "config":
      return gitConfig(context, args);
  }
}

async function gitInit(fs: GitFilesystem, invocation: GitInvocation, args: readonly string[]) {
  const parsed = options(
    args,
    ["-q", "--quiet"],
    ["-b", "--initial-branch", "--object-format", "--template"],
  );
  arity(parsed.paths, 0, 1);
  if ((parsed.named.get("--object-format") ?? "sha1") !== "sha1")
    throw new GitFailure("only SHA-1 repositories are supported", 129);
  if (parsed.named.get("--template")) throw new GitFailure("templates are unsupported", 129);
  const dir = absolute(invocation.cwd, parsed.paths[0] ?? ".");
  await git.init({
    fs,
    dir,
    defaultBranch: parsed.named.get("-b") ?? parsed.named.get("--initial-branch") ?? "main",
  });
  return 0;
}

async function gitAdd(context: GitContext, args: readonly string[]) {
  const { flags, paths } = options(args, ["-A", "--all", "-u", "--update", "-f", "--force"]);
  const update = flags.has("-u") || flags.has("--update");
  if (!paths.length && !update && !flags.has("-A") && !flags.has("--all"))
    throw new GitFailure("nothing specified to add", 129);
  const specs = paths.map((path) => pathspec(context, path));
  const force = flags.has("-f") || flags.has("--force");
  const rows = await git.statusMatrix({ ...context, ignored: force });
  for (const spec of specs) await requirePath(context, spec, rows);
  for (const [filepath, head, work, stage] of rows) {
    if (!selected(filepath, specs) || (update && head === 0 && stage === 0)) continue;
    if (work === 0) await git.remove({ ...context, filepath });
    else await git.add({ ...context, filepath, force });
  }
}

async function requirePath(context: GitContext, spec: string, rows: git.StatusRow[]) {
  if (spec === "." || rows.some(([path]) => selected(path, [spec]))) return;
  if (await git.isIgnored({ ...context, filepath: spec }))
    throw new GitFailure(`'${spec}' is ignored`, 1);
  throw new GitFailure(`pathspec '${spec}' did not match any files`);
}

async function gitStatus(context: GitContext, args: readonly string[]) {
  const parsed = options(
    args,
    ["--porcelain", "--short", "-s"],
    ["--porcelain", "--untracked-files"],
  );
  if (parsed.named.has("--porcelain") && parsed.named.get("--porcelain") !== "v1")
    throw new GitFailure("only porcelain v1 is supported", 129);
  if (parsed.named.has("--untracked-files") && parsed.named.get("--untracked-files") !== "all")
    throw new GitFailure("only --untracked-files=all is supported", 129);
  const specs = parsed.paths.map((path) => pathspec(context, path));
  const rows = await git.statusMatrix(context);
  await output(
    context,
    porcelain(
      rows.filter(([path]) => selected(path, specs)),
      await conflictStatus(context),
    ),
  );
}

async function gitConfig(context: GitContext, args: readonly string[]) {
  const { paths } = options(args, ["--local"]);
  arity(paths, 1, 2);
  if (!["user.name", "user.email"].includes(paths[0]))
    throw new GitFailure("only repository user.name and user.email config are supported", 129);
  if (paths.length === 2) return git.setConfig({ ...context, path: paths[0], value: paths[1] });
  const value = await git.getConfig({ ...context, path: paths[0] });
  if (value === undefined) throw new GitFailure("config entry not found", 1);
  await output(context, `${value}\n`);
}
