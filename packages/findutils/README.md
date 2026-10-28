# Waffle findutils

WASI `find` and `xargs` for Waffle. Import `findutils` and pass it to Waffle's generic program installer. It carries the ordinary guests, exact upstream patches, provenance and bounded native tests. No installer, worker, runtime or Bash engine is included.

`find` preserves traversal and predicate behavior within its accepted WASI scope and rejects `-exec`, `-execdir`, `-ok` and `-okdir` before traversal. `xargs` parses and echoes batches; every explicit command, replacement and parallel mode is rejected because child-process execution is not part of this candidate.

The provisional manifest and build recipe are transfer data. Waffle owns the final package names, aliases, installer, SDK/sysroot and guest verifier.
