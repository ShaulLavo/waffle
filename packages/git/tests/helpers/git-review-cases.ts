import type { captureGit } from "./git-output";

export interface GitReviewRepository {
  run(argv: readonly string[]): Promise<Awaited<ReturnType<typeof captureGit>>>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  read(path: string): Promise<string | null>;
  blob(ref: "HEAD" | "INDEX", path: string): Promise<string | null>;
}

async function command(repository: GitReviewRepository, argv: string[], status = 0) {
  const result = await repository.run(argv);
  if (result.status !== status)
    throw new Error(
      `${argv.join(" ")}: expected ${status}, received ${result.status}: ${result.stderr}`,
    );
  return result.stdout;
}

export async function mixedConflict(repository: GitReviewRepository) {
  const run = (...argv: string[]) => command(repository, argv);
  await run("init", "-b", "main");
  await repository.write("story.txt", "base\n");
  await repository.write("clean.txt", "base clean\n");
  await repository.write("gone.txt", "base gone\n");
  await run("add", ".");
  await run("commit", "-m", "base");
  await run("checkout", "-b", "side");
  await repository.write("story.txt", "side\n");
  await repository.write("clean.txt", "side clean\n");
  await repository.write("added.txt", "side added\n");
  await repository.remove("gone.txt");
  await run("add", "-A");
  await run("commit", "-m", "side changes");
  await run("checkout", "main");
  await repository.write("story.txt", "main\n");
  await run("add", "story.txt");
  await run("commit", "-m", "main changes");
  await command(repository, ["merge", "side", "-m", "mixed merge"], 1);
  const conflicted = {
    status: await run("status", "--porcelain", "--untracked-files=all"),
    clean: await repository.blob("INDEX", "clean.txt"),
    added: await repository.blob("INDEX", "added.txt"),
    gone: await repository.blob("INDEX", "gone.txt"),
    goneWorktree: await repository.read("gone.txt"),
  };
  await run("merge", "--abort");
  const aborted = {
    status: await run("status", "--porcelain", "--untracked-files=all"),
    clean: await repository.read("clean.txt"),
    added: await repository.read("added.txt"),
    gone: await repository.read("gone.txt"),
  };
  await command(repository, ["merge", "side", "-m", "mixed merge"], 1);
  await repository.write("story.txt", "resolved\n");
  await run("add", "story.txt");
  await run("commit", "-m", "resolve mixed merge");
  return {
    conflicted,
    aborted,
    resolved: {
      status: await run("status", "--porcelain", "--untracked-files=all"),
      clean: await repository.blob("HEAD", "clean.txt"),
      added: await repository.blob("HEAD", "added.txt"),
      gone: await repository.blob("HEAD", "gone.txt"),
      story: await repository.blob("HEAD", "story.txt"),
    },
  };
}

export const mixedConflictExpected = {
  conflicted: {
    status: "A  added.txt\nM  clean.txt\nD  gone.txt\nUU story.txt\n",
    clean: "side clean\n",
    added: "side added\n",
    gone: null,
    goneWorktree: null,
  },
  aborted: { status: "", clean: "base clean\n", added: null, gone: "base gone\n" },
  resolved: {
    status: "",
    clean: "side clean\n",
    added: "side added\n",
    gone: null,
    story: "resolved\n",
  },
};

export async function indexOnlyStash(repository: GitReviewRepository) {
  const run = (...argv: string[]) => command(repository, argv);
  await run("init", "-b", "main");
  await run("commit", "--allow-empty", "-m", "base");
  await repository.write("new.txt", "valuable staged bytes\n");
  await run("add", "new.txt");
  await repository.remove("new.txt");
  const before = {
    status: await run("status", "--porcelain"),
    staged: await repository.blob("INDEX", "new.txt"),
    worktree: await repository.read("new.txt"),
  };
  await run("stash", "push", "-m", "index-only addition");
  const saved = {
    status: await run("status", "--porcelain"),
    entries: await run("stash", "list", "--format=%gs"),
  };
  await run("stash", "pop", "--index");
  return {
    before,
    saved,
    restored: {
      status: await run("status", "--porcelain"),
      staged: await repository.blob("INDEX", "new.txt"),
      worktree: await repository.read("new.txt"),
      entries: await run("stash", "list", "--format=%gs"),
    },
  };
}

export const indexOnlyStashExpected = {
  before: { status: "AD new.txt\n", staged: "valuable staged bytes\n", worktree: null },
  saved: { status: "", entries: "On main: index-only addition\n" },
  restored: {
    status: "AD new.txt\n",
    staged: "valuable staged bytes\n",
    worktree: null,
    entries: "",
  },
};

// Native Git recreates the staged addition; our saved worktree contract preserves its deletion.
export const indexOnlyStashNativeExpected = {
  ...indexOnlyStashExpected,
  restored: {
    ...indexOnlyStashExpected.restored,
    status: "A  new.txt\n",
    worktree: "valuable staged bytes\n",
  },
};

async function head(repository: GitReviewRepository) {
  return (await command(repository, ["log", "-n", "1", "--format=%H"])).trim();
}

/** A local branch and a same-named tag on different commits: switch must bind the branch. */
export async function switchPrefersBranch(repository: GitReviewRepository) {
  await command(repository, ["init", "-b", "main"]);
  await repository.write("story", "tagged\n");
  await command(repository, ["add", "story"]);
  await command(repository, ["commit", "-m", "Tagged"]);
  const tagged = await head(repository);
  await repository.write(".git/refs/tags/release", `${tagged}\n`);
  await repository.write(".git/refs/tags/fresh", `${tagged}\n`);
  await repository.write("story", "branch\n");
  await command(repository, ["add", "story"]);
  await command(repository, ["commit", "-m", "Branch"]);
  await command(repository, ["branch", "release"]);
  const state = async () => ({
    head: await repository.read(".git/HEAD"),
    story: await repository.read("story"),
  });
  await command(repository, ["switch", "release"]);
  const existing = await state();
  await command(repository, ["switch", "main"]);
  await command(repository, ["switch", "-c", "fresh"]);
  return { existing, created: await state() };
}

export const switchPrefersBranchExpected = {
  existing: { head: "ref: refs/heads/release\n", story: "branch\n" },
  created: { head: "ref: refs/heads/fresh\n", story: "branch\n" },
};

/** An untracked collision refuses create-and-switch before the new branch is written. */
export async function refusedCreateKeepsRefs(repository: GitReviewRepository) {
  await command(repository, ["init", "-b", "main"]);
  await repository.write("base", "base\n");
  await command(repository, ["add", "base"]);
  await command(repository, ["commit", "-m", "Base"]);
  await command(repository, ["switch", "-c", "side"]);
  await repository.write("feature.txt", "side\n");
  await command(repository, ["add", "feature.txt"]);
  await command(repository, ["commit", "-m", "Side"]);
  await command(repository, ["switch", "main"]);
  await repository.write("feature.txt", "mine\n");
  const before = await repository.read(".git/index");
  const refused = await repository.run(["switch", "-c", "topic", "side"]);
  return {
    refused: refused.status !== 0,
    branches: await command(repository, ["branch"]),
    head: await repository.read(".git/HEAD"),
    indexKept: (await repository.read(".git/index")) === before,
    feature: await repository.read("feature.txt"),
    status: await command(repository, ["status", "--porcelain"]),
  };
}

export const refusedCreateKeepsRefsExpected = {
  refused: true,
  branches: "* main\n  side\n",
  head: "ref: refs/heads/main\n",
  indexKept: true,
  feature: "mine\n",
  status: "?? feature.txt\n",
};
