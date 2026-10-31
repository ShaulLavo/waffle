# df source candidate and missing filesystem contract

`crates/df` calls unchanged uutils `uu_df` and `uucore` at
`07763857f6b9a547742a994b58aef0ccd036198b`. It has its own workspace and lockfile.
No family catalog, shared Cargo workspace, locale mapping, or published archive
includes `df`. This is a source candidate, not a supported guest command.

## What the real controls establish

On accepted Waffle `25d1a324ac1af44301e080b4d7c3275db09b13a4`:

- `core/filesystem.ts` has file size, inode, links, and timestamps. It has no
  filesystem-usage query or mount table.
- `core/wasi.ts` writes preview1 file metadata and reports preopen names. A
  preopen is an access grant, not a mount or a capacity record. Its device value
  does not establish a real mounted-filesystem identity.
- The syscall-only fixture runs against the real Waffle `Wasi` and `MemFS`.
  It observes preopen metadata, confirms the absence of guest mount files, and
  checks that an unknown `statvfs` import is rejected. That deliberately invalid
  import is a rejection control, not a proposed ABI.
- The C fixture links with SDK 34.0 and the verified patched libc. On Waffle,
  both real libc calls, `statvfs("/owned", ...)` and `fstatvfs(3, ...)`, return
  `-1` with WASI `ENOSYS`, errno 52. The test prints no usage fields.
- The unmodified upstream `df` build for `wasm32-wasip1` fails with five missing
  platform functions. Its facade selects Unix or Windows, neither of which is
  WASI. The failures name `fs_usage`, `filesystem_from_mount`,
  `filesystem_for_path`, `sync`, and `maybe_unsupported_options`.

The build does not replace those functions, reuse host disk statistics, or
manufacture block size, mount entries, totals, zero capacity, or inode counts.
Memory allocation budgets are not filesystem capacity.

## Waffle-owned prerequisite

Before a guest `df` backend can work, Waffle needs an authoritative filesystem
usage contract at `core/filesystem.ts`, transported by the filesystem protocol,
service, and workspace client, and exposed through a documented guest import.
It must distinguish unsupported or unknown values from measured zero. A backend
must supply meaningful units, total blocks, free blocks, blocks available to the
guest principal, and supported inode totals and free counts. Unavailable fields
must stay unavailable.

Guest-visible filesystem identity and mount membership also need an explicit
contract. Root preopen names and the current preview1 device value cannot stand
in for them. Do not copy the host mount table into the guest. Default `df`, type
filters, remote filters, and totals must remain unsupported until the required
mount information exists. `--sync` also needs an honest support decision.

Only then can an upstream WASI platform backend use that contract. It must keep
upstream parsing and table calculations. Merely enabling Unix code for WASI or
returning `None` from every usage query would not implement the missing service.

## Reproduce the bounded controls

Run substantial commands through the host's existing heavy queue. Set
`DF_BUILD_ROOT` to an owned directory on a verified data drive. Install teardown
before the commands, then remove that directory after child processes stop.
The shared WASI producer prepares or verifies its patched libc there.

```sh
bun test packages/coreutils/tests/df-source.test.ts packages/coreutils/tests/df-capacity.test.ts
DF_BUILD_ROOT="$scratch" bun packages/coreutils/scripts/df-capacity-control.ts
DF_BUILD_ROOT="$scratch" bun packages/coreutils/scripts/build-df.ts
```

The last command is expected to fail at upstream's platform facade. It builds
only the isolated `df` manifest, uses the existing SDK, patched-libc, release,
verification, and optimizer producer, and never builds the family, network, or
Bun. Optimization and staging run only after a successful guest build. No guest
was produced, so lazy loading, removal, runtime catalog, and archive qualification
are not claimed. The low-level capacity controls do not boot networking.

For useful native upstream checks:

```sh
CARGO_TARGET_DIR="$scratch/native" cargo build --locked --offline --release \
  --manifest-path packages/coreutils/crates/df/Cargo.toml --bin df -j2
DF_SCRATCH_ROOT="$scratch" bun packages/coreutils/scripts/df-oracle.ts "$scratch/native/release/df"
```

The oracle verifies GNU `df` 9.12's executable hash before running the candidate.
Sixteen cases cover owned file, directory, spaced-name and symlink operands,
argument errors, help, and version. Only the `file` output field is selected on
successful filesystem queries. The checks compare stdout bytes, exit status,
and diagnostic presence. Help and version check identity and successful status,
not GNU wording. Display flags test parsing only, not numeric scaling. No host
capacity, mount names, filesystem types, or host-wide listings are retained.
`provenance/df.source.json` records source identities and exclusions.
