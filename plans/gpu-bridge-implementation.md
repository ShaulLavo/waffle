# WebGPU bridge implementation design

Status: **Approved and active.** Approved November 2, 2026; execution started November 6.
This implements [the GPU bridge](gpu-bridge.md), not the later Rust backend or complete window API.

Opus wrote checkpoint `8583a142` against Waffle `402fdafc`. Independent Sol review found seven
execution and lifetime gaps. This revision incorporates the coordinator's corrections and Opus's
revised frame representation. The implementation PR carries this design; no plan-only PR is needed.
The review and frame probes are retained under the feature track's external report directory.

## Boundary and finish lines

One lazy GPU service Worker belongs to the runtime. Blocking WASI Preview 1 guests send a
WebGPU-derived stream to it. Each launch requires an explicit grant. Neither a guest nor another
process receives the service's devices, canvas objects, owner state, ports, or private ring views.

G0.1 proves the schema, transport and replay core without exposing a runtime GPU API. G0.2 draws
and retains a triangle from a compiled, blocking WASI C guest, using the real launch, grant and
completion path. Page JavaScript supplies capabilities and reads pixels; it never substitutes a
command stream. G1 through G5 complete the approved bridge. None of these checkpoints alone is
full bridge completion.

Keep the approved boundaries:

- One runtime and one GPU service, not a service per process. No WebGL fallback.
- A WebGPU stream usable by a future C `webgpu.h` client, not a wgpu-specific format.
- Rust client libraries stay outside this repository. C and Rust test fixtures remain allowed.
- No guest GPU object sharing, external video texture import, WebXR, or threaded launch yet.
- Additive imports keep `waffleHostInterface` unchanged. No compatibility negotiation.
- WIT issue #286 is not resolved by this work. Use the allowed handwritten imports now.

## Modules and public entry

All production code is TypeScript under `packages/waffle/`.

| Path                                 | Responsibility                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `browser/display/owner.ts`           | Trusted page display, surfaces, grants, resize tracking, rAF credits, pending opens and service ownership. |
| `browser/display/protocol.ts`        | Type-only launch payloads, tagged identities and surface information layout.                               |
| `browser/display/guest.ts`           | Captured `runtime_window.surfaces` and `surface_info` imports.                                             |
| `browser/gpu/guest.ts`               | Captured blocking `runtime_gpu` imports and local connection state.                                        |
| `browser/gpu/protocol.ts`            | Parsed transport states, records, terminal reasons and limits.                                             |
| `browser/gpu/ring.ts`                | Fixed shared rings, framing, chunk transport and checked counter arithmetic.                               |
| `browser/gpu/replay.ts`              | Generated-layout decoding and explicit named lowering adapters, with an injected target for tests.         |
| `browser/gpu/service.ts`             | Connection owners, object tables, bounded replies and pending operations.                                  |
| `browser/gpu/scheduler.ts`           | Resumable replay and round-robin task scheduling.                                                          |
| `browser/gpu/surfaces.ts`            | Stable frame textures, private presentation canvases and retained visible bitmaps.                         |
| `browser/gpu/service-worker.ts`      | Responsive service entry, connection registry and ordered owner messages.                                  |
| `browser/gpu/stream.json`            | Selected calls, explicit opcodes, lowering metadata, completions and retired values.                       |
| `browser/gpu/upstream/`              | Pinned `webgpu.yml` and its license.                                                                       |
| `browser/gpu/generated/tables.ts`    | Checked-in generated layouts and value maps.                                                               |
| `tooling/gpu-stream.ts`              | Generator and freshness check.                                                                             |
| `tooling/gpu-size.ts`                | Display, guest and service bundle gates.                                                                   |
| `tooling/gpu-measure.ts`             | Portable measurement runner for G0.3 and G4.                                                               |
| `scripts/build-gpu-fixture.ts`       | Pinned wasi-sdk C fixture build and verification.                                                          |
| `tests/gpu-*`, `tests/fixtures/gpu/` | Unit tests, browser runner, C programs, generated fixture header and golden vectors.                       |

`await runtime.display()` dynamically imports the owner, without starting a service Worker or
activating processes. `createSurface(canvas)` retains the element without transferring it yet.
The minimal GPU-owned display has no input event ring, clipboard or gesture operations.

```ts
const display = await runtime.display();
const surface = display.createSurface(canvas);
const graphics = display.grant({ surfaces: [surface], gpu: true });
// The registered adapter passes graphics to service.launchWorker(context, options).
```

`gpu: false` grants only the surface information imports. An empty surface list with `gpu: true`
permits compute. A missing graphics grant links neither namespace. Guest-spawned children inherit
nothing. `launchThreadWorker` rejects graphics before creating a thread owner and disposes the
rejected grant exactly once. Windows W1 later adds the ordinary spawn option; do not alter it here.

New exports follow the package's source and prepared Node conditions: `./browser/display` and
`./browser/gpu/service-worker`. The owner resolves its worker URL relative to its module. Check
both source-only bundling and prepared package entry points.

## Ownership, revocation and asynchronous work

Use tagged grant, service-incarnation, connection, token and object identities. Model states as
unions, not unrelated booleans:

- Grant: `live`, `revoking`, `retired`.
- Connection: `opening`, `ready`, or `terminal` with one immutable reason.
- Open transaction: `allocated`, `attaching`, `ready`, or `terminal`.
- Replay: `idle`, `blob` with cursor and live encoders, `await` with its cause, or `terminal`.

`display.grant` validates that every surface belongs to this display and has no live holder.
The single-launch owner contains the transferable connection and idempotent disposal. Its
internal retirement promise lets broker cleanup and runtime disposal await service retirement.
Logical revocation is synchronous; physical cleanup still follows the existing broker wrapper.
Preserve cleanup for failures before a `RuntimeChild` exists.

