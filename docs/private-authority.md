# Private process authority in a guest Worker

Guest JavaScript and runtime adapters share a Worker realm. After bootstrap, the
guest may replace globals, prototype methods, getters, constructors and iterator
hooks. A function that still behaves like the native implementation can also
observe every receiver and argument it receives.

The architecture rule is therefore about **where authority goes**, not whether a
replacement happens to return the right answer:

> Never pass an authority-bearing runtime value through a guest-mutable builtin.

Private authority includes process directory and identity buffers, incarnation
cells, signal/outcome controls, pipe buffers and lifetimes, descriptor tables,
open descriptions, endpoint callbacks, and collections containing these values.
A `Map<number, Stream>` is private even though its keys are ordinary numbers.
A callback that closes over a private endpoint is authority too.

## Implementation rules

- Capture native constructors, functions and prototype getters in
  `proc/intrinsics/core.ts` and `proc/intrinsics/host.ts`, before executing guest code.
  `proc/intrinsics.ts` reexports the same captures. Core-only consumers import the
  core group without initializing unrelated host capabilities. Call the captured helper,
  rather than looking up the global or receiver method again.
- Invoke captured prototype methods/getters through captured `Reflect.apply` or
  an equivalent captured uncurried helper. `captured.call(...)`, `.apply(...)`
  and `.bind(...)` still look up mutable `Function.prototype` methods.
- Native descriptor conversion still reads inherited fields. Pass null-prototype
  descriptors, constructor options, proxy handlers and array-like records to
  captured natives; capturing the function alone does not protect its arguments.
- Capture process identity generation and relay timers before guest execution.
  Capture the default Worker's postMessage/listener hooks at module load, and
  explicit embedding-host hooks once at bootstrap entry. Preserve their receiver
  through captured `Reflect.apply`, never a later host/global lookup.
- Use captured constructors and Map/Set/WeakMap operations for private
  collections. Use indexed loops over owned arrays, or captured collection
  traversal helpers. Do not use `for-of`, iterable spread or mutable array
  callbacks over private collections.
- Capturing native `subarray` alone is insufficient. Typed-array subviews must
  use captured constructors plus captured buffer, offset and length getters.
  Never consult `.constructor`, `Symbol.species` or a mutable iterator to derive
  a private view. Native species construction can disclose its source buffer.
- Reading an array's own `length` and indexing its owned entries is different
  from invoking a typed-array length getter or collection size getter. The
  former is allowed; the latter must use its captured helper.
- Normal runtime-owned methods, such as `stream.read(...)`, are not rejected
  merely because their receiver carries authority. The rule targets mutable
  builtins and iterator/species paths, not all instance calls.

## Regression guard

`tooling/private-authority.ts` loads the repository's TypeScript AST and follows
runtime imports to build its declaration inventory. The default command checks
the enforced process boundary; `bun tooling/private-authority.ts
--audit-dependencies` additionally prints reachable out-of-scope audit findings
for the owning filesystem/WASI lane. It uses local lexical type
inference: annotations, type aliases, collection arguments, initializers,
constructor aliases, runtime fields and callback captures. It distinguishes
private collection elements from the collection's own API. Imported captured
constructors remain recognized when renamed locally. Only those three exact
module paths are recognized as manually reviewed capture implementations. A
similarly named module receives no capture or implementation trust.

Enforcement is intentionally an explicit process boundary, not a claim that all
filesystem and WASI code is hardened. `enforcedModules` covers the guest-facing
process modules, `browser/worker.ts`, guarded streams, terminal provenance, and
`core/descriptors.ts`. New `proc/*.ts` implementations must be classified as
checked or trusted; they do not silently escape an old file list.

The page-only supervisor, table, registry, broker and lazy facade are named in
`trustedModules`. `WorkerPipeBroker` alone is page-owned; the codec and endpoint
adapters in the same file remain checked. The intrinsic module is a manually
reviewed capture-time trust root; its native-conversion arguments are also checked.
Dedicated filesystem service/backends are not
guest-realm implementations. The guest-memory view helper is payload-only, not
a place to store process buffers.

The guard rejects live Atomics/Object/Reflect/Proxy operations on inferred private
values, mutable native view/collection operations and getters, detached builtin
aliases, Function call/apply/bind exposure, private iteration/species paths,
live identity/timer/host-send globals, and prototyped literal arguments to native
conversion. It accepts captured helpers, indexed traversal, ordinary payload arrays and
runtime-owned methods. The deliberately unsafe examples in
`tests/fixtures/private-authority-cases.ts` are parsed, never executed.

Run the focused guard with:

```sh
bun test ./tests/intrinsics-boundary.test.ts
bun tooling/private-authority.ts
```

`bun test ./tests` and the existing CI `bun test` discover the guard automatically;
there is no optional flag that disables production findings. The test also
requires unsafe examples to be rejected and safe examples to remain accepted.
The checker closes its compiler API process and snapshot in `finally` blocks;
it writes no build outputs or temporary projects.

## Explicit payload boundaries

`payloadExceptions` matches **file, owning function, rule and exact expression**.
It contains no whole-file or wildcard suppression. The allowed cases are:

| Owner                                      | Payload-only operation                                                                          | Why it carries no private authority                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `proc/pipes.ts` `length`                   | Reduce caller-supplied byte iovecs to a count                                                   | Elements are the caller's payload; the callback captures no ring or lifetime state.                                             |
| `Ring.read` / `Ring.write`                 | Iterate `chunks`                                                                                | These are caller-owned destinations/sources. Actual private ring copying uses captured helpers. The loop body is still checked. |
| Worker bootstrap `output`, `write`, `post` | Read `data.buffer` / `data.length`                                                              | Guest stdout/stderr bytes, not directory, signal or endpoint buffers.                                                           |
| Terminal codec `import.write`              | Count/iterate terminal chunks, allocate an outbound byte array, copy payload, read byte lengths | These values are guest iovecs and fresh output bytes. The separate WeakMap of Stream provenance is private and remains checked. |

`ProcessABI.span` and `ProcessABI.view` are additionally named payload-return
boundaries: their views point into the guest's WebAssembly memory, not process
control buffers. Poll output callbacks writing those guest views therefore do
not become private callbacks merely because they use a DataView.

An exception is a provenance statement, not a convenience for a failing test.
Before adding one, establish the caller and backing buffer, show that no private
receiver, element or closure crosses the operation, document the reason here,
and keep the exception as narrow as the expression permits. If an ordinary
payload operation also receives private state, capture its builtin instead.

## Scope and proof limits

The optional `scanAuthorityProject(root, [], true)` audit includes reachable
dependency implementations. It is for extending the boundary deliberately;
filesystem protocol/shared storage, shared open-file offsets, WASI notification
words and diagnostic byte copying are not silently grandfathered into the
process enforcement set. An audit finding needs classification as private
control authority or guest/file payload before deciding its fix.

Local AST inference is not a full information-flow proof. Erased `any`/`unknown`
values, computed dynamic names, unusual destructuring, cross-module aliasing and
custom iterator behavior still require review. It is deliberately not a sandbox
or a substitute for runtime evidence. TypeScript's unstable semantic API is not
used for inference: its tuple serialization currently fails on real process ABI
code. Keep transparent browser observers as the end-to-end proof: poison native
entry points while delegating to the originals, confirm positive canaries, and
require zero private-authority observations during real process lifecycles.
