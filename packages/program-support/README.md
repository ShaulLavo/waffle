# Neutral program support

Original guest-side code relocated from bash-web at `9ef027d7b8544be7d2d84ee59beea8adf0b33cd8`.

The production boundary is executor/cancellation, descriptor I/O, lexical paths and the minimal filesystem/stdio reactor. Shell parsing, interpreter state, sessions, process groups, spawning, job reaping, input pumps and `ProcessHost` are intentionally absent.

The optional WASI adapter uses `runtime_proc`, preview1 and a provisional generic `waffle_program.inherited_fd` import. It has no Bash crate, Bash worker, `shell_terminal` or executable-query dependency.
