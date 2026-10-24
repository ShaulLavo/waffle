# 001. Install as an exact-commit Git dependency

Status: accepted
Date: 2026-10-17

## Context

Waffle is source-first TypeScript. Its consumers, `bun-wasm` and `bash-web`, live in other repositories and have to change together with it. The public API is still settling, and Waffle promises no compatibility between revisions. Node consumers still need compiled entry points, but the repository must not check compiled output in.

## Decision

Consumers depend on `github:ShaulLavo/waffle#<full commit sha>` and list `waffle` in Bun's `trustedDependencies`. The install runs `prepare`, which writes the Node entry points under `dist/`. The package stays `private: true`, is not published to npm, and changes only its patch version.

## Alternatives considered

- **An npm tarball.** Waffle supports no old-shape fallbacks or version-skew paths, so a registry version range has nothing to offer. `package.json` is `private: true`, and `docs/development.md` says not to rely on a tarball while the API settles.
- **A sibling checkout.** `docs/development.md` rules it out. An exact commit in the lockfile installs the same source on any machine.
- **Committed `dist/`.** `AGENTS.md` forbids checking in compiled JavaScript, `dist/` or binaries. CI fails if `git ls-files dist` is not empty.

## Consequences

- Each consumer moves its pin, lockfile and code in one change.
- Browser bundlers read the TypeScript source. Node reads `dist/`, which exists only if the consumer trusted `prepare`. Without trust, Node fails with `Cannot find module .../waffle/dist/...`.
- `prepare` needs Bun's TypeScript tooling, so a package manager that skips Bun cannot build the Node entry points.
- A consumer cannot take a bug fix without taking every other change up to that commit.
