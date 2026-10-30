# gh compatibility

This package targets the common noninteractive subset recorded against gh 2.103.0. It supports token login, PR, issue, run, repository, and direct API workflows. It does not attempt full gh parity.

## Implementation provenance

The command behavior comes from the prepared native gh oracle, `fixtures/cases.json`, and public references at:

- `cli/cli` tag `v2.103.0`, especially `pkg/cmd/api`, `pkg/cmd/pr`, `pkg/cmd/issue`, `pkg/cmd/run`, and `pkg/cmd/repo/view`.
- `go-gh` tag `v2.17.0`, especially `pkg/auth/auth.go`.
- GitHub REST documentation for pulls, issues, actions, repositories, and pagination.

The TypeScript implementation is original. No upstream implementation is adapted or copied. `sources.lock.json` pins the fixture hash.

## jq

`--jq` executes `/usr/bin/jq -c -r`. The application installs the separate Waffle jq package, which runs the real jaq evaluator. There is no field picker or translated query subset. Top-level strings remain unquoted and structured output remains compact.

Jaq and gojq diagnostics differ. This adapter maps evaluator failure to gh exit 1 and preserves the evaluator diagnostic. Invalid expressions fail explicitly rather than returning approximate data.

## Limits

Only `api.github.com` over HTTPS is accepted. Enterprise hosts, browser mode, Go templates, interactive prompts, extensions, log archives, and fields outside the prepared contract are rejected. Authentication follows `GH_TOKEN`, `GITHUB_TOKEN`, then `hosts.yml`. Pagination never carries credentials to another origin.

Mutation tests use injected synthetic transport. The native comparison runner covers only offline commands that cannot create or modify GitHub resources.
