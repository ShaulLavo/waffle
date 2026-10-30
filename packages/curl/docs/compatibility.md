# Fetch command contract

`waffle-curl` implements one HTTP request with explicit caller capabilities. It is
not upstream curl, libcurl, or a browser security bypass. `createCurlPackage` uses
Waffle's published host-command registration. No interpreter, Wasm stub, fallback
launcher, second runtime, or default catalog entry is included.

## Supported arguments

One absolute HTTP or HTTPS URL is required. `--url`, `--`, attached short values,
short flag clusters, and long `--name=value` forms are supported.

- GET is the default. `-I` or `--head` selects HEAD and prints headers. `-i` or
  `--include` prints headers before the response body.
- `-f` or `--fail` returns 22 for HTTP status 400 or greater without emitting the
  response body. No output file is opened unless headers were requested with `-i`
  or `-I`. Otherwise HTTP errors return 0.
- `-s` or `--silent` suppresses transfer diagnostics. `-S` or `--show-error`
  restores them. This implementation has no progress meter.
- `-L` or `--location` uses Fetch redirect handling. Without it, a browser's opaque
  redirect is an explicit failure, not a readable redirect response.
- `-o` or `--output` writes through the caller's guest filesystem. `-` means stdout.
  The output is opened only after response acceptance. Successful files are closed;
  failed files are aborted. The file capability decides whether partial bytes remain.
- `-H` or `--header` accepts repeatable `Name: value` headers. Browser-controlled
  headers fail explicitly. Header removal syntax and `@header-file` are unsupported.
- `-X` or `--request` sets the HTTP method. Fetch-forbidden methods fail explicitly.
- `-d`, `--data`, and `--data-binary` accept literals, `@guest-path`, and `@-` for
  stdin. Repeated parts join with `&`. Data selects POST unless `-X` is set.
  `--data @source` removes CR, LF, and NUL; binary preserves bytes. File and stdin
  uploads use replayable Blobs for Fetch redirects. This buffers uploads, not responses.
  GET and HEAD bodies are rejected because Fetch does not support them.
- `-m` or `--max-time` is a positive number of seconds. It may shorten, never
  extend, the caller's mandatory finite overall deadline. Zero is rejected rather
  than disabling the deadline. `--help` describes the supported subset.

All other options fail before network access. Multiple URLs, globbing, config
files, retries, multipart forms, cookie jars, auth stores, proxies, TLS settings,
client certificates, local host files, and other protocols are unsupported.

## Capabilities and lifecycle

`runCurl(invocation)` takes argv, an AbortSignal, a positive finite `timeoutMs`,
Fetch, stdin, stdout, stderr, and guest file read/write capabilities. Output writes
are awaited for backpressure. The command never closes or aborts borrowed stdout.
It cancels response and input readers and releases locks on every exit.

Each asynchronous capability must settle on cancellation and stop its own I/O
before settling. The package cannot physically stop an uncooperative host callback.
File abort must finish cleanup before settling. The diagnostic callback must also
be bounded by its owner. Cancellation cannot be proved merely by an exit code.

`createCurlCommand()` adds a package-domain stop controller. Both `curlPaths`
aliases use that same object. Its idempotent `dispose()` closes admission at once,
then aborts and awaits active commands. The portable factory alone is not a Waffle registration.
`createCurlPackage` binds it to the runtime-owned process and package lifecycle.

## Install in an existing runtime

```ts
import { createCurlPackage } from "waffle-curl";

const curl = createCurlPackage({ fetch: applicationFetch, timeoutMs: 30_000 });
await runtime.programs.onDemand(curl);
// The shell can now execute /usr/bin/curl or /bin/curl.
await runtime.programs.get("curl")?.remove();
```

The application already owns `runtime`. The package neither creates nor disposes
that runtime, its filesystem, or its Fetch transport. `curl.pick("curl")` preserves
the same program identity. Registration writes runtime markers without network
access. Canonical and alias execution, picks, and explicit preload share one lazy
command loader. A loaded callback uses the captured request's arguments after
argv[0], cwd, abort signal, and actual process stdin/stdout/stderr.

The host-command API does not provide a file-opening capability. Omit `files` to
deny `@path` with exit 26 and `-o path` with exit 23. `@-`, `-o -`, and shell stdio
redirections still work. To grant file access, supply `files.read(request)` and
`files.write(request)`. Each receives `{ path, cwd, signal }`; paths pass through
unchanged. The caller resolves the actual guest tree, symlinks, and rights and
returns the portable input stream or owned `CurlOutput`. This is explicit trusted
page authority, not a claim of implicit per-process filesystem isolation. No Node
filesystem bridge is supplied. File callbacks must finish cancellation cleanup,
even if the runtime has already revoked its public filesystem projection. The
caller chooses partial-file retention. The test grant retains committed bytes.

Runtime stdio applies backpressure. A curl deadline cancels its input-stream
wrapper or stops waiting on output. Waffle still tracks the original read/write,
revokes it when the callback exits, and holds physical cleanup debt until it has
settled. This does not close the parent's borrowed descriptors. Diagnostics have
a separate ceiling of `timeoutMs`; an aborted diagnostic is dropped instead of
extending physical cleanup indefinitely. Stdout failures use the library's exit
23, not native curl's exact stderr or SIGPIPE behavior.

Removal closes both paths synchronously and waits for preparation and running
commands without killing them. The package's disposal hook runs after those
consumers physically stop. Use the runtime's normal signaling or disposal to
interrupt active commands. Runtime disposal aborts transfers and waits for the
callback and owned file cleanup. Direct portable-command disposal still aborts
and joins its active library invocations. Neither API can preempt uncooperative
JavaScript or make an uncooperative Fetch/file callback physically stop.

## Fetch differences

Fetch enforces CORS, forbidden headers, method restrictions, redirect rules, and
browser-managed TLS. `credentials: "omit"` avoids ambient browser cookies. Explicit
allowed headers are forwarded, with Fetch's cross-origin redirect stripping rules.
A caller-supplied transport must preserve those security rules. It may provide an
approved relay, but this package does not discover or configure one.

The browser may hide response headers, merge duplicate headers, decompress bodies,
and omit status text. Included headers use a synthetic `HTTP <status> <text>` line,
not a claimed HTTP wire version. Only the final redirected response is visible.
Fetch's redirect limit is not native curl's limit. Generic Fetch failures return 7
and mention possible policy or network causes; they do not assert that CORS caused
an indistinguishable error. No DNS or TLS exit-code precision is invented.

Exits are 0 for success, 1 for unsupported protocol, 2 for invalid arguments,
3 for invalid URL, 7 for Fetch failure or unreadable response, 18 for a partial body
failure, 22 for `--fail`, 23 for output errors, 26 for input errors, 28 for deadline,
and 42 for caller or command cancellation. These are a deliberate curl-like subset.
