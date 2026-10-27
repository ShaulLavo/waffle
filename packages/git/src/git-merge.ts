import * as git from "isomorphic-git";
import {
  arity,
  clean,
  exists,
  GitFailure,
  identity,
  options,
  type GitContext,
} from "./git-context";

export async function clearMerge(context: GitContext) {
  for (const name of ["MERGE_HEAD", "MERGE_MSG"]) {
    const path = `${context.dir}/.git/${name}`;
    if (await exists(context.fs, path)) await context.fs.promises.unlink(path);
  }
}

export async function gitMerge(context: GitContext, args: readonly string[]) {
  const parsed = options(args, ["--ff-only", "--no-ff", "--abort"], ["-m", "--message"]);
  const merging = await exists(context.fs, `${context.dir}/.git/MERGE_HEAD`);
  if (parsed.flags.has("--abort")) {
    arity(args, 1);
    if (!merging) throw new GitFailure("no merge to abort");
    await git.abortMerge(context);
    return clearMerge(context);
  }
  arity(parsed.paths, 1);
  if (merging) throw new GitFailure("finish or abort the current merge first", 1);
  if (parsed.flags.has("--ff-only") && parsed.flags.has("--no-ff"))
    throw new GitFailure("incompatible merge flags", 129);
  await clean(context);
  const theirs = parsed.paths[0];
  const ref = await git.currentBranch(context);
  if (!ref) throw new GitFailure("merging in detached HEAD is unsupported", 129);
  const author = await identity(context, "AUTHOR");
  const committer = await identity(context, "COMMITTER");
  const message = parsed.named.get("-m") ?? parsed.named.get("--message");
  const merge = {
    ...context,
    theirs,
    author,
    committer,
    fastForward: !parsed.flags.has("--no-ff"),
    fastForwardOnly: parsed.flags.has("--ff-only"),
    message,
  };
  // The checkout preflight prevents an untracked file from being overwritten.
  await git.checkout({ ...context, ref: theirs, dryRun: true, noUpdateHead: true });
  const head = await git.resolveRef({ ...context, ref: "HEAD" });
  const theirHead = await git.resolveRef({ ...context, ref: theirs });
  try {
    await git.merge({ ...merge, abortOnConflict: false });
    await git.checkout({ ...context, ref });
  } catch (error) {
    if (!(error instanceof git.Errors.MergeConflictError)) throw error;
    await context.fs.promises.writeFile(`${context.dir}/.git/ORIG_HEAD`, `${head}\n`);
    await context.fs.promises.writeFile(`${context.dir}/.git/MERGE_HEAD`, `${theirHead}\n`);
    await context.fs.promises.writeFile(
      `${context.dir}/.git/MERGE_MSG`,
      `${message ?? `Merge branch '${theirs}'`}\n`,
    );
    throw new GitFailure(error.message, 1);
  }
}
