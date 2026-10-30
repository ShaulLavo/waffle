# Program size optimization

Program release routes use size-focused compiler profiles and pinned Binaryen 133.
Rust uses `opt-level="z"`, fat LTO, aborting panics and one codegen unit. Sed owns
an independent profile. Ripgrep receives the same settings in its upstream
workspace. Python's host C compilation and link use `-Oz -flto`; the native build
interpreter is unchanged. Changing compiler policy requires a new producer build,
not relabeling an accepted archive.

## Staging order

1. Preserve the named compiler output and its locale or producer proof.
2. Optimize a private snapshot with the pinned binary, explicit supported
   features, and `-Oz`. Keep scanner and syscall-wrapper bodies available for
   verification. Preserve imports, exports, memory limits and dynamic metadata.
3. Run the existing patched-libc or direct-Rust filesystem verifier against the
   actual optimized code and function indices. Import names alone are not proof.
4. Strip names from the verified candidate, hash final bytes, and stage the
   program plus its `<name>-program.json` derivation. Produce package and direct
   URL copies from one optimization.
5. Compress and pack only the finalized bytes. Pack admission checks the receipt
   chain and reads required files back from the actual archive.

The optimizer strips DWARF but emits names until verification completes. It does
not use fast-math, a closed-world assumption or disabled validation. Relocatable
objects are rejected rather than carrying stale relocation offsets into changed
code. Do not optimize dynamic payload modules without their own qualification.
Git's program is already-minified JavaScript. Base has no binary of its own.

## Tool and receipts

CI provisions Binaryen with `.github/actions/program-optimizer`. Local builders
set `WASM_OPT` to an explicitly installed Binaryen 133 Linux x64 executable. The
helper checks the exact version and executable SHA-256 on every invocation. See
`tools/program-optimize.ts` and the action for the pinned archive, digest and
complete flags. Family builds never download an optimizer.

Derivations bind original input, named optimized output and stripped final output
by size and SHA-256. They record the optimizer policy, executable identity,
features, flags, environment and actual transformation source hashes. A Git commit
is provenance, not a reason to invalidate identical transformation sources after
a documentation-only commit.

Python retains `python-build.json` verbatim. Its separate `python-program.json`
binds that original receipt and interpreter identity to both transformation steps
and the final interpreter. Payloads, notices and licenses keep their original
identities. This does not qualify new Python compiler flags against an old
producer.
