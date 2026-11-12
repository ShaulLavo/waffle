# Virtual network allocation contract

The runtime's Rust virtual namespace runs as a private, nonshared ArrayBuffer factory. Its only OS import returns Unsupported. Native `tcp_*` commands are outside this allocation inventory.

## Fixed allocation inventory

Initialization reserves 512 endpoint records, 1,024 sorted TCP listeners, 136 slab pointers, 8,704 free-chunk indices and a 64 KiB scratch buffer. Ephemeral client ports use an inline bitset. Endpoint queues hold 17 chunk indices inline: a 1 MiB queue starting inside a 64 KiB chunk needs at most 17 chunks. Error kinds and binary addresses allocate no strings. Metadata insertion/removal, credit, take, close and chunk return stay within those fixed capacities.

After initialization, `Pool::grow` is the sole virtual allocation site. It requests exactly 4 MiB with `Vec::try_reserve_exact`, fills that capacity, converts it to a boxed slice and retains it until owner release. No slabs are freed or differently sized allocations interleaved. Reuse changes no allocator state. The public Wasm virtual commands share this policy; native OS Tcp does not.

## Conditional allocator bound

The pinned Rust 1.98.1 [wasm allocator](https://github.com/rust-lang/rust/blob/1.98.1/library/std/src/sys/alloc/wasm.rs) routes System allocation to dlmalloc. The target grows linear memory in 64 KiB pages. This identifies the allocator; Rust does not guarantee a 65-page growth bound for a 4 MiB reservation.

For this toolchain, [RawVec::grow_exact](https://github.com/rust-lang/rust/blob/1.98.1/library/alloc/src/raw_vec/mod.rs) requests the exact element capacity. [Vec::into_boxed_slice](https://github.com/rust-lang/rust/blob/1.98.1/library/alloc/src/vec/mod.rs) calls shrink_to_fit, which skips shrinking when length equals capacity. The producer's exact artifact, including allocator metadata and page rounding, must still establish the resulting growth. A general Vec or allocator replacement cannot inherit this bound from the type signature.

Every cold production build executes all 136 slab acquisitions on the exact Wasm bytes. All 512 endpoint queues start 1,000 bytes into a chunk and reach 1 MiB simultaneously. The trace includes zero-growth acquisitions, checks every increment against 65 pages, checks the final length below 16,384 pages, drains every byte intact and reuses all records/chunks without growth. Canonical regressions run the same trace on both forms. The current artifact starts at 20 pages and peaks at 8,730 pages. Whole-buffer copying during translated growth also temporarily retains old and new buffers; this is not a physical-memory bound.

`network.growth.json` binds that complete trace to the Wasm SHA-256 and producer input hash. Verification rejects missing, invalid or mismatched traces before preparing Node output. The hash includes Rust sources, Cargo metadata/lock, rust-toolchain, producer, translator code/pin/lock and growth verifier. Changing them requires regeneration and the complete bound check. If any increment exceeds 65 pages, production fails until the allocation premise and envelope are re-established.

Before a new slab, Rust requires current pages plus 65 to fit within 16,384 pages (1 GiB). This is an operational envelope under the established premise, separate from wasm2js's signed-length problem at 32,768 pages (2 GiB). Unmeasured spare space does not prove safety if that premise changes. Catchable host allocation failure below the quota still requires terminal owner retirement. The tests establish neither physical memory use nor iPhone/framework acceptance.
