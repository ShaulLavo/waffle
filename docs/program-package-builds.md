# Preparing program packages

Each family owns its build and license generation. Program staging requires the
[pinned optimizer](program-optimization.md); CI provisions it explicitly. Run `prepare:package` in coreutils,
grep, findutils or sed to build with the locked patched-sysroot recipe and generate
`dist/THIRD_PARTY_NOTICES.txt` from its locked production dependency graph. The notice
command uses offline Cargo metadata and fails when required cached source/license text
is absent. Ripgrep's existing build generates `dist/rg.NOTICES.txt`.

Python's producer writes an intermediate `dist/`. Its `prepare:package QUALIFIED_ARTIFACT`
command verifies and stages the approved interpreter and payload under public `assets/`.
Git's `prepare:package` builds the two JavaScript bundles and generates their dependency
notices. Python and Git are optional and are excluded from base.

The shared `tools/program-package.ts` checks `package-artifacts.json` before packing.
Every declared guest, bundle and notice must exist and contain bytes. Python payload
files must match the manifest sizes and hashes. Base admission checks all five family
closures. Packing consumes prepared output and never builds or fetches it. The shared
pack command also reads each required asset back from the actual tarball and rejects
files dropped by an ignore rule or the package's `files` list.

## Verify the actual runtime and packed consumer

After preparing the families once and running `bun run prepare:package` for the runtime:

```sh
bun run programs:check
bun run programs:integration
bun run programs:packed
bun run programs:browser
```

These commands reuse the produced guests. Integration checks the public base/family
exports on one caller-owned runtime, with 23 canonical programs, 46 executable paths,
no eager fetch, alias sharing, every family, descriptor forwarding, closed stdout and
interruption. The browser command bundles only the runtime's existing generic workers
and owns its loopback server, headless browser and bundle cleanup.

The packed command installs the actual tarballs in a disposable consumer outside the
workspace. It uses task-local file dependencies and overrides for all seven packages,
then verifies module and guest paths stay inside that installation before running the
same acceptance cases. It removes the consumer after the runtime stops. Set
`PROGRAM_CONSUMER_SCRATCH` if `/work/tmp` is unsuitable on your machine.

This local override test does not qualify default published dependency names or URLs.
The Waffle release owner supplies final dependency rewrites and real release asset
identities before external consumers switch. Private workspace package labels are not
npm publication grants.
