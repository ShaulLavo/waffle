# Clear contract checks

`clear` supports the fixed `xterm`, `xterm-256color`, and `xterm-ghostty` profiles described in [clear.md](clear.md). Its default output is `ESC [ H ESC [ 2 J ESC [ 3 J`; `-x` omits the last sequence.

The bounded comparison uses host ncurses `clear` as an oracle only for those profiles and the separate `-x` and `-T terminal` arguments. Missing, empty, and unknown terminal values, repeated options, malformed arguments, and stdout failures are checked separately. Exact diagnostic wording is not a parity requirement.

Attached or combined short options, version and help flags, other terminal profiles, and arbitrary operands remain unsupported. Ncurses accepting one of these does not extend Waffle's contract. No terminal database, tty detection, renderer behavior, or Bash consumer behavior is covered.

Native Rust tests run with `cargo test --locked -p waffle-clear`. They exercise the current entry and join the existing CI command without a new guest producer.
