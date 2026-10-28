# Clear contract checks

`clear` supports the fixed `xterm`, `xterm-256color`, and `xterm-ghostty` profiles described in [clear.md](clear.md). Its default output is `ESC [ H ESC [ 2 J ESC [ 3 J`; `-x` omits the last sequence.

The bounded comparison uses host ncurses `clear` as an oracle only for those profiles and the separate `-x` and `-T terminal` arguments. Missing, empty, and unknown terminal values, repeated options, malformed arguments, and stdout failures are checked separately. Exact diagnostic wording is not a parity requirement.

Attached or combined short options, version and help flags, other terminal profiles, and arbitrary operands remain unsupported. Ncurses accepting one of these does not extend Waffle's contract. No terminal database, tty detection, renderer behavior, or Bash consumer behavior is covered.

Native Rust tests run with `cargo test --locked -p waffle-clear`. They exercise the current entry and join the existing CI command without a new guest producer.

## Oracle scope

The 2026-10-28 comparison used ncurses 6.6.20251230 with the host's `xterm`, `xterm-256color`, and `xterm-ghostty` terminfo entries. All three entries specify `clear=\E[H\E[2J` and `E3=\E[3J`. The native entry matched status and output bytes for the supported syntax, terminal selection, and missing or invalid terminal cases.

Ncurses also accepted `-xx`, `-xT xterm`, `-Txterm`, and `-V`; Waffle deliberately rejected them. They remain outside the supported syntax.

With stdout closed on Linux, both native Rust clear and ncurses returned success for valid input and status 1 for invalid input. Rust's standard stdout does not expose that closed descriptor as a write error. A failing writable sink such as `/dev/full` does produce status 1 and a diagnostic. The native closed-descriptor observation does not establish a WASI or browser descriptor contract.
