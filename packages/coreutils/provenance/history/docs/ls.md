# ls

`bash-web/utilities/ls` installs the individual uutils `uu_ls` program at `/bin/ls` on the caller's Waffle runtime. It does not add code to the shell engine. The guest is an ordinary WASI program, not a cooperative guest or a coreutils multicall executable.

```ts
import { installLs } from "bash-web/utilities/ls";

const installation = await installLs(runtime);
// After its processes stop:
await installation.dispose();
```

Installation writes an executable marker but does not fetch, compile, or start the program. The first spawn loads `dist/ls.wasm`. Later spawns share the source load. `wasmUrl` overrides the URL. `source` accepts raw bytes or a lazy byte loader. Waffle owns compilation and interruption instrumentation. Precompiled modules are not accepted. The options type is `WasiUtilityOptions`, and lazy input uses `UtilitySource`.

## Supported behavior

The qualified C-locale cases cover default listing, `-a`, `-1`, `-d`, absolute and relative paths, files before directory operands, sorted multiple directories with headers, empty directories, and missing-path status 2. Captured nonterminal output matches GNU coreutils 9.12 byte for byte, including spaces in names. Terminal output uses upstream columns and quoting instead.

The wrapper sets libc's working directory from the shell's `PWD` before upstream entry. Without that step, WASI starts in `/` and `ls` without an operand ignores `cd`.

`-l` runs and prints names, sizes, dates, and file kinds. It is not GNU metadata parity. On this upstream WASI target, owner and group are `somebody` and `somegroup`, link count is synthesized as 1, and mode strings are synthesized from file kind and readonly state. A normal writable Waffle file prints `-r-xr-xr-x`, not its actual permission bits. Directory sizes and totals are not Unix allocated-block counts. The test pins that limitation rather than replacing metadata in the shell adapter.

Symlink targets, hard-link counts, ACLs, ownership lookup, security contexts, terminal-width parity, non-C locale collation, and recursive large-tree behavior are not qualified. Waffle capabilities remain Waffle's responsibility. No link or permissions substitute is included here.

## Source and checks

The source is `uutils/coreutils` revision `07763857f6b9a547742a994b58aef0ccd036198b`, individual crate `src/uu/ls`, through `uucore::bin!(uu_ls)`. The Cargo git dependency and lockfile pin it. `shell/utilities/ls-upstream.json` records the surveyed archive and checksum. No upstream source is patched. `shell/utilities/LICENSE.uutils` retains its MIT notice.

- `npm run build:ls` builds and verifies the final standalone guest with the shared patched wasi-libc and 256 MiB memory ceiling, then copies it to `dist/ls.wasm` and `public/programs/ls.wasm`.
- `npm run build:node-harness && npm run test:ls` checks actual shell spawn and filesystem behavior on Waffle, source laziness, repeat spawn, disposal, and worker cleanup.
- `npm run build:browser && npx playwright test tests/ls.spec.ts` checks GNU fixture bytes, the documented long-format output, missing-path status, and one first-use fetch in the browser.