Register a pending open on the page before constructing a service or transferring a canvas.
Worker construction, initial post, attachment, linking, runtime disposal and grant revocation
must all settle its open control word with an error and notify it. Failure before `open` still
releases the launch grant. No unpublished success state is assumed.

Every promise continuation captures its connection owner and service incarnation. It checks
terminal state before binding objects or publishing a result. Late devices are destroyed even
if they were never inserted into an object table. A terminal owner cannot become ready again.
Track all requested devices, not only the last one. Pending closures retain only the small owner
and necessary native operation; after retirement they hold no rings, arenas or surface presenters.

The page sends revoke before regrant on the same ordered service port. The service marks the
connection terminal, drops replay and presenter state, destroys all its devices, releases the
surface and acknowledges retirement. A new holder cannot configure before that release. Queued
old opens, ticks and results carry the old identity and cannot mutate the new holder.

On Worker failure, settle every pending open and ready control block, terminate and retire the
failed Worker, then permit a fresh service. Transferred surfaces are lost in this case and need
new canvas elements. An `error` event alone is not proof that the old Worker stopped.

## Allocation and admission

The launch already admits a process shared-control grant through `RuntimeReservations.admit`.
Use the installed `allocateSharedControl` for every guest-side GPU shared allocation, before
construction, with the existing receipts. Do not call captured SAB constructors directly or
admit buffers after constructing them. G0.2 must use this path; admission is not deferred to G3.

The initial transport uses fixed buffers, not a growable 64 MiB payload arena:

- A 64-byte connection control block.
- A command ring, default 4 MiB plus its 64-byte header.
- A completion ring, default 256 KiB plus its 64-byte header.
- A fixed 1 MiB payload backing when G2 is active. Its first 2,112 bytes hold a 64-byte header and 64 fixed 32-byte slot descriptors. The remaining 1,046,464 bytes hold payload data. The guest allocates this backing through `allocateSharedControl` before construction and includes it in the existing open transfer. No extra arena metadata backing or reservation algorithm is introduced. The existing command-ring publication selects the one terminal-reason winner for this connection. Every other terminal field mirrors that returned winner, and payload admission reads the selector rather than relying on mirror timing.

Limits are validated in the trusted launch configuration. Up to eight live connections are
allowed, but that is not a guarantee that all fit a bounded grant. The existing 64 MiB process
allowance also covers other controls. A claim failure returns `-ENOMEM` before service activation
or canvas transfer. A partially allocated failed open remains charged by the existing allocator.
Closing and reopening does not refund an incarnation's monotonic control quota. Do not invent a
new refund or import API in the reservations module.

The page validates attached buffer shapes against its grant and keeps the backing receipts and
owner references until service retirement. Count each backing once, not once per cross-realm
wrapper. Follow the shipped ledger's conservative post-stop debt rules; tests must not pretend
that object-table cleanup instantly reclaims the shared byte charge. Fixed surface-info and
page/service control blocks use the trusted runtime reservation allocator and explicit labels.
Coordinate any necessary label extension with the reservations and threads owner before editing
those shared files.

Service-owned ordinary reassembly buffers have a separate accounted heap budget: at most
16 MiB per logical record and 64 MiB across the service. Reserve that credit before allocating;
refuse only the offending connection when it cannot fit. No unbounded pending buffer list.
Frame images and textures are not shared-control backings. Track their logical byte estimates
separately, cap surface count and configured dimensions, and measure actual driver overhead in
G0.3. Those estimates are not a promise about the browser driver's physical memory use.

## Guest imports and controls

The surface information block is fixed and seqlocked: width and height in physical pixels,
scale in thousandths, and visibility/focus flags. The page updates it on resize and visibility
changes. Keep the handwritten window subset from the family plan:

```text
runtime_window.surfaces(out_ptr, out_len) -> count
runtime_window.surface_info(id, out{width, height, scale_milli, flags}) -> 0
runtime_gpu.open(flags, out{conn}) -> 0
runtime_gpu.append(conn, ptr, len) -> 0
runtime_gpu.completions(conn, ptr, len, timeout_ns: i64, out{written}) -> 0
runtime_gpu.payload(conn, handle, dst_ptr, len) -> 0
runtime_gpu.close(conn) -> 0
```

All spans are checked against guest memory before side effects. Results are counts or negative
WASI errors: `EBADF`, `EINVAL`, `ENOBUFS`, `ENOMEM`, `ENOTSUP`, `EPIPE` and `EMFILE` as appropriate.
A terminal resource exhaustion is `ENOMEM`, not an endless wait. Waits use the bootstrap's
captured Atomics and liveness check in bounded slices; the guest never needs to receive a message
while blocked.

Control words include open status, connection state, terminal errno/reason and a wake counter.
The terminal reason is authoritative even if the completion ring is full. `completions` first
drains committed whole records, then returns the terminal errno. `close` is idempotent and
invalidates outstanding payload handles; later payload reads return `EPIPE`.

## Schema, lowering and first-layout checkpoint

Vendor webgpu-headers `webgpu.yml` at
`a1dc77409bb2b8bd80540cbf4b8db219e123e909`, SHA-256
`9268864efc29edc2e4fa40949643d14ae5bf6664447eadfccdeaefe7e14d130b`, and BSD-3-Clause license.
The YAML defines C argument order, types and numeric enums. It does not define JavaScript
property access, callback delivery or Waffle surfaces. Do not claim those adaptations are automatic.

`stream.json` selects explicit append-only numbers and named typed lowering rules. The generator
rejects duplicate, missing or reused values. Opcode 0 is padding, `0x0001` through `0x0fff` are
selected WebGPU calls, and `0x1000` through `0x1fff` are Waffle records. Removed values stay retired.
Generate TypeScript tables and the C fixture constants/header. `gpu-stream --check` checks both
outputs and all source hashes, including descriptor adapters and fixture inputs.

