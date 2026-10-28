# GNU usage contracts

Status: Approved. This additive corpus covers the documented head, cut and wc options on
small byte fixtures. It does not replace any historical recording.

The native Rust integration tests invoke each package's actual executable. GNU coreutils
9.x supplies the recorded oracle only. This corpus does not establish WASI, browser,
consumer-shell, locale-dependent multibyte or TTY behavior.

File lease: this new fixture directory, its recorder and native test helpers, new head/cut/wc
integration tests, and those commands' implementations only if a concrete small bug needs a fix.
Root CI, manifests, lockfiles and other commands remain parent-owned.
