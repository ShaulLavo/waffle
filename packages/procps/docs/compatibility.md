# Bounded command behavior

These are pure snapshot operations, not installed shell commands. No function in this package signals a process.

## ps

`-p` and `--pid`, `--ppid`, and `-C` select by admitted PID, original PPID, and executable basename. Selectors combine by union, like procps selection lists. `-e` and `-A` select all rows in the supplied Waffle snapshot, never host processes.

`-o` and `--format` require explicit columns. Supported fields are `pid`, `ppid`, `comm`, and `args`, with `cmd` and `command` as args aliases. Empty `=` headings suppress the header when every heading is empty. `--no-headers` suppresses it explicitly. Numeric columns are right aligned. `comm` has a minimum width of 15. Long fields expand rather than fabricate values. `--sort` accepts comma-separated supported fields with optional `+` or `-` prefixes. Ties use numeric PID, not start age.

Default width is 80 characters. One `-w` selects 132 and repeated `-w` removes the limit. `--width` and `--cols` accept 1 through 10000. Output length counts JavaScript UTF-16 units. Native byte/display-cell parity is claimed only for the recorded ASCII cases.

Without an explicit selector or `-o`, the result is unsupported. Native default terminal selection and statistics are unavailable. `-f`, `--forest`, native scheduling states, CPU, RSS, TTY, account fields, elapsed time, oldest/newest, and start-time sorts remain unsupported. No-match status is 1. Unsupported or parser errors also use status 1, with a package-specific diagnostic rather than copied Linux help text.

## pgrep

`-f`, `-a`, `-l`, `-c`, `-x`, `-i`, and `-P` support full-argv matching, full-command listing, short-name listing, counts, exact matching, ASCII case folding, and parent constraints. Their long forms are also supported. Short option clusters and attached `-P` values work. Parent constraints intersect with the pattern. Self is always excluded. A parent selector can stand alone without a pattern.

Full command text uses the supplied argv, including argv[0], joined with spaces. Name matching and `-l` use the first 15 UTF-8 bytes of the executable basename. Waffle does not expose Linux `comm`, so renamed native process names and non-ASCII byte semantics are outside this contract. Truncated UTF-8 names decode with the replacement character.

Matches return status 0, no matches return 1, and parser failures return 2. `-c` prints `0` for no match and still returns 1. Invalid regex syntax has the recorded diagnostic. Other unsupported syntax has an explicit unsupported result, not a false no-match.

## Pattern subset

ASCII literals, edge anchors `^` and `$`, dot, bracket lists and ranges, negated lists, escaped punctuation, and `*`, `+`, and `?` are supported. Dot also matches newlines in argv text. Exact matching requires both ends of the text, rather than a prefix. Pattern matching uses bounded dynamic programming, not the host engine's backtracking regular-expression executor. It uses two buffers proportional to the subject length and work proportional to pattern length times subject length. Patterns are limited to 512 characters.

Groups, alternation, braces, named POSIX classes, escaped letters, backreferences, non-ASCII patterns, and internal anchors produce unsupported results. This smaller grammar covers the supplied native fixture patterns without silently treating JavaScript extensions as POSIX regular expressions. Complete POSIX ERE compatibility is not claimed.

## pkill

Selection shares pgrep's subset. Supported signal spellings are `-TERM`, `-INT`, `-KILL`, `-PIPE`, their numeric forms, and `--signal` with or without `SIG`. TERM is the default. A match returns an inert plan containing only the signal and selected PIDs. It has no successful exit status because no signal was delivered. A no-match result is ordinary status 1.

Signal zero, other signals, oldest/newest, account/session/group/TTY matching, listing, and count are unsupported. An invalid signal has parser status 2 but package-specific diagnostic text. Signaling success, per-target permission errors, stale-target races, delivery counts, and stop completion remain untested until a procps host-command adapter uses Waffle's delegated authority.

## Recorded native comparisons

`tests/oracle.test.ts` accounts for all 37 original cases:

- 23 cases compare raw status, stdout, and stderr byte-for-byte on snapshots built from the recorded fixture fields. This includes the real probe row observed by `ps --ppid` and delta's absence after the recorded native termination.
- 12 cases assert explicit unsupported results. The package does not replace missing statistics or age, accept forest, or fake signal zero.
- The TERM case compares only the signal plan and selected fixture PID. It is not delivery evidence.
- The invalid-signal case compares only status and empty stdout. It does not claim native usage-text parity.

No native process is launched or inspected by these comparisons. The oracle and survey files retain their original SHA-256 hashes. The collector's raw output remains authoritative, including its normalization limitations. Waffle now supports host commands and delegated signals. Procps lazy-load identity, archive-installed command execution, removal, signal delivery, and physical-stop fences remain unimplemented and unqualified by these fixtures.
