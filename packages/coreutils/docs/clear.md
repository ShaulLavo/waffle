# clear

Clear the supported browser terminal profiles. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/clear` with a `/bin` alias.

```ts
import { coreutils } from "waffle-coreutils";
import { installPrograms } from "waffle/programs";

const installed = await installPrograms(runtime, [coreutils], { launcher });
// The caller owns its runtime and generic preview1 launcher.
await installed.dispose();
```

Installing the family does not fetch or start programs. The runtime owns markers, conflicts,
first-use source admission, process lifetimes and disposal. `waffle-base` includes this
family with the other everyday programs. See [installing program packages](../../../docs/guides/install-program-packages.md).

## Fixed terminal profiles

`clear [-x] [-T terminal]` supports exactly `xterm`, `xterm-256color`, and `xterm-ghostty`. The last `-T` selects the profile; otherwise `TERM` selects it. The browser shell defaults to `TERM=xterm-256color`.

All three profiles emit `ESC [ H ESC [ 2 J ESC [ 3 J`: home the cursor, erase the visible display, and request saved-line erasure. `-x` omits `ESC [ 3 J`, preserving scrollback. The renderer owns saved lines; a terminal that does not implement that sequence cannot erase them. Output goes to stdout, including when redirected, as with host `clear`. No tty detection or terminal response is claimed.

Missing, empty, non-Unicode, and unknown terminal names fail with status 1 and a diagnostic, without stdout. Unsupported flags and operands also fail before any escape bytes are written. `--` is accepted only with no following operands. Combined short flags, attached `-Tname`, `-V`, help flags, and ncurses' other options are not supported. Write errors fail with status 1.

This is a fixed VT-compatible implementation, not a terminfo reader or a claim of ncurses parity. It does not search terminal databases, expand terminfo capabilities, send padding, reset terminal modes, or change the browser renderer.

## Source and verification

The current entry is [crates/clear/src/main.rs](../crates/clear/src/main.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/clear.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
