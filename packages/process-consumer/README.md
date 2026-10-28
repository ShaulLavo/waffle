# Process consumer source

Relocated from Bash `shell/wasi-process` at `95827ca4ef80e367bf0eef7b548b6a58683c8719` (tree `c91b1ce2581c53240df77388f56ec122abc27bda`), qualified against Waffle `d3050e73914b7ed4cd72010f72047cce383e2f29`.

Only the crate name and import/path identifiers changed. Request encoding, caller-fatal ownership, outcome decoding, signal handling, executable lookup and wait-flag 2 collection are byte-identical after reversing those relocations. The one import change: launch descriptors come from Waffle's `runtime_proc.inherited_fd` instead of Bash's private `shell_terminal.inherited_fd`, with the same list semantics; no other host ABI is invented or copied. Native builds expose codecs and status types only.
