# Preparing program packages

Each family owns its build and license generation. Run `prepare:package` in coreutils,
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