Each selected call declares receiver kind, result kind, result-handle allocation, reply/token
layout, omitted callback fields and a named descriptor adapter where needed. Required special
cases in the triangle subset are:

| Call or descriptor            | Explicit lowering                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection instance           | `open` prebinds the reserved instance handle `(1, 1)`. It names the connection's GPU root; it is not a browser `GPUInstance` object.                                                                              |
| `instance.request_adapter`    | Guest chooses the adapter result handle before the callback result exists. Record carries it, a token, the root receiver and options.                                                                             |
| `adapter.request_device`      | Same rule for the device result handle. Callback-info and device-event function pointers never cross the wire. Service handlers publish device loss and uncaptured errors.                                        |
| `device.get_queue`            | Binds a guest-chosen queue handle to the device's `queue` property.                                                                                                                                               |
| WGSL chained source           | Allowlisted WGSL chain becomes the shader descriptor's JavaScript `code` member.                                                                                                                                  |
| Pipeline layout               | A null C layout maps to the browser's `auto`; a nonnull handle resolves to a pipeline layout.                                                                                                                     |
| `instance.create_surface`     | A `SurfaceSourceWaffle` chain carries a granted surface id, checked against the connection's holder.                                                                                                              |
| `surface.get_current_texture` | Guest supplies the texture-result handle explicitly. A surface-result token/completion returns status and the bound handle, so a C client can fill its `surface_texture` output struct without inventing success. |
| `surface.configure`           | Uses the frame policy below, adds copy-source to the ordinary frame texture, and performs native descriptor validation without exposing service-only errors to guest scopes.                                      |

Declare any further scalar or struct return in lowering metadata, rather than treating it as
void. `surface.present` reports its bounded outcome. A future C client supplies handle allocation,
callback pumping and cached getters; no C library is required in this repository.

Before writing replay, G0.1 checks in the generated triangle layouts and independently written
expected-byte vectors for the root instance, callback-return handles, the surface output handle,
omitted event callbacks, WGSL chain and automatic pipeline layout. Encoder/decoder round trips
alone are insufficient because both ends can share a mistake. The C fixture consumes these same
layouts and constants, not a page-authored substitute.

## Wire records and chunks

All integers are little-endian. A command starts with `u16 opcode, u16 flags, u32 length`, has a
minimum length of 8, and is padded to 8. Ordinary source records have flags 0. Result handles
are `(u32 id, u32 generation)` before the optional token and receiver. A token occupies 8 bytes
including padding. Follow YAML member order, explicitly align 64-bit fields to 8, and validate
u64-to-JavaScript-number conversions for loss of precision.

Booleans are u32 0 or 1. Optional structs have a presence word. Strings are UTF-8 with a u32
length, `0xffffffff` for an allowed null, and four-byte padding. Arrays have a count and the
alignment of their elements. Data spans replace their paired C size argument. Allowlisted chained
structs have a count and explicit sType/layouts. C sentinels become omitted browser dictionary
members only where the descriptor adapter declares that mapping.

Waffle records are `release` at `0x1000`, `encode` at `0x1001`, `render-bundle` at `0x1002`,
`buffer-unmap-writes` at `0x1003`, and the private transport envelope `chunk` at `0x1004`.
Nested encode/pass/bundle records omit their receiver. Their parser is resumable, enforces valid
pass nesting and keeps encoders across service turns.

`append` validates the entire guest span's record framing before publication. The import, not
the client, chunks a record larger than half the command ring. Each chunk has the ordinary header,
then `u32 logical_length, u32 offset, u32 payload_length, u32 reserved`, then bytes and padding.
Reserved is zero. The first offset is zero; later offsets equal bytes already received. Flags are
1 for more chunks or 2 for the final chunk. Every chunk repeats the same total length. The payload
contains the original record, including its flags-0 header; its length must match the envelope.
Reject zero progress, overlaps, gaps, interleaving, nested envelopes, excess flags, excessive total
length and an early or missing final marker. Closing mid-record cancels and frees partial state.

Keep the append writer lock across all of its chunks. Publish and consume each complete chunk
incrementally, including tail progress, so records larger than the ring cannot deadlock. Budget
chunk copying as well as nested replay. G0.1 implements and tests transport chunking; G0.2 cannot
promise it while deferring it to G1. Reassembly uses the bounded service credit above, or a bounded
carry parser for large nested blobs. Revocation never waits for the guest's writer lock.

Rings have a 64-byte atomic header with head, tail, writer lock, state and wake words. Counter
distance uses checked wrapping u32 arithmetic, capacities below 2^31 and a hard distance bound.
Records never wrap. Padding uses only the common eight-byte prefix with opcode/kind 0 and its
remaining length. An eight-byte completion remainder is padding, not a truncated 16-byte reply.

## Completions and progress under pressure

A completion has a 16-byte header: kind, flags, whole length, token and signed status. Generated
bodies cover adapter/device results, surface-texture status, map payloads, error scopes,
compilation info, work done, uncaptured errors, device loss, call exceptions, frame credit,
present failure, surface loss and terminal closure. Payload results are fixed-arena slot handles
with an explicit length and generation, copied at most once.

G2 retains native read and write mappings until ordered guest unmap. It uses real `mapAsync` for both modes and preserves `mappedAtCreation` on the original native buffer. Guest shadows never replace native buffer identity or usage. Private record `0x1003` validates every write range before copying any bytes, copies into the active native mapping, and calls native `unmap` only after those copies. Untouched bytes retain their initial mapped values. Plain unmap cancels a pending map through native `unmap`. Explicit device destruction and last device release invalidate their buffers' mapping epochs and views in the ordered destruction step. Epoch checks discard late results without touching a newer mapping. Native validation scopes, not a synthetic error path, report invalid usage and mapped submission.

