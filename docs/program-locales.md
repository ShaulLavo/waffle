# English program catalogs

Waffle's uutils-based program producer embeds the selected utility's English Fluent
catalog, the common English help catalog, and the common English error catalog.
It does not embed other utilities' catalogs or French catalogs. Unsupported language
requests use uucore's existing English fallback. Unicode collation, normalization,
timezone records, and program argument handling are unchanged.

## Producer identity

`tools/program-locales/sources.json` pins the two supported uucore sources, their
original `build.rs` hashes, and every admitted English catalog hash. The registry
source is uucore 0.12.0 from coreutils revision
`dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69`. The Git source is uucore 0.13.0 at
`07763857f6b9a547742a994b58aef0ccd036198b`.

An explicit Rust compiler wrapper transforms only those build scripts. It preserves
the Git build script's target configuration aliases and replaces catalog discovery
with a single-program English selection. Every unrelated compiler invocation keeps
its arguments and Cargo jobserver descriptors. An unknown source or changed catalog
fails the build. The Cargo registry and Git caches remain untouched.

The producer writes content-addressed `selection.json` and version-specific input
lists below `.build/program-locales/`. The selection records original build-script,
implementation, and catalog hashes. `generated.json` records the generated Rust
source hashes and exact catalog keys. Changing the implementation selects a fresh
Cargo cache namespace. Changing the utility input makes Cargo rerun the build script.
Unchanged inputs reuse the same cache.

A family lock spans Cargo, catalog verification, and the copy into the existing
release directory. Concurrent builds cannot exchange catalog proofs. Grouped
coreutils builds become single-bin invocations sharing one dependency cache.
Compiler output keeps its function names for the patched-libc verifier. Any later
staged-byte transformation is a separate derivation, not a locale producer identity.

## Coverage

| Programs                                      | Fluent policy                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| echo, ls, env, cut, tr, wc, touch, rm, cp, mv | Git 0.13 utility English plus common English help and errors                                            |
| head, sort, uniq                              | Registry 0.12 utility English plus common English help and errors                                       |
| find, xargs, sed                              | Registry 0.12 common English only; no utility Fluent catalog is used                                    |
| clear, cat, mkdir, seq, tail, which           | No linked Fluent localization use; common-only producer policy for any compiled uucore dependency       |
| grep, rg                                      | Not applicable; no uucore or Fluent catalog producer                                                    |
| Python                                        | Not applicable to this transformation; CPython and its standard-library payload are not uucore catalogs |
| Git, base                                     | Not applicable; JavaScript packages without a uucore catalog producer                                   |

## Checks

Run the cheap selection and source-identity checks with:

```sh
bun test tools/program-locales/*.test.ts
```

Real producer qualification also runs both uucore versions, compares English help,
errors, output bytes and exit status, and inspects the generated catalog keys and
hashes. Artifact-size comparisons use actual before and after bytes from the same
source base and toolchain. They do not establish a live transfer or latency gain.
