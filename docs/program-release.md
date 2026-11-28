# Releasing program families

Waffle publishes `@waffle-os/runtime` and its `@waffle-os/*` program families on npm. Each family package declares `"@waffle-os/runtime": "*"` in `peerDependencies`, omits `@waffle-os/runtime` from `dependencies` and `optionalDependencies`, and carries an exact integer `waffleHostInterface`.

## Build the closure

Prepare each family with its own `prepare:package` route first, as in
[program-package-builds.md](program-package-builds.md). Then run the release command from a clean
checkout.

```sh
bun scripts/program-release.ts --tag "$PROGRAM_TAG" --out "$OUTPUT" \
  --runtime-url "https://registry.npmjs.org/@waffle-os/runtime/-/runtime-${RUNTIME_VERSION}.tgz" \
  --runtime-sha256 "$RUNTIME_SHA256" --families base
```

`--list --families base,git` prints the dependency-ordered package directories to prepare.

The script derives program family asset URLs under
`https://github.com/<repository>/releases/download/<tag>/`. The default repository is
`ShaulLavo/waffle`. For a published runtime, `--runtime-url` must be the canonical npm tarball URL
for an exact `major.minor.patch` version. The script fetches that tarball or reads
`--runtime-tarball`, checks the archive bytes against `--runtime-sha256`, and verifies the package
name, version, and host-interface metadata.

When the program tag exists, it must name the exact packed, clean commit, and the manifest sets
`tagState` to `tagged`. When the tag is absent, the manifest sets `tagState` to
`untagged-candidate`, and `--require-tag` refuses the run.

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
   `--workload-browser ENGINE` records the [packed Coreutils browser profile](program-workload-profile.md)
   in the same acceptance field when the closure contains Coreutils.
   Every fetch and child command has a deadline (`--timeout-ms`, default ten minutes). Each child
   runs in its own process group. SIGINT or SIGTERM, or a deadline, retires the whole group before
   staging is removed. A group that will not exit leaves its staging in place and is reported.
6. Writes the tarballs, `program-release.json` using schema `waffle-program-release/2`, and
   `SHA256SUMS` into `OUT/assets`. The manifest retains source commits and trees, URLs, sizes,
   SHA-256 values, exact family edges, artifact hashes, and runtime and family interface integers.

The `Program family release` workflow runs the same build, pack, and verification steps on an
existing `programs-v<version>` tag on `main`. It always uploads `.build/program-release/assets` as
the `program-release-<tag>` workflow artifact, which holds the staged tarballs, `SHA256SUMS`, and
staged manifest from qualification.

When `publish` is `true`, the workflow runs `scripts/publish-programs-npm.ts` and publishes the closure to npm:

1. **Existing release lookup.** The workflow queries the GitHub release for `$RELEASE_TAG`. If the release already exists, it downloads the attached `program-release.json` to `.build/program-release/existing-receipt.json` and passes it via `--existing-receipt`. Any API error other than HTTP 404 stops the run.
2. **Repack and artifact verification.** `scripts/publish-programs-npm.ts` reads `<assets>/program-release.json`, checks every staged tarball's byte count and SHA-256, and verifies each package name matches `@waffle-os/<slug>` with an exact semver version. For each package, it deletes `private`, sets `publishConfig` to `{ "access": "public", "provenance": true, "registry": "https://registry.npmjs.org" }`, rewrites inter-family closure URL edges to exact versions, and repacks with `npm pack --ignore-scripts`. It then extracts each repacked archive and confirms every admitted artifact in `pkg.artifacts` still matches its recorded size and SHA-256.
3. **Receipt preflight.** The script builds the npm receipt in memory with schema `waffle-program-release/2` and `assetBase` set to `https://registry.npmjs.org`. Each package entry records the canonical npm filename `<slug>-<version>.tgz`, URL `https://registry.npmjs.org/@waffle-os/<slug>/-/<slug>-<version>.tgz`, npm archive `bytes` and `sha256`, exact `closureDependencies` version map, and admitted `artifacts`. When `--existing-receipt` is set, the script compares that file byte-for-byte against the newly built receipt and aborts on any difference. Running with `--dry-run` stops here without contacting npm or writing the output file.
4. **Registry archive preflight.** Before calling `npm publish` for any package, the script fetches every package's canonical npm tarball URL on `registry.npmjs.org`. A 404 queues the package for publication. A 200 downloads the live npm tarball and checks its byte length and SHA-256 against the newly repacked archive. The script skips an identical archive and aborts before publishing anything on any mismatch or unexpected HTTP status.
5. **Publication and GitHub receipt.** Only after both preflight checks pass does the script run `npm publish <archive> --provenance --access public` for each pending package and write the npm receipt to `.build/program-release/program-release.json`. When no GitHub release existed yet, the workflow creates the GitHub release for `$RELEASE_TAG` with only `.build/program-release/program-release.json` attached.