The shared service never blocks waiting for a guest to drain replies. Publishing a result that
cannot fit, allocating a payload with no free credit, or exceeding the 64-pending-operation cap
terminates only that connection with a resource reason. Previously committed replies remain
readable; all unfinished or invalidated results are cancelled explicitly by the terminal reason.
No successful callback is silently dropped behind a still-live connection.

Tokens are nonzero, strictly increasing u32 values for the connection's lifetime. Duplicate,
out-of-order or exhausted tokens are rejected; they are not backed by an ever-growing used-token
set. Pending native operations have bounded owner entries and release them on every settlement.
Payloads larger than the fixed arena or blocked by unread slots cause the documented local
resource closure. Clients can request smaller maps. There is no unbounded stash or retry queue.

Terminal state is written to the control block before notifying all waits. A `closed` record is
published if it fits and is always last; if it cannot fit, the control reason still reaches the
guest. Late callbacks cannot publish after terminal state. Retiring the owner drops all payload
slots and pending queue references while preserving the ledger's backing-lifetime accounting.

## Frames that survive guest pauses and device destruction

The visible granted canvas gets a `bitmaprenderer` context in the service, never a WebGPU
context. Hold that OffscreenCanvas and its context strongly until surface disposal. The current
probe found Firefox can blank a placeholder after the service drops its reference, so this is a
correctness requirement.

Each configured surface has a service-private standalone OffscreenCanvas with a WebGPU context
on its connection's device. An acquire creates an ordinary GPUTexture with the configured size,
format, usage plus `COPY_SRC`, one sample and one mip. That stable texture survives any number of
appends, guest pauses and service turns. Repeated acquire aliases the same open frame texture.
Releasing every frame handle discards it without changing the visible bitmap.

Present is one synchronous bounded sequence, with no await:

1. Acquire the private presentation canvas's current texture.
2. Copy the ordinary frame texture into it and submit.
3. Destroy the frame texture after submission.
4. Move the presentation canvas image with `transferToImageBitmap`.
5. Move that bitmap into the visible `bitmaprenderer` with `transferFromImageBitmap`.

Native canvas textures never escape that task. Balance service-only error scopes inside the
present step so errors from the copy and image transfer become `present-failed`, not guest scope
errors. Keep genuine invalid WebGPU objects returned from guest creation calls; their later use
must reach the guest's real validation scopes. A JavaScript-exception placeholder is a different
state and still binds any dependent result handle.

One presentation credit per surface per page rAF tick replaces the earlier two-slot scheme.
Acquiring with no credit stalls only that connection. A present consumes credit; a page tick
restores it and emits at most one bounded frame-credit completion. Credit is not texture identity.
No queued backlog of undisplayed frames is kept.

On exit or kill, mark terminal before dropping presenters, destroying open frames and devices,
and releasing the grant. Keep the visible canvas and its bitmap, independent of the killed device.
The next holder's configure leaves that bitmap alone until its first present, unless size changes.
Surface disposal explicitly clears it. Runtime disposal or service failure may lose the image.
Browser-initiated device loss racing a present can also produce a blank image; no browser contract
closes that race. Worker rendering updates and hidden-tab throttling remain browser-controlled.

One frame has logical image size B. Account roughly one retained bitmap after exit and up to four
B of owned images/textures around presentation, plus browser-internal overhead. Measure, rather
than promise, physical memory and copy time. G0.3 qualifies standalone WebGPU OffscreenCanvas,
image transfer and bitmaprenderer in each claimed engine. No second presentation path is added.

Primary references: WebGPU draft `4e829b310ba7381034b93b974eb1a6aabfb464f7`, canvas acquisition,
expiry and image-transfer sections; W3C CRD September 15, 2026; WHATWG HTML OffscreenCanvas and
bitmaprenderer image ownership. Opus's November 6 probes validate this shape in Chromium software
WebGPU and bitmap retention without WebGPU in Chromium, Firefox and WebKit.

## Scheduling and private authority

Visit ready connections round-robin. A slice yields after 4 ms or 1 MiB, after present, on empty
input or while awaiting native work/credit. Check budgets within nested command blobs, not only
between top-level records. Retain the cursor, encoder and any open pass across slices. One
native API call is indivisible; latency thresholds are measured targets, not a promise that the
browser or OS cannot pause a task.

Use `Atomics.waitAsync` to wake the service and MessageChannel tasks to yield. No service wait
may depend on guest execution while blocking the service thread. A flood connection, partial
chunk, full reply ring or unresolved promise cannot stop another connection from presenting.

Add the guest imports and ring module to the authority inventory, including named transport and
port-owning types. Capture Atomics, constructors and native port operations before guest code.
No iteration through guest-mutable builtins over private state. Service modules never execute in
the guest realm. Test actual guest calls with transparent poisoned-builtin canaries, not only AST
classification. Parse and validate protocol bytes at the boundary; keep typed replay helpers flat.

## Loading, CI and delivery slices

Build-graph tests use bundler metadata. Check static and dynamic reachability separately. There
must be no eager path from runtime, core, filesystem or process entry points into display/GPU.
Guest entries must never reach the page owner or service through either kind of edge. A Worker
URL is a separate build entry, not proof of an ordinary split import. Preserve network graph gates.

Browser resource and Worker observation covers filesystem-only, process-only, display-only,
first open, second process open and disposal. A display-only page creates no Worker and loads no
process implementation. First open creates exactly one GPU service; later opens reuse it.

Core gzip budget stays unchanged. Add `size:gpu` for display, guest and service bundles, setting
budgets 10 to 15 percent above measured values. Run it in the blocking package CI job, not just
locally. Build the C fixture once with the existing pinned wasi-sdk path and pass its artifact to
browser jobs. A fixture cache miss must participate in SDK restore/install conditions. Cache and
freshness inputs include the YAML, selection metadata, generator and generated C layouts.

