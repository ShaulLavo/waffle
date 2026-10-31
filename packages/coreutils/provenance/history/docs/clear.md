# clear

`installClear` from `bash-web/utilities/clear` registers `/bin/clear` on the caller's existing Waffle Runtime. Installation does not load the program. First spawn loads the separately linked `dist/clear.wasm` through ordinary WASI admission. `WasiUtilityOptions` accepts `wasmUrl` or raw `source` bytes and an optional `workerUrl`. Conflict and disposal rules follow [Install utilities](guides/install-utilities.md).

```ts
import { installClear } from "bash-web/utilities/clear";
const clear = await installClear(runtime);
// Use the same runtime for createShell; dispose after its processes stop.
await clear.dispose();
```

## Fixed terminal profiles

`clear [-x] [-T terminal]` supports exactly `xterm`, `xterm-256color`, and `xterm-ghostty`. The last `-T` selects the profile; otherwise `TERM` selects it. The browser shell defaults to `TERM=xterm-256color`.

All three profiles emit `ESC [ H ESC [ 2 J ESC [ 3 J`: home the cursor, erase the visible display, and request saved-line erasure. `-x` omits `ESC [ 3 J`, preserving scrollback. The renderer owns saved lines; a terminal that does not implement that sequence cannot erase them. Output goes to stdout, including when redirected, as with host `clear`. No tty detection or terminal response is claimed.

Missing, empty, non-Unicode, and unknown terminal names fail with status 1 and a diagnostic, without stdout. Unsupported flags and operands also fail before any escape bytes are written. `--` is accepted only with no following operands. Combined short flags, attached `-Tname`, `-V`, help flags, and ncurses' other options are not supported. Write errors fail with status 1.

This is a fixed VT-compatible implementation, not a terminfo reader or a claim of ncurses parity. It does not search terminal databases, expand terminfo capabilities, send padding, reset terminal modes, or change the browser renderer.

## Source and qualification

`shell/clear/src/main.rs` is original bash-web code under the repository MIT license, copied at `shell/clear/LICENSE` for generated notices. No upstream source was adapted. Ncurses clear depends on terminfo setup and capability expansion; carrying that database and library is disproportionate to these three identical browser terminal profiles.

The qualification compares literal byte/status expectations with the actual WASI program, and compares `xterm`, `xterm-256color`, and `-x` to `/usr/bin/clear` with a controlled environment. It also drives the existing Ghostty terminal with the guest's output, checking the visible display, cursor home, and saved-line behavior. No host executable is used by the production installer.
