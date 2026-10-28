# Local Git

`waffle-git` runs local repository commands through isomorphic-git 1.44.5 on the embedding page's Waffle filesystem. It creates no runtime, process service, worker or executable marker. The Git core and text-diff library load on the first command from `dist/git-command.js`. Package preparation builds that self-contained asset with the verified upstream patch, so tarball consumers also receive the corrected backend.

```ts
import { installGit } from "waffle-git";

const git = await installGit(runtime);
await runtime.filesystem.mkdirp("/project");
const status = await git.run({
  argv: ["init", "-b", "main"],
  cwd: "/project",
  env: {
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.invalid",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.invalid",
  },
  stdout: (bytes) => terminal.write(bytes),
  stderr: (bytes) => terminal.write(bytes),
});
await git.dispose();
```

Arguments exclude the executable name. Streams receive bytes and may return promises. `run` returns a numeric status. One installation per runtime serializes its commands; dispose closes admission, joins accepted commands and leaves the caller's filesystem and runtime alive. Edits through other filesystem users must finish before starting a Git command.

## Supported commands

| Command    | Local slice                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`     | Optional directory, `-b`/`--initial-branch`, SHA-1; no templates                                                                                                   |
| `add`      | Literal files/directories, `.`, `-A`, `-u`, `-f`; stages deletions                                                                                                 |
| `commit`   | Required `-m`, optional `--allow-empty`; environment identity/date or repository user config                                                                       |
| `status`   | Porcelain v1 with all untracked files, also the default output                                                                                                     |
| `log`      | Git's default layout (commit, author, author-zone date, indented message), `%s`, `%H`, `%h %s`, `%H %s` formats, `--oneline`, `--first-parent`, `-n`/`--max-count` |
| `diff`     | Index/worktree or `--cached`/`--staged`; unified UTF-8 text diff, binary notice, `--name-only`, `--no-prefix`, `--quiet`, `--exit-code`                            |
| `branch`   | List/current, create, delete `-d`/`-D`; no patterns                                                                                                                |
| `checkout` | Existing local revision, `-b`; refuses tracked edits that could be lost                                                                                            |
| `switch`   | Existing local branch, `-c`/`--create`; same refusal as `checkout`                                                                                                 |
| `merge`    | Clean fast-forward and divergent merges, text conflict markers and index stages, `--abort`, resolution commits, `--ff-only`, `--no-ff`, `-m`                       |
| `stash`    | Push/list/apply/pop/drop/clear, `-u`/`--include-untracked`, `-m`, `--index` on apply/pop, `%gs` list format                                                        |
| `config`   | Repository-local `user.name` and `user.email` only                                                                                                                 |

Waffle's high-level filesystem API exposes regular files and directories, without executable mode control. This adapter rejects symlinks. Remotes, network relay, submodules, hooks, editors, filters, arbitrary config and Git aliases are outside this slice. Unsupported commands/options return an error. Conflicting text merges return 1 and leave real conflict stages and markers for `add` and `commit`, or `merge --abort`. Checkout and stash push reject an unfinished merge. Stash saves native-shaped worktree, index, and optional untracked commits. `apply --index` and `pop --index` restore every saved index path while preserving the saved worktree, including staged additions deleted before stashing. Apply and pop require the saved original HEAD and a clean tracked worktree; applying across different commits is not supported. Untracked collisions fail before saved files are restored. Ignored files are excluded from `-u`. Executable bits, symlinks, rename detection, complex file/directory conflicts, and recursive multi-base merges are not supported.

## The `git` program

`waffle-git/program` installs `/usr/bin/git` as an interpreter script: `#!/bin/bun` followed by `dist/git-cli.js`. Waffle's shebang admission runs it with the JavaScript interpreter already registered on the caller's Runtime (bun-wasm's `/bin/bun`), so shells, `Bun.spawn("git")` and any other process reach it on `PATH`. The CLI calls the same `runGit` backend with process argv, cwd, env and stdio, and uses the interpreter's `node:fs`, which is the shared Waffle filesystem. It registers no executable, adapter or worker of its own.

```ts
import { installGitProgram, GIT_CLI_URL } from "waffle-git/program";

const git = await installGitProgram(runtime, { source: await (await fetch(GIT_CLI_URL)).text() });
// ... spawn /usr/bin/git through any process on the runtime
await git.dispose();
```

Installation writes the script once, exclusively; a foreign file at the path is a conflict. Dispose removes only the unchanged regular file with the inode this install created. Without a registered interpreter the spawn fails at admission. There is no native Git or stub-module fallback.

## Verification and source

`node scripts/test-git-local.ts` replays all four committed native-Git scenarios and 96 steps, plus binary preservation, stash deletion, collision, and refusal checks. `node scripts/test-git-browser.ts` (inherited from bash-web, not rerun in this package) repeats all 96 steps and tracked stash in Chromium on the actual Waffle filesystem. It checks first-use loading, zero process admission, command retirement, pending-output joins, reinstallation, and caller lifetime. Neither backend nor browser replay invokes native Git. `bun run --cwd packages/git test:browser` runs the six everyday commands in Chromium through both the API and `/usr/bin/git` on bun-wasm, on one Waffle filesystem. `npm run test:browser:lookup` has the Bash shell and `Bun.spawn(["git", ...])` find `git` by name on `PATH=/usr/bin:/bin` against one shared repository; it builds Bash from a staged source export (`GIT_BASH_SOURCE`) and its CI shell guest (`GIT_SHELL_GUEST`) as test composition only.

No scenarios are excluded. The fixture source and exact oracle environment are owned by `scripts/record-git-local.ts`; `node scripts/record-git-local.ts --check` audits its native recording without changing owner HOME/global config.

`scripts/patch-git-source.ts` verifies the pristine ESM/CJS hashes, adds module-local browser Buffer imports for the core and exported filesystem/index helpers, and fixes upstream `compareStats` to compare subsecond timestamps and rehash files in the racy-index window. The patch also uses `HEAD` in local conflict markers, completes clean index changes alongside conflicts, and preserves binary bytes and removes merged additions in upstream `abortMerge`. It is idempotent and refuses changed upstream source. It prevents same-sized edits within a second from appearing clean. The package license files remain in the dependency; `bun run --cwd packages/git notices` emits the complete bundled dependency notices.
