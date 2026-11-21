# Packed Coreutils browser profile

The workload runs `cat /input | sha256sum - > /digest` using two WASI Preview 1
programs from the installed Coreutils archive and separate generic Workers from
the installed runtime. It uses a deterministic 2 MiB binary input and a named
FAST filesystem with IndexedDB. The right-hand stdout descriptor points to a
file. The browser checks the digest against Web Crypto and checks that neither
guest emitted terminal output. No optimized host executor or File/Blob staging
route participates in this workload.

## Run the profile

Prepare the runtime and Coreutils with the ordinary pinned tools and package
routes. Set `WASI_SDK_PATH` and `WASM_OPT` as described in
[program builds](program-package-builds.md).

```sh
bun run prepare:package
bun run --cwd packages/coreutils prepare:package
bun run --cwd packages/coreutils pack
bun run programs:packed --workload chromium
```

Pass `firefox` or `webkit` for the corresponding Playwright browser. Install
its matching browser binary before running the command. On Linux, use a short
data-drive path in `STORAGE_SCRATCH_ROOT` for the browser. Set
`PROGRAM_CONSUMER_SCRATCH` to place the disposable installed consumer on that
drive. Keep the final JSON line. The runner closes its browser and loopback
server before removing their scratch files.

To record the same workload in a program release candidate, use
`--families coreutils --workload-browser chromium` with the existing
[local runtime candidate flags](program-release.md#qualify-a-local-runtime-candidate).
The report is in `install.acceptance.output` in `program-release.json`.
`install.acceptance.source` identifies the tracked page inputs.
The enclosing release manifest supplies the runtime and family archive hashes
and the exact runtime source identity.

## Interpret the results

- Each of three fresh browser contexts runs two runtime generations in the same
  document. The first pipeline starts with a fresh runtime, Cache Storage and
  in-page loader. The second reuses the runtime registration and performs no
  Wasm fetch, digest, rewrite or compilation. Recreating the runtime reopens
  the durable filesystem and may reuse the document's compiled-module cache.
  The report records cache observations and actual fetches for each case.
- The first-output clock runs from the producer spawn to the page's first
  nonempty read of the output file. The report records the observed start
  cells, pipe-fill and consumer-start times separately. Polling delay is part
  of that first-output measurement. A full producer lane is required before
  the consumer starts. A separate cancelled `cat` preserves the exact 4 KiB
  prefix it wrote to a file before blocking on more input.
- The I/O intervals cover 16 small create, lookup, read and remove sets,
  sequential append and read, and overwrite of an existing file. The scan
  in [shared allocation](../packages/waffle/fs/shared.ts) searches for a free
  page from the hint and can scan again from zero. The I/O intervals include
  that work and other filesystem work. They cannot isolate time in the scan.
- `flushMs` covers the explicit whole-filesystem checkpoint. The next runtime
  reads the digest back in the same document. This checks the browser storage
  contract and owner handoff. Power loss, eviction and multi-tab writes are
  outside the fixture.
- Ledger rows report declared backing and the current length where observable.
  Process rows report last sampled guest linear-memory length. Browser Worker
  events count constructor and retirement observations. None of those values
  gives per-Worker engine overhead or process RSS. Chromium also reports the
  page target's CDP heap and backing-storage counters at the recorded samples.
- The [copy map](payload-ownership.md) explains the runtime's source snapshot,
  request staging and direct guest VFS I/O. For this pipeline, a ring read
  stages up to one 64 KiB lane in a temporary typed array per call. The ledger
  includes shared pipe backing and control grants. It excludes this private
  scratch, other transient buffers and compiler internals. The artifact
  lengths, request size and ring capacity are bounds on their own paths.
  They cannot establish a whole-page peak or physical reclamation.
- The focus control opens a second tab while the guest is blocked and returns
  to the original document before cancellation. Only an observed hidden
  state counts as background coverage. Chromium's page heap counters and
  the Linux WebKit results describe those Playwright runs. Native Safari,
  the iOS Simulator and physical iPhone/iPad require separate receipts.
- Waffle's harness uses its patched Preview 1 guests, descriptor transfer, and
  an explicit IndexedDB checkpoint. No Microsoft runner was measured with
  the same guests, data, host and durability point, so the profile supplies
  no relative performance result.
