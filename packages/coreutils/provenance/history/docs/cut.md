# cut

`bash-web/utilities/cut` installs `/bin/cut` as a separate, lazy ordinary WASI program on the caller's Waffle runtime.

```ts
import { installCut } from "bash-web/utilities/cut";

const cut = await installCut(runtime);
// The caller's shell can now run: printf 'a:b:c\n' | cut -d: -f2
await cut.dispose();
```

The entry exports `WasiUtilityOptions`, `UtilitySource`, and `UtilityInstallation`. `source` accepts raw bytes or a lazy byte loader. `wasmUrl` selects a URL instead. Neither precompiled modules nor cooperative execution are used. The default URL is `dist/cut.wasm`. Loading starts at the first invocation, not installation. Dispose unregisters only this installation; it does not dispose the borrowed runtime.

## Supported boundary

The implementation is upstream `uu_cut` and `uucore` at uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, version `0.13.0`. Cargo locks both the revision and transitive dependencies. `shell/cut/src/main.rs` calls upstream's entry after setting the WASI working directory from `PWD`. No selection algorithm is copied or replaced.

The GNU comparison cases cover byte and character ranges in `LC_ALL=C`, open and overlapping ranges, complements, tab and custom field delimiters, output delimiters, undelimited suppression, empty fields, files and stdin, relative paths, empty and unterminated input, NUL and binary bytes, invalid options, and exit status. Error text is upstream's and need not match GNU's wording.

WASI exposes the runtime's filesystem, not the host filesystem. These tests do not establish full GNU parity, locale-dependent multibyte behavior, or performance parity.

## Verification checkpoint

The ordinary-source admission and 24 GNU comparisons pass on bash-web base `938366c2` with temporary installer checkpoint `2d5673a144955d3231fac6baa0d00e456fbb0ad4` and alignment `235f2d9`. The Waffle pin is `c1cb67c300439af24335d0b2ec481bfb52f79a01`. These are historical accepted results, not a new campaign on the standalone split. The standalone PR adds cut to current main without replaying those campaigns.

`scripts/test-own-shell-cut.ts` exercises actual Waffle source admission, lazy bytes, disposal, exit status, and interruption. `tests/cut.spec.ts` runs the usage cases in browser shell pipelines. Packaging checks keep this program out of the core and every other utility entry. Browser execution remains pending; test discovery alone is not runtime acceptance.

Both runners replay only the 24 cut cases from `scripts/owned-fixtures/cut-tr.json`. The complete 45-case historical recording and its digest remain unchanged. It was captured once with GNU Bash 5.3.15 and GNU coreutils 9.12 in `LC_ALL=C`. The recording preserves stdout bytes, exit status, and stderr presence. Its digest, executable identities, and capture environment are recorded in `sources.lock.json`. Missing or changed cases and observations fail validation. Qualification never invokes the host's Bash or utilities. `npm run record:cut-tr -- /absolute/path/to/bash-5.3.15` is the local maintenance recorder and refuses to overwrite an existing recording.

The upstream [MIT license](licenses/uutils-coreutils-MIT.txt) is retained and included in generated distribution notices. The separate [tr program](tr.md) also uses this recording for its own qualification and combined pipelines.
