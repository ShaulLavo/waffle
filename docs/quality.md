# Quality gates

Install both packages, prepare the generated Node modules, then run the blocking command:

```sh
bun install --frozen-lockfile
bun install --cwd site --frozen-lockfile
bun run prepare
bun run quality
```

The package CI job runs this command on every pull request and push. Unit tests,
size budgets, libc checks, the three-engine storage/process browser matrices, and
the separate site build remain blocking jobs. Quality checks do not replace them.

## Coverage

- `lint` runs pinned Oxlint correctness rules, unused bindings/parameters, strict
  equality, constant bindings, duplicate imports and import cycles across authored
  JS/TS, including tests, workers, tooling and site scripts. Warnings and stale
  suppression comments fail the command. Unqualified browser-global `name` references
  are forbidden so a misspelled local parameter cannot silently read a worker/window name.
- `format:check` runs pinned Oxfmt across owned supported formats, including Astro.
  `bun run format` applies the same configuration.
- `check:source` rejects tracked and untracked `.js`, `.mjs` and `.cjs` files across
  the repository. Only exact paths declared as generated output or deliberate
  JavaScript test inputs can pass. The current tree needs no exceptions, and ignored
  build output remains exempt.
- `check` and `check:nodenext` retain the strict bundler and NodeNext configurations.
  `check:tooling` adds all test/worker fixtures, build/prepare scripts and tooling.
  Deliberate JavaScript test inputs can still opt into checking with `@ts-check`.
  Generated `dist` JavaScript can be imported by Node fixtures without checking
  generated code a second time. No additional `any` or type-ignore directives were added.
- The site's own `astro check` uses its separate TypeScript version and dependencies.
  It checks Astro templates, first-party scripts and authored site tooling. Root
  Knip treats `site` as a separate workspace, including its dependencies and Astro
  entry discovery. Root lint/format/duplicate checks also include owned site code.
- `unused` runs pinned Knip. Actual package export conditions define external API
  files; only their export/type findings are exempt. Internal files, CLI scripts
  and test entries retain `includeEntryExports: true`. Exact worker/HTML entrypoints
  supplement package-script and framework discovery. `@browserEntry` marks functions
  invoked by generated pages; `@compileFixture` marks deliberately exported compiler
  probes. The `@public` annotation on `runStorageTests` preserves the external testing
  facade after splitting the IndexedDB suite to remove its OPFS import cycle.

Generated dependency/build directories are excluded. Lockfiles, licenses, benchmark
captures, upstream patches, READMEs and agent instructions are not formatter inputs.
The single supplied `site/src/scripts/waffle-scene.ts` is preserved verbatim and
excluded from lint/format. Its pre-existing `@ts-nocheck` remains; Knip and duplicate
scans still include it. This is the owner-supplied Three.js scene recorded in
[bun-patches.md](bun-patches.md), not a general exclusion of site source.

Default depth is three and modified cyclomatic complexity is thirty. Explicit
file-specific ceilings retain measured existing depths of four/five and complexity
of 31–72 for legacy dispatchers, storage transactions and browser runners. They
remain blocking rules, not disabled checks. New files use the defaults; new quality
tooling has depth three, complexity fifteen and no explicit `any`. The import
scanner, cached-read loop, missing-parent validation, root retirement and storage
runner were flattened rather than increasing their measured ceilings. A broader
runtime decomposition is not part of installing these gates.

## Duplicate baseline

Pinned jscpd 5.4.1 scans owned TS/JS, Astro, shell and C sources with at least 100
tokens and ten lines. Token matching uses `mild` mode. Structural function matching
is also enabled at similarity `0.8`, with the CLI's default minimum of twenty syntax
tree nodes. jscpd excludes test files from structural matching, but token matching
still covers tests and fixtures. There is no Rust source in this repository.

The committed baseline uses clone fingerprints with multiplicities. Every new
fingerprint, or additional occurrence of an existing one, fails. There is no allowed
percentage drift, and an unexpectedly empty scan fails too. The command never
updates the baseline automatically.

The formatted adoption baseline contains 25 clones: 22 token matches in test setup,
scenario assertions and standalone browser-worker fixtures, plus these three
structural matches in production code:

| Pair                                   | Why retained                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IndexedDB/OPFS `persist`               | The two backends own different transaction/handle lifetimes. Their caller-owned batch snapshot is now one shared helper; their short queue/error wrappers remain local.    |
| Shared filesystem `lock`/`globalLock`  | Per-file and allocator locks use different cells and the global lock has a service-owned bypass. Their admitted-section and revocation invariants remain visible together. |
| Supervisor job/start wake registration | Registration validates different authority and uses different listener maps. The callbacks deliberately use the same atomic wake protocol.                                 |

At adoption the scan found 461 duplicate lines, about 0.70%, and 3,198 duplicate
tokens, about 0.61%. These figures describe the measured baseline, not a budget.
Repeated import-scanner loops and persistence batch-copy implementations were
removed before adoption. Existing test repetition stays visible in reports instead
of excluding test directories or merging independent scenario lifetimes.

Inspect the current report with `bun run duplicates`. If an intentional refactor
changes clone identities, inspect both sides of every reported pair before running
`bun run duplicates --update-baseline`. Review the resulting baseline change in the
same PR. Do not increase thresholds or refresh a baseline simply to clear CI.

## Gate regression probes

`tooling/quality-probes.ts` creates fresh synthetic files and verifies actual gate
failures for lint, handwritten JavaScript, accidental browser-global `name` references,
formatting, strict TypeScript, checked JavaScript test inputs, site types, unused files,
unused exports in test entries, exact clones, structural clones and empty duplicate scans. It checks diagnostic evidence as well as exit status, so a
missing tool or an unrelated failure cannot satisfy a probe. Child timeouts and
interrupt signals reach cleanup. Each command owns a process group, and cleanup
retires descendants even after their command leader exits. `finally` removes every
synthetic file. Run it alone with `bun tooling/quality-probes.ts`; do not run it
alongside other checks in the same worktree because its failing sources are intentional.