| Slice | Deliverable and required gate                                                                                                                                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0.1  | Pinned schema/license; triangle subset and named adapters; independently expected byte vectors before replay; generated TS/C layouts and freshness gate; ring/chunk/control protocol; resumable replay against a recording target; bounded replies and explicit terminal states. Unit tests below and normal quality, tests and size gates. No public runtime GPU entry yet. |
| G0.2  | Minimal display/grants, accounted allocation, broker cleanup and bootstrap, real responsive service, stable-frame presentation, compiled C triangle, browser runner, authority/loading and CI gates. Foundational admission, pending-open and revocation behavior cannot be postponed.                                                                                       |
| G0.3  | Mac and iPhone capabilities and measurements from the approved G0 list. Runs alongside G1. Topology failure is an owner decision before G3.                                                                                                                                                                                                                                  |
| G1    | Complete selected creation/queue/encoder/pass/bundle/query coverage, textured depth-tested scene and coverage classification of every YAML method. Large-blob fairness and multi-connection frame gates.                                                                                                                                                                     |
| G2    | Readback, mapping/shadow writes, error scopes, compilation info, work completion and device loss, including pressure and late-settlement cases.                                                                                                                                                                                                                              |
| G3    | Full kill matrix, admission stress, surface disposal, runtime disposal and service failure under load. Another connection presents within the measured budget.                                                                                                                                                                                                               |
| G4    | Horizon-sized streams, upload/copy/throughput and ring sizing. Decide on direct guest-memory reads only after measurement.                                                                                                                                                                                                                                                   |
| G5    | Public ABI, architecture, status and troubleshooting docs, qualified browser support and release. Depends on G3 and G0.3.                                                                                                                                                                                                                                                    |

The triangle subset includes request-adapter/device, surface creation/configure/acquire/present,
queue lookup/submit, shader and pipeline creation, texture view, device destroy, encoder/pass
begin/set-pipeline/draw/end/finish, release and recorded encode. Include the error-scope calls
needed by the split-frame and invalid-use gates, rather than scheduling those gates without their
protocol support.

## Executable acceptance

G0.1 unit tests must cover:

- Independent byte vectors for all named special cases, enum maps and checked numeric conversion.
- Ring wrap, eight-byte completion padding, near-u32 rollover, writer ordering and unpublished
  partial records. An oversized logical record progresses through a smaller ring.
- Malformed chunks, excessive lengths, wrong offsets, missing final chunk at close and kill
  during reassembly. Bounded memory and deterministic connection-local outcomes.
- Tiny command/reply rings with one blocking append producing more replies than fit. It either
  progresses or closes locally with the explicit resource reason, never deadlocks.
- Full payload credit, pending-token admission and promises settling after terminal state.
- Seeded mutated streams. Valid mutations may succeed; malformed ones cannot escape the decoder
  or affect another connection. Use deterministic seeds and explicit expected outcomes.

G0.2 runs a compiled single-threaded WASI C fixture through real imports. It obtains its granted
surface, opens, requests adapter/device, creates the frame and pipeline, encodes/submits/presents,
waits for credit, prints a frame marker, then waits on stdin before close. The page samples pixels
and diagnostics. Chromium with the proven SwiftShader flag set is blocking and fails if the
software adapter is missing. Firefox gates no-adapter; WebKit gates missing WebGPU.

Foundational gates include:

- Acquire in one append, several real service turns and another connection's presents, then
  encode and submit in later appends. Correct pixels and no guest validation errors.
- Repeated acquire aliases one frame; discard preserves the old bitmap. Using an expired frame
  handle reports through the guest's error scope without closing the connection.
- Exit and kills while opening, waiting for completion and mid-frame. Sample retained pixels
  after 0.5, 3 and 10 seconds with garbage pressure, then reuse the same canvas with a new holder.
- Bitmap-only retention in all three CI engines at 0.5, 3, 8 and 14 seconds, with strong owner
  references and garbage pressure. No WebGPU capability is needed for this check.
- Held adapter/device promises released after revoke; no resurrection or late resources. Worker
  constructor/post failure, failed setup before open, rapid regrant and complete open settlement.
- No grant, surface-only grant, forged surface id, malformed stream and transparent builtin
  canaries around real open/append/completion/payload/close calls.
- Bounded-profile refusal before allocation, failed opens, close/reopen, late aliases and actual
  reservation snapshots after physical cleanup. Match the ledger's conservative debt semantics.
- A negative control suppresses the final bitmap transfer and must fail the pixel gate.

G1 adds seeded split/interleaved frames across three connections and a single 200,000-draw blob
larger than the command ring. The blob spans many slices while another connection presents.
Start with measured targets of 8 ms per replay slice and a 100 ms presentation gap; account for
indivisible browser calls and revise thresholds from G0.3 evidence, not by weakening pixel or
isolation assertions.

Run `bun run quality`, `bun run test`, `bun run test:ci`, `bun run size` and the new GPU size gate
for each feature slice. Use the host heavy runner. CI must discover the same regression files.
Reconcile broker, bootstrap, reservation and workflow edits with PR 272's final merged contracts
before touching those shared paths. Do not import GPU implementation into `thread/`.

## Attribution and remaining decisions

Add classified overview rows and sections in `docs/bun-patches.md` for the vendored YAML/license,
mechanically derived tables and C layout header. Attribute any copied WebGPU IDL enum lists to a
pinned `gpuweb/gpuweb` revision and its W3C license. Other transport, display and replay code is
an original adapter unless source was actually adapted. Any adapted descriptor mapping records
its exact upstream path, revision and license in the same PR.

The future guest-crates repository name blocks only the wgpu backend. A failed one-worker
measurement may require an owner topology decision. Neither blocks the TypeScript G0 work.

## G0.1 schema subunit checkpoint, November 6, 2026

