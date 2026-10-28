# Xargs execution

Status: implementation in progress.

Explicit commands use Waffle's existing `waffle-process-consumer` crate and the
caller's runtime process ABI. Arguments are passed as an argv array, without shell
parsing. Default xargs with no command keeps its print-only echo behavior.

Commands must have a live filesystem path and an executable registration. PATH
lookup uses the caller's PATH, or `/bin:/usr/bin` when absent; empty components mean
cwd and a slash bypasses PATH. The base inventory currently has no external echo
utility. `xargs echo` needs that real utility installed; it cannot call a shell
builtin. Replacement (`-I`, `--replace`) and parallel (`-P`) modes remain rejected.
