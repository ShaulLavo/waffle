# jq compatibility

This package runs the real jaq 3.1.2 evaluator as WASI. It does not translate filters into TypeScript or recognize a fixed set of queries. Unsupported filters fail during compilation or evaluation.

The 43-case corpus in `tests/jq-cases.ts` was recorded from native jq 1.8.2 and runs unchanged against `dist/jq.wasm`. It covers raw scalars, compact arrays and objects, `-e`, `-s`, `-n`, `--arg`, `--argjson`, streams, pipes, `map`, `select`, constructors, strings, recursion, environment access, and invalid input. The gh fixture query is included verbatim.

This corpus is evidence for the covered behavior, not a claim of full jq 1.x or gojq parity.

## Known differences

- jaq's diagnostics and compile-error exits differ from jq and gojq. In particular, an invalid filter exits 3 here, while gh's `--jq` contract requires its adapter to report exit 1. Runtime evaluation errors exit 5.
- The interactive jaq `repl` extension is omitted on WASI because rustyline is not portable to this target. Calling `repl` fails as an undefined filter. Noninteractive evaluation is unaffected.
- Upstream jaq emits one slurped array per file when `-s` receives multiple files. jq emits one combined array. Stdin slurping, which gh uses, matches the native oracle.
- jaq also accepts non-JSON input and output formats. Those extensions are not part of the jq compatibility corpus.

The gh integration must preserve its own output contract: raw top-level scalars and compact arrays or objects. It must not treat every jaq diagnostic as a gh-compatible message without mapping it.

## Recheck

```sh
node packages/jq/tests/record-jq-oracle.ts jq
node packages/jq/scripts/test-jq.ts --native jq
node packages/jq/scripts/test-jq.ts
bun test packages/jq/tests/jq-wasi.test.ts
```

`dist/jq.sizes.json` records the raw Cargo output, name-stripped Wasm, and Brotli sizes for the exact pinned revision.