The `program-release.json` on the GitHub release is an install-verification manifest for npm consumers. Its `assetBase` is `https://registry.npmjs.org`, and its package records identify the exact npm tarballs, SHA-256 digests, inter-family version pins, and admitted guest and notice artifacts installed from the registry.

`.github/workflows/program-release.yml` rejects `python` in `families` because CI does not build CPython. Release `@waffle-os/python` locally from an externally qualified producer artifact.

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

`scripts/program-rebind.ts` rebinds an existing program closure to a newer `@waffle-os/runtime` without rebuilding any guests. It rewrites only `package.json` and proves every other file in every tarball stays byte-identical.

Rebind requires the staged GitHub-format qualification manifest with `assetBase` set to `https://github.com/<owner>/<name>/releases/download/<from-tag>`, along with its matching `SHA256SUMS` and staged tarballs. Do not pass the npm install-verification receipt from the GitHub release, whose `assetBase` is `https://registry.npmjs.org`.

For releases built by `.github/workflows/program-release.yml`, those staged GitHub-format assets live in the `program-release-<from-tag>` GitHub Actions workflow artifact uploaded from `.build/program-release/assets`. Download and extract that artifact, or use a local `<out>/assets` directory from `scripts/program-release.ts`, and pass it with `--from-assets DIR`. The flag accepts either the `assets` directory itself or a parent directory containing `assets/`. For older releases whose GitHub release still hosts the GitHub-format tarballs and manifest directly, you can omit `--from-assets` and let `scripts/program-rebind.ts` download them from the tag's GitHub release URL.

```sh
bun scripts/program-rebind.ts \
  --from-tag programs-v0.0.13 \
  --from-manifest-sha256 <source-manifest-sha256> \
  --from-assets /work/tmp/programs-v0.0.13 \
  --tag "$NEW_PROGRAM_TAG" --out "$OUTPUT" \
  --runtime-url "https://registry.npmjs.org/@waffle-os/runtime/-/runtime-${RUNTIME_VERSION}.tgz" \
  --runtime-sha256 "$RUNTIME_SHA256" \
  --runtime-tarball "$RUNTIME_ARCHIVE" --host-interface "$HOST_INTERFACE" \
  --runtime-source-commit "$RUNTIME_SOURCE_COMMIT" \
  --historical-root /work/worktrees/waffle/checker-3050f69 \
  --acceptance "$PWD/tools/family-packed-app.ts"
```

The tool admits the original tarballs with the checker from their source commit, proves identity
repacking, and rewrites only `package.json`. Guest binaries, notices, descriptors, receipts,
source trees and artifact bytes remain unchanged. The runtime tarball is read from the local file
when supplied, so a private draft asset can be qualified without an unauthenticated fetch.

Rebind output uses `program-release.json` schema `waffle-program-release/2`, with
`operation: "peer-rebind"`. It reads the immutable schema-1 source manifest explicitly, including
family packages that lack `waffleHostInterface`, and never treats missing metadata as compatible for
new releases. Migration requires an explicit `--host-interface` and a matching-runtime `--acceptance`
script from the acceptance source checkout selected by `--root`, which defaults to the checkout containing the executing script. The target runtime archive must carry that same valid integer. A schema-2 source also
requires equality with its existing runtime and family metadata. Each rebound
package receives that exact integer, a wildcard Waffle peer, and no Waffle runtime dependency.
The `rebind` block records the original manifest, historical checker, tool commit, and acceptance
program. Acceptance records its own source commit, root-relative script path, SHA-256, and a
sorted `sources` list of every bundled source path and SHA-256. Each source must be a tracked
regular file identical to that commit and inside `--root`, including imported helpers and JSON
fixtures. The bundler consumes those checked bytes. Only installed closure packages and runtime
built-ins remain external. Modified, untracked, or out-of-root imports refuse acceptance.
Direct `import()` and `require()` calls must use literal module paths, so unresolved module loads
are refused before execution. Source binding identifies module inputs, not arbitrary application I/O.
The executing tool checkout supplies `toolCommit` and `toolDirty` independently of `--root`.
This source list extends the existing acceptance receipt because the entry hash alone does not
identify the imported assertions. The historical checker and package source identities stay bound
to the original release commit. Each package records its metadata changes. Normal releases use `operation: "release"` in the
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
and does not modify an existing runtime archive. Published runtime inputs require their canonical
versioned npm tarball URL and exact archive hash.
