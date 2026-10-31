# Releasing program families

Program families ship as GitHub release tarballs, not npm packages. A consumer depends on the
`base` tarball URL (and optionally `git`). Family-to-family edges inside that closure are exact
release-asset URLs. Each family carries `waffleHostInterface` and a wildcard
`peerDependencies.waffle`; the consumer manifest names the exact runtime archive separately.
Nothing in the closure resolves through npm, so no workspace label or unpublished `0.0.0` reaches
an installer.

## Build the closure

Prepare each family with its own `prepare:package` route first (see
[program-package-builds.md](program-package-builds.md)). Then, from a clean checkout:

```sh
bun scripts/program-release.ts --tag "$PROGRAM_TAG" --out "$OUTPUT" \
  --runtime-url "$RUNTIME_URL" --runtime-sha256 "$RUNTIME_SHA256" --families base
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
   family-to-family workspace edge to its immutable asset URL. It keeps the Waffle peer as `*`,
   records the exact host-interface integer, and rejects a Waffle dependency or optional
   dependency. `scripts` and `devDependencies` are dropped. The source checkout is never
   modified, and uncommitted changes under the released packages refuse the release.
3. Admits prepared guests, notices and payloads with the shared `tools/program-package.ts`, packs
   once with `bun pm pack`, and reads every required asset back from the tarball.
4. Rejects any edge outside the closure, `workspace:` or local-path spec, and `0.0.0` pin, and
   checks that every export, packed relative import, static asset URL and root license exists.
   Bare runtime imports must be declared peers or dependencies.
5. Packs a twin pointing at a local HTTP server, proves it equals the release tarballs except for
   those URLs, and runs a real `bun install` of the whole closure with the npm registry
   unreachable (`--registry` admits declared third-party pins, which Git needs). It imports
   every export only after checking matching host-interface integers, one physical runtime,
   and one runtime lock entry. Every exported program descriptor's guest must be the admitted artifact, and
   every admitted `.wasm` must be reached, by a descriptor or by a literal
   `new URL(path, import.meta.url)` in exported code. The manifest records which, per package
   (`guests`). Python's interpreter is a static reference; its qualified-artifact route is not
   exercised by these checks. Pure JavaScript packages (base, Git) admit no guests.
   `--acceptance FILE` also bundles and runs a consumer program against the installed closure.
   Every fetch and child command has a deadline (`--timeout-ms`, default ten minutes). Each child
   runs in its own process group. SIGINT or SIGTERM, or a deadline, retires the whole group before
   staging is removed. A group that will not exit leaves its staging in place and is reported.
6. Writes the tarballs, `program-release.json` using schema `waffle-program-release/2`, and
   `SHA256SUMS` into `OUT/assets`. The manifest retains source commits and trees, URLs, sizes,
   SHA-256 values, exact family edges, artifact hashes, and runtime and family interface integers.

The `Program family release` workflow runs the same steps on a `programs-v*` tag that is already
on main. It uploads the verified assets as a workflow artifact, and creates the GitHub release
only when `publish` is set. Python stages a qualified interpreter artifact, so it is released
with the local command rather than the workflow.

## Final program bytes

Family build routes preserve their original named compiler outputs and producer proofs.
The [program optimizer](program-optimization.md) transforms private snapshots, then
runs the original patched-libc or direct-Rust verifier on actual optimized code.
Only afterward does staging strip names and emit final bytes with a strict
`<program>-program.json` derivation. Package admission checks that two-step chain,
pinned optimizer policy, transformation sources and actual final hash/size. Release
and archive hashes identify those final bytes. Base has no binary and Git builds
already-minified JavaScript.

Python retains its original producer receipt and payload byte-for-byte. Its separate
`python-program.json` binds the producer receipt and original interpreter identity to
the optimization, name stripping and final interpreter. It does not claim a new
producer or retroactively apply new C compiler flags to an accepted archive.

## Peer rebind

A published family closure can move to a new Waffle runtime without rebuilding its guests. Use the
explicit rebind tool with the immutable source assets and the runtime archive supplied by the
runtime release lane:

```sh
bun scripts/program-rebind.ts \
  --from-tag programs-v0.0.13 \
  --from-manifest-sha256 <source-manifest-sha256> \
  --from-assets /work/tmp/programs-v0.0.13 \
  --tag "$NEW_PROGRAM_TAG" --out "$OUTPUT" \
  --runtime-url "$RUNTIME_URL" --runtime-sha256 "$RUNTIME_SHA256" \
  --runtime-tarball "$RUNTIME_ARCHIVE" --host-interface "$HOST_INTERFACE" \
  --runtime-source-commit "$RUNTIME_SOURCE_COMMIT" \
  --historical-root /work/worktrees/waffle/checker-3050f69 \
  --acceptance /work/worktrees/waffle/checker-3050f69/tools/family-packed-app.ts
```

The tool admits the original tarballs with the checker from their source commit, proves identity
repacking, and rewrites only `package.json`. Guest binaries, notices, descriptors, receipts,
source trees and artifact bytes remain unchanged. The runtime tarball is read from the local file
when supplied, so a private draft asset can be qualified without an unauthenticated fetch.

Rebind output uses `program-release.json` schema `waffle-program-release/2`, with
`operation: "peer-rebind"`. It reads the immutable schema-1 source manifest explicitly, including
family packages that lack `waffleHostInterface`, and never treats missing metadata as compatible for
new releases. Migration requires an explicit `--host-interface` and the unchanged historical `--acceptance`
script. The target runtime archive must carry that same valid integer. A schema-2 source also
requires equality with its existing runtime and family metadata. Each rebound
package receives that exact integer, a wildcard Waffle peer, and no Waffle runtime dependency.
The `rebind` block records the original manifest, historical checker, tool commit, and acceptance
harness. Each package records its metadata changes. Normal releases use `operation: "release"` in the
same schema. Current-main admission is not used for historical receipts that the current checker
correctly refuses.

A local runtime archive defaults to provisional candidate metadata. `--runtime-source-commit`
records its supplied source identity. After the runtime publisher verifies the public bytes,
`--runtime-published` marks that same input as published. The program tarballs do not embed the
runtime checksum, so changing the runtime archive or its publication state leaves their hashes
unchanged. Do not publish a manifest that promises a provisional runtime checksum.

## Qualify a local runtime candidate

To qualify unpublished interface-bearing bytes without promising a public runtime release, pass
`--runtime-tarball "$RUNTIME_ARCHIVE"`, its exact SHA-256, its absolute `file:` URL as
`--runtime-url`, and `--runtime-candidate-source-commit "$SOURCE_COMMIT"`. Normal release and
rebind commands accept this explicit candidate mode. The runtime package version stays unchanged.
The output records `runtime.input.kind: "local-candidate"` and the supplied source commit.
A candidate cannot use a public release URL or be marked published. This creates no tag or release
and does not modify an existing runtime archive. The public release path still requires its exact
immutable URL and archive hash.