The schema implementation carries this corrected design into its implementation PR. It vendors
the pinned YAML and license, selects the triangle and error-scope calls with explicit opcodes,
and generates TypeScript/C wire layouts with a quality freshness check. Named metadata covers
the root instance, callback results and event omission, surface output/status, queue property,
WGSL chain, automatic layout and dictionary/enum mappings. Independent byte vectors precede replay.

This is only the schema subunit. It does not implement or qualify rings, chunk transport,
replay, service ownership, guest imports, display/grants, presentation, or public activation.
Reserved render-bundle and unmap-write opcodes are not accepted bodies yet. Their implementation
remains G1/G2 work. The parallel ring lane owns transport code. The coordinator assigns independent
review and owns integration of the remaining G0.1 work. No slice is marked complete by this checkpoint.

## G0.3 hardware checkpoint, November 6, 2026

Desktop Safari 26.4 on the Apple M1 now passes the measured subset: worker GPU access,
shared-buffer upload and readback, atomic wake, 1080p and 4K bitmap transfers, and two extra-device
controls. The actual compiled triangle renders and keeps its last frame after SIGKILL at
0.5, 3 and 10 seconds. Post-stop guest connections, devices, heap, frame textures and presentation
canvases are zero, with one retained bitmap. Corrupted upload and suppressed transfer controls fail.

The unlocked-console retry succeeded. Remote automation was already enabled; the earlier
preference-domain check was wrong. No settings changed. Task-owned SafariDriver, session,
listener, packet, scratch and lock cleanup passed. Results are in
`/work/reports/wave-20261106/waffle-features/gpu/safari-desktop-g03-RESULT.md`.

This subset does not qualify compositor latency, physical GPU memory, high-draw caps comparisons
or physical iPhone behaviour. The iOS 26.5 Simulator passed worker isolation, shared atomic wait,
OffscreenCanvas and bitmaprenderer controls, but its worker adapter request returned null.
Full G0.3 remains open. G1 proceeds without changing the approved architecture.

## G3 blocked-import checkpoint, November 7, 2026

