# tr

`bash-web/utilities/tr` installs `/bin/tr` as a separate program on the caller's Waffle runtime.

```ts
import { installTr } from "bash-web/utilities/tr";

const tr = await installTr(runtime);
// The caller's shell can now run: printf 'hello\n' | tr a-z A-Z
await tr.dispose();
```

The installer accepts `WasiUtilityOptions`: raw bytes or a lazy loader through `source`, or a URL through `wasmUrl`. The default is `dist/tr.wasm`. Loading starts on the first invocation. Disposal unregisters this installation and leaves the caller's runtime and other programs available.

## Source and supported behavior

The program calls unmodified upstream `uu_tr` and `uucore` from uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, version `0.13.0`. `shell/tr/Cargo.toml` and the Cargo lock record the source. The [MIT license](licenses/uutils-coreutils-MIT.txt) is included in distribution notices. Translation and squeezing run inside the guest; there is no host program fallback.

The frozen GNU cases cover character ranges and classes, translation, deletion, squeezing, combined operations, complements, short and repeated destination sets, truncation, empty and unterminated input, binary bytes, errors, and composition with cut. Comparisons use `LC_ALL=C`, stdout bytes, exit status and stderr presence. They do not establish locale-dependent multibyte behavior or exact diagnostic wording.

## Verification

`scripts/test-own-shell-tr.ts` exercises Waffle's ordinary source admission, first-use loading, all 21 tr and combined observations, cancellation, recovery, independent installer disposal and worker cleanup. `tests/tr.spec.ts` replays those observations and cancellation in browser shell pipelines. Both select the non-cut cases from the unchanged 45-case [cut recording](cut.md#verification-checkpoint); no live host oracle runs during qualification.

The retained original guest is 1,337,001 bytes with SHA256 `7b6e8ed6f3170c45585c5f4be8e422d6ab4dd5836cb4addd3c09991b09cff65a`. Its SIMD instructions pass ordinary admission on Waffle `d0c5f8a1a9a6723c2f9fccf5df8544b8aad84a00`. No guest rebuild or runtime bypass is needed.
