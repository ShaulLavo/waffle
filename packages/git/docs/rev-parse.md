# Revision queries

Status: implementation in progress.

This work adds a bounded, read-only `git rev-parse` command backed by the existing
isomorphic-git integration. It owns only the command dispatch, a new revision helper,
and new revision-query tests and documentation. Runtime, worker, Bash, Python,
coreutils, root package and CI files are outside this change.

Planned forms are `HEAD` and ref names, `--verify`, `--short[=N]`,
`--show-toplevel`, `--show-prefix`, and `--is-inside-work-tree`.
Unsupported revision expressions and options will fail explicitly.