Status: Approved. This first G3 unit implements the blocked append and blocked completion
SIGKILL proofs from [ownership and revocation](#ownership-revocation-and-asynchronous-work),
[pressure and completions](#completions-and-progress-under-pressure),
[scheduling](#scheduling-and-private-authority), and
[executable acceptance](#executable-acceptance). The broader
[GPU acceptance requirements](gpu-bridge.md#acceptance) remain in force.

### Prerequisite disposition

Managing accepted the measured, explained indivisible-call exception allowed by the scheduling
acceptance section. Retain the approved single-worker topology and the unchanged 8 ms service
slice and 100 ms peer-presentation targets. This resolves the G3 execution prerequisite, not full
G0.3 or G4 qualification. No scheduling cap, workload default, threshold, or production topology
changes in this unit.

The actual desktop Safari evidence is
`/work/reports/wave-20261106/waffle-features/gpu/safari-desktop-repaired/RESULT.md`,
with unrounded observations in its `report.json`. Both capped 20,000-draw arms met both targets,
with maximum slices of 5.24 and 5.46 ms and peer gaps of 37.58 and 28.60 ms. Both capped
50,000-draw arms remain **not-met** for the 8 ms target. Their maximum visits were 14.18 and
12.60 ms, containing indivisible final `transferToImageBitmap` calls of 13.98 and 12.46 ms,
with zero draws in those visits. Their peer gaps were 46.20 and 29.66 ms. All capped peer gaps
were below 100 ms.

All four uncapped arms remain **not-met**. Their draw-bearing visits were 44.46, 96.92, 44.98,
and 98.86 ms. Their peer gaps were 55.86, 117.36, 258.50, and 121.78 ms. Three uncapped gaps
missed 100 ms. All eight arms passed functional controls. This disposition neither changes those
classifications nor attributes the synchronous call's internal cost to a particular browser,
GPU, or compositor mechanism.

### Implemented proof and limits

The existing blocking compiled browser runner now executes both ownership cases. Its existing
producer is reused, without C, header, generator, opcode, async-fixture, or native-aggregate
changes. Each case first rejects missing observer coverage and then runs a real compiled
positive control in the same process/service realms.

The append victim uses the unchanged 200,000-draw `--fairness-heavy` blob. After one native
transport chunk enters partial assembly, a test-only victim reader gate holds consumption. The
proof requires an entered import, its inner ring wait, no return, the active writer, and less
space than its next observed chunk needs. The ring need not have every byte occupied because
alignment and chunk framing can leave unusable tail space. The completion victim enters its
actual import and inner empty-reply wait while a real native device result is held before its
continuation. Neither intervention blocks the shared service thread or the peer.

One already-live `--fairness-peer` connection and native device presents new green frames before
arming, while blocked, after SIGKILL and retirement, and after late release. Snapshots carry
fresh request identities and one service-realm identity. Acceptance checks native identity,
pixels, grant acknowledgement, physical worker stop, partial/replay/device/presenter retirement,
late-result destruction, immutable retired ring counters, and conservative shared-control debt.
Only scalar observations leave the trusted service realm.

Each guest keeps poisoned-intrinsic canaries. The victim emits its own authority checkpoint at
import entry and reinstalls poison before invoking the original import. That checkpoint covers
prior completed imports. Physical SIGKILL may preclude its final authority report, so it is not
reported as a post-return audit of the killed call. The normally exiting control and survivor
retain their complete own-guest reports. Missing victim entry canaries fail acceptance.

Raw software-adapter timings retain the original targets and explicit met or not-met labels.
A functional ownership pass is not hardware latency qualification. Remaining G3 work includes
other combined load/ownership cases, malformed-stream isolation, admission pressure, grant and
regrant ordering, explicit surface/runtime disposal, and whole-service failure. Physical iPhone
and broader hardware G0.3/G4 acceptance remain open.

## G3 malformed-connection checkpoint, November 7, 2026

Status: Approved. The existing compiled runner adds header, chunk-offset and nested-opcode
parser-failure cases. Each uses the unchanged C producer, one already-presenting green peer,
and the shared test-only ownership observer. Selected bytes are changed only in the victim's
private reader destination before the original production parser consumes them. No production,
C, schema, generator, workflow, topology, workload, or latency-bound change is required.

A native positive control establishes observer coverage before selection. Paired snapshots
bracket each screenshot at live, ready, held, retired and late-release checkpoints. Acceptance
requires fresh service-realm and request correlation, all victim authority intervals, stable
peer and victim identities, new native presents and completed queue observations, correct
pixels, protocol reason 2, physical guest stop, victim resource retirement and return to the
peer-only service credit. Shared-control debt remains a separate assertion. An actively
presenting peer may hold its next frame at either snapshot; total frame accounting must match
that observed peer state rather than assume the peer is always between frames.

Header and chunk failures reach the compiled append's exact protocol errno. Nested parsing can
close after that append commits; its compiled control observes the closed completion instead.
Acceptance checks each case's exact C failure stage and status alongside the independently
correlated production parser terminal, not an arbitrary nonzero exit. Late original reader and
replay probes cannot consume ring data, publish new replies, or revive ownership.

These software observations retain the unchanged 8 ms and 100 ms target classifications and
make no hardware qualification claim. The completed exact-build Mac Chromium and Firefox
attempts returned null worker adapters in their default headless contexts, so their compiled
GPU arms were not measured. Safari's measured indivisible-call exception remains unchanged.
Admission pressure, grant/regrant ordering, explicit surface/runtime disposal, whole-service
failure, physical iPhone acceptance and full G0.3/G4 qualification remain open.

## G3 global-admission checkpoint, November 7, 2026

Status: Approved. The existing compiled browser runner adds the shared service's global
admission saturation, refusal and recovery proof. The unchanged C triangle producer supplies
all eight admitted guests, the refused ninth guest and the recovery guest. One original green
peer presents continuously throughout. This tests the existing global connection policy, not
physical GPU or device-count limits. No production defect was established or fixed.

A normal compiled positive control first exercises native observation and retirement in the
same service realm. Seven holder guests then present beside the peer. Correlated snapshots
require all eight original grant, surface, connection and native-device identities. The next
compiled guest must return `-48` from its actual open import, print exactly
`GPU_FAIL stage=open status=-48`, and observe service resource reason 3 in its original control,
command ring, reply ring and payload arena. Its open must leave eight service connections,
unchanged heap credit and no additional scheduler owner or native device request. Its grant
acknowledgement and physical process stop are checked separately.

Each screenshot is bracketed by fresh service snapshots and new native presents and completed
queue work from the same peer. Queue work must start and complete inside the bracket. An
actively presenting peer can hold its next acquired frame, so frame totals follow observed
ownership rather than assume the peer is always between frames. Two holders close normally,
then a new compiled guest opens and presents without replacing the peer or the remaining
holders. Later native turns cannot revive retired owners or change their ring publication,
read counters or native work counts. All guests close and every service connection, device,
presenter, frame and heap credit returns to zero. Routine teardown also checks every owned
worker stopped, no live shared admission remains, and the ledger retains its separate
conservative backing debt. This is teardown coverage, not the later active-disposal case.

Retired owners' submission identities, replay slices, presents and per-method native-call
counts stay fixed independently of queue completion status. A pending submission already
recorded before retirement may settle afterward; it is not a new submission. A settled result
cannot revert or change. Runtime disposal releases only the unused 64 MiB adopted-root control
reservation and its zero-byte guest-memory row. The separate eight-byte grant-state backing
and all eleven consumed 5,505,220-byte guest debts remain accounted for.

Permanent invalid-result controls reject missing positive coverage, wrong cap, refusal stage,
errno or terminal reason, unrelated C failure, changed cohort identities, missing presenters,
stale snapshots, missing new in-bracket work, stale queue work, unretired resources or credits,
late work and incorrect backing debt. The original kill, malformed, async and default fixture
controls remain in place. The complete compiled Chromium path uses the once-built normal
producer artifact after its existing source and byte verification, never a second C build.

Software measurements retain all original 8 ms slice and 100 ms peer-gap classifications and
`hardwareQualified: false`. Early runs included both met and not-met peer gaps; failed validator
attempts and their raw observations remain recorded rather than replaced by later samples.
Same-grant open quotas, payload pressure, surface and regrant behavior, active runtime disposal,
service failure, physical iPhone acceptance and full G0.3/G4 qualification remain later work.

## G3 same-canvas regrant checkpoint, November 7, 2026

Status: Approved. This bounded unit adds immediate revoke and regrant of the same canvas while
an original unrelated native peer continues presenting. The old owner replays the compiled 200,000-draw blob and waits inside its real completions
import while a native error-scope result is held. The page revokes its grant and creates the
replacement grant in the same task, before observing old retirement. The replacement configures
and presents blue pixels on the exact original surface after old service retirement and presenter
release. Releasing the unchanged native scope result must not revive old ownership or mutate
the replacement. Permanent negative controls reject each missing proof independently.

The 8 ms service-slice and 100 ms peer-gap targets stay unchanged. All raw timing samples,
including misses, remain evidence. This is not hardware qualification or memory-reclamation
proof. The async runner and its page-owned adapter extraction are separate work.

## G3 active runtime disposal checkpoint, November 7, 2026

Status: Approved. The compiled Chromium gate now includes active runtime disposal, separate
from routine fixture cleanup. The original selected guest holds its actual native error-scope
result after the unchanged oversized draw blob completes. It still owns its device, presenter
and frame and waits inside the real completions import. The original green peer presents real
pixels between fresh native queue and presentation observations before global disposal.

The page calls `runtime.dispose()` without stopping either live guest first. Acceptance requires
synchronous launch and ring revocation, terminal guest outcomes, all original grant retirements
and actual worker termination calls. A fatal signal can unwind or physically stop the held
import before it returns an errno. Its original enter/wait history must remain intact. Any
observed return must be `-64`, and any observed throw must identify an actual runtime termination
unwind. An unrelated throw, wrong return, missing revocation or incomplete physical stop fails.
The proof does not require a killed guest to execute another instruction. A bounded test-only shared audit records
real service snapshots during disposal, before worker termination can discard diagnostic messages.
Its positive control runs in that same service before the held workload. The original held native
result then releases after owner retirement without new replay, native calls, submissions or
publications. Cumulative histories, including completed blobs, remain immutable.

After disposal, only actual retained shared controls, conservative ledger debt, grant retirement
promises and worker-stop observations are available. No post-termination native snapshot or
physical-memory reclamation is claimed. The process facade itself rejects observations once
disposed. Every connection, including the green peer, stops at the global boundary. There is no
second runtime, replacement peer, recreation or continuous presentation across shutdown.

The existing single-worker topology, 8 ms slice and 100 ms peer targets are unchanged.
`hardwareQualified` remains false and all historical not-met samples remain. This bounded proof
does not complete broader G3 or qualify hardware. Production, async command and adapter fixtures,
C producer, workload, deadlines, versions, workflow and budgets are unchanged.

## G3 whole-service failure checkpoint, November 8, 2026

Status: Approved. The ordinary compiled browser gate now exercises an uncaught exception inside
the actual shared GPU Worker during active load. The original unchanged heavy guest completes
its 200,000-draw blob and holds its real native error-scope result and completion. The original
green peer presents correct pixels with new native queue work in both pre-fault screenshot
brackets. A further original compiled guest waits in its actual open import while the service
observer holds its posted open before admission.

The browser delivers a trusted Worker error to the normal page owner. That owner terminates the
failed Worker, revokes every old grant and publishes service-failure reason 5 to the original
active connections and opening waiter. Original compiled calls return their correlated terminal
error and the guests stop. Every old connection, including the green peer, stops at this global
boundary. No continuous original-peer progress across failure is claimed.

The same still-live runtime then opens normally with a fresh eligible canvas and grant. A new
service realm starts only after the old Worker terminates. Its new owner and device identity,
scoped to that realm, produce actual green pixels, native submissions and presentation. The
recovery guest is not the original peer. Reusing a canvas lost with the dead Worker is not part
of this contract.

After termination, acceptance uses retained shared controls, grant promises, correlated compiled
outcomes and physical Worker stop calls. It does not invent a native zero-resource snapshot or
claim physical GPU-byte or memory reclamation. The pre-fault shared audit remains unchanged
rather than claiming that a dead realm ran its canceled callback. The retained audit is read
again at recovery and after the recovery guest exits, and both observations must match the
pre-fault bytes. Original worker identities and stop-history prefixes remain intact, including
legitimate assignment of a prewarmed guest worker. Recovery retirement is a fresh ordered
snapshot in the new realm, with the same native identity and cumulative work history. Old
publication counters stay terminal and fixed through a late release attempt and fresh-service recovery. Actual post-fault
pixels are recorded without promising retention. Conservative shared-control debt stays counted.

The existing disposal setup and strict scalar helpers are shared without weakening its original
controls or discovery. Permanent controls reject fabricated faults, stale or rewritten histories,
changed identities, late pending or rejected submissions, live old waiters, revived publications,
concurrent services and incorrect recovery output. A legitimate settlement of work already
pending before retirement remains accepted.

The single-worker topology, 8 ms service slice and 100 ms live-peer gap targets remain unchanged.
`hardwareQualified` remains false. All historical not-met evidence and the G0.3, G4 and physical
iPhone limits remain. This bounded case is not full G3 or hardware qualification. Production,
protected async command and adapter fixtures, C inputs, workloads, deadlines, versions, workflow
and budgets are unchanged.

## G3 same-grant quota checkpoint, November 8, 2026

Status: Approved. The normal C fixture's opt-in `--grant-quota` mode keeps one process,
canvas and grant across twelve successful open, render and normal-close cycles. Its
thirteenth and fourteenth opens return `-48` with an unchanged output sentinel. Each
refused open consumes only its initial 64-byte control backing. No refused attempt
reaches service admission or requests a native device. The service has at most two
live connections, so its eight-connection cap cannot supply this result.

The import observer reads the existing shared-control counter and allocation receipt
lengths. Close does not refund them. The full 67,108,864-byte reservation stays live
through both refusals. Physical guest stop replaces it with 66,062,724 bytes of
conservative consumed-backing debt and releases only the 1,046,140 unused bytes.
This is accounting, not proof of physical memory reclamation.

Seven screenshot brackets cover the first open, first close, reopen, last close,
refusal, repeated refusal and physical stop. Each requires fresh native presents and
newly started and completed queue work from the original green C peer inside actual
service times. Its pid, guest token, service realm, grant, owner, device and presenter
remain correlated. Earliest retired-owner observations, immutable completed history,
legitimate pending settlement, authority canaries and worker-stop audits remain checked.
The default compiled runner discovers this case alongside all earlier cases.

Development evidence retains a failed coverage placement, an over-instrumented run
that reached the unchanged peer frame bound, and the first completed observation's
101.86 ms peer gap against the unchanged 100 ms target. Its maximum service slice was
0.99 ms against 8 ms. Later scalar validation reuses this capture rather than adding
fields to it. Final canonical gate results are recorded in the coordinator report.
Production code, existing fixture modes, workflows and budgets are unchanged. This is
one single-worker functional proof, not complete G3 or hardware qualification;
`hardwareQualified` remains false.
