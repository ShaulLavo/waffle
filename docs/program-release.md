# Releasing program families

Program families ship as GitHub release tarballs, not npm packages. A consumer depends on the
`base` tarball URL (and optionally `git`), and every edge inside that closure is an exact
release-asset URL: `base` names each family's tarball, and every family names the published
`waffle-v<version>` runtime tarball as its `waffle` dependency or peer. Nothing in the closure
resolves through npm, so no workspace label or unpublished `0.0.0` reaches an installer.

## Build the closure

Prepare each family with its own `prepare:package` route first (see
[program-package-builds.md](program-package-builds.md)). Then, from a clean checkout:

```sh
bun scripts/program-release.ts --tag programs-v0.0.92 --out /work/tmp/programs-v0.0.92 \
  --runtime-url https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.91/waffle-0.0.91.tgz \
  --runtime-sha256 4802672be0fc458d3ef6ae4f5d4998c4c349cae790c6d99236d60a373f4faaea \
  --families base
```

`--list --families base,git` prints the dependency-ordered package directories to prepare.

Production URLs are derived, not supplied: program assets live under
`https://github.com/<repository>/releases/download/<tag>/`, and the runtime URL must be that
repository's `waffle-v<version>/waffle-<version>.tgz`, where `<version>` is the version inside the
hash-checked runtime tarball. `--repository` defaults to `ShaulLavo/waffle`. If the tag already
exists it must name exactly the packed, clean commit (`tagState: tagged`); otherwise the manifest
says `untagged-candidate`, and `--require-tag` refuses it.

The command:

1. Orders the requested families and their workspace dependencies, dependencies first.
2. Copies each package into disposable staging, sets the release version, and rewrites every
   workspace edge (and the `waffle` peer) to its immutable asset URL. `scripts` and
   `devDependencies` are dropped. The source checkout is never modified, and uncommitted
   changes under the released packages refuse the release.
3. Admits prepared guests, notices and payloads with the shared `tools/program-package.ts`, packs
   once with `bun pm pack`, and reads every required asset back from the tarball.
4. Rejects any edge outside the closure, `workspace:` or local-path spec, and `0.0.0` pin, and
   checks that every export, packed relative import, static asset URL and root license exists.
   Bare runtime imports must be declared dependencies.
5. Packs a twin pointing at a local HTTP server, proves it equals the release tarballs except for
   those URLs, and runs a real `bun install` of the whole closure with the npm registry
   unreachable (`--registry` admits declared third-party pins, which Git needs). It imports
   every export. Every exported program descriptor's guest must be the admitted artifact, and
   every admitted `.wasm` must be reached, by a descriptor or by a literal
   `new URL(path, import.meta.url)` in exported code. The manifest records which, per package
   (`guests`). Python's interpreter is a static reference; its qualified-artifact route is not
   exercised by these checks. Pure JavaScript packages (base, Git) admit no guests.
   `--acceptance FILE` also bundles and runs a consumer program against the installed closure.
   Every fetch and child command has a deadline (`--timeout-ms`, default ten minutes). Each child
   runs in its own process group. SIGINT or SIGTERM, or a deadline, retires the whole group before
   staging is removed. A group that will not exit leaves its staging in place and is reported.
6. Writes the tarballs, `program-release.json` (source commit and trees, URLs, sizes, SHA-256s,
   edges and artifact hashes) and `SHA256SUMS` into `OUT/assets`.

The `Program family release` workflow runs the same steps on a `programs-v*` tag that is already
on main. It uploads the verified assets as a workflow artifact, and creates the GitHub release
only when `publish` is set. Python stages a qualified interpreter artifact, so it is released
with the local command rather than the workflow.

## Final program bytes

Family build routes verify compiler outputs before staging program assets. Staging
removes only Wasm `name` custom sections through `tools/program-build-tools.ts`.
Compiler intermediates retain names because the patched-libc verifier uses them.
Package admission rejects named program assets. Release receipts and archive hashes
therefore identify the final stripped bytes. Producers, target features, memory limits,
imports and other custom sections do not change. The base package has no own Wasm;
Git builds JavaScript, so both are no-ops for this operation.

Python stages its accepted producer archive without changing its original receipt or
payload. Its separate `python-program.json` records the producer receipt hash and
interpreter hashes before and after name stripping. It does not claim a new producer.
