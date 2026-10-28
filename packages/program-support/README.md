# Neutral program support

Original guest-side code relocated from bash-web at `9ef027d7b8544be7d2d84ee59beea8adf0b33cd8`.

The production boundary is executor/cancellation, descriptor I/O, lexical paths and the minimal filesystem/stdio reactor. Shell parsing, interpreter state, sessions, process groups, spawning, job reaping, input pumps and `ProcessHost` are intentionally absent.

The optional WASI adapter uses only `runtime_proc` (including its `inherited_fd` launch descriptor list) and preview1. It has no Bash crate, Bash worker, `shell_terminal` or executable-query dependency.
