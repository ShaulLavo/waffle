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
   every export and checks that every exported guest is the admitted artifact.
   `--acceptance FILE` also bundles and runs a consumer program against the installed closure.
6. Writes the tarballs, `program-release.json` (source commit and trees, URLs, sizes, SHA-256s,
   edges and artifact hashes) and `SHA256SUMS` into `OUT/assets`.

The `Program family release` workflow runs the same steps on a `programs-v*` tag that is already
on main. It uploads the verified assets as a workflow artifact, and creates the GitHub release
only when `publish` is set. Python stages a qualified interpreter artifact, so it is released
with the local command rather than the workflow.
