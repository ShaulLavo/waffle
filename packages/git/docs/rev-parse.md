# Revision queries

`git rev-parse` uses the same read-only backend through `installGit` and the bundled
`/usr/bin/git` program. It never starts native Git, a shell, hooks or config commands.

```sh
git rev-parse HEAD refs/heads/main
git rev-parse --verify HEAD
git rev-parse --short=8 HEAD
git rev-parse --show-toplevel --show-prefix --is-inside-work-tree
```

## Supported forms

- `HEAD`, unambiguous local, tag and remote ref names, and full `refs/...` names produce
  full SHA-1 object IDs. Packed refs, symbolic remote HEAD refs, detached HEAD and annotated
  tag object IDs work through isomorphic-git. Tags are not automatically peeled.
- Full 40-digit IDs are accepted even when the object is absent, as in Git. Existing,
  unique hexadecimal prefixes of at least four digits resolve to full IDs.
- Multiple revision operands print one full ID per line in operand order.
- `--verify` requires exactly one revision. `--short[=N]` implies `--verify` and prints
  a unique object prefix, extending beyond `N` when other loose or packed objects collide.
  Explicit decimal lengths clamp to 4 through 40. The default minimum is seven; numeric
  repository-local `core.abbrev` values from 4 through 40 and `core.abbrev=no` are honored.
- `--show-toplevel` prints the absolute working-tree root. `--show-prefix` prints the
  repository-relative working directory with a trailing slash, or a blank line at the root.
  Paths containing spaces and Unicode are emitted literally.
- `--is-inside-work-tree` prints `true` in the working tree and `false` inside its `.git`
  directory. Location queries can be combined and print in option order before revisions.
  `--show-toplevel` inside `.git` fails with status 128.

Options must precede operands. Empty arguments produce no output and status 0 inside a
repository. Outside a repository, queries return status 128. Missing revisions also return
128; `--verify` emits `fatal: Needed a single revision` without revision output.
Queries do not change repository files, the index or the working tree.

## Deliberate limits

Revision expressions such as `HEAD~1`, `HEAD^`, `ref:path`, ranges and reflog selectors,
path operands, `--`, other options, nondecimal short lengths, and options after an operand
return status 129. Bare repositories and Git environment overrides such as `GIT_DIR` or
`GIT_WORK_TREE` are outside this local working-tree interface. Automatic abbreviation
configuration such as `core.abbrev=auto` is unsupported; use an explicit `--short=N`.

Ambiguous ref shorthands return 129 and ask for the full ref name, rather than choosing
between a branch and a tag. Ambiguous object prefixes return 128 and ask for a longer ID.
Their diagnostics are Waffle-specific; native Git prints additional ambiguity warnings and
candidate details. No revision/path disambiguation or shell expansion is performed.

## Verification

After preparing the Git package, run from `packages/git`:

```sh
node --test tests/git-rev-parse.test.ts
bun tests/git-rev-parse-browser.ts
```

The first command compares stdout, stderr and status with native Git on disposable fixtures,
checks collision and refusal behavior, forbids backend filesystem mutations, and exercises
`dist/git-cli.js` on Bun. Native Git is only a test oracle. The browser smoke uses one real
Waffle runtime, the public API and installed CLI, the existing process helper, and the
integrity-checked published Bun guest. Prepare Waffle's real network asset before running
the browser smoke, as required by the Bun interpreter's runtime integration. The runner
refuses a missing asset rather than building a guest or using a substitute.
It checks repository bytes and disposes its runtime,
browser, listener, downloaded guest and scratch files. It needs network access to that guest.
