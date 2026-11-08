# Run the complete network command

The normal command runs every loopback case for all selected engines before any relay phase. Each phase uses the public page host and the same original browser workload.

## Desktop engines

Install the frozen dependencies, prepare the normal network artifact, and install Playwright's browsers as described in [Development](development.md). Then run:

```sh
NETWORK_SCRATCH_ROOT=/work/tmp NETWORK_TEST_PORT=0 \
  bun packages/waffle/tests/network-browser-runner.ts chromium firefox webkit
```

`NETWORK_TEST_PORT` defaults to 43827. Zero requests an ephemeral first-phase port. Every relay phase uses an ephemeral port independently of storage test settings. The scratch root's resolved path must fit in 36 UTF-8 bytes. Without an explicit scratch setting, the command uses the system temporary directory.

The first phase returns eleven ordered results, including the real Preview 1 listener and service-worker HTTP exchange. Relay phases retain the original target bytes, SSLRequest, denied and refused connections, reset and half-close cases, cancellation, and fixture idle and close checks. Only the desktop target named `webkit` runs WebSocket-only. Chromium and Firefox require the actual selected WebTransport carrier.

The normal desktop run also installs a benign foreign root service worker and cache. It checks that the root registration, active worker UUID, and cache keys survive each owned phase. This is cooperative same-origin ownership. It does not isolate against hostile same-origin code racing a registration replacement or answering another page's virtual-port messages.

The command prints the summary evidence path. Phase evidence retains raw original returns and cleanup outcomes. One 600,000 ms command deadline covers preparation and both stages. The first stage shares its original phase deadline across engines. Each relay phase keeps its own original deadline, still bounded by the command deadline. SIGINT and SIGTERM cancel the same owned work and await bounded containment. Unjoined callbacks or registration attempts remain failed obligations, not successful cleanup.

## Native entry

On a separately qualified Darwin host, use the exact simulator UDID:

```sh
NETWORK_SCRATCH_ROOT=/absolute/short/scratch IOS_UDID=<exact-simulator-uuid> \
  bun packages/waffle/tests/network-browser-runner.ts ios-safari --result /absolute/network.json
```

The native entry validates its CLI, Darwin, and UDID before preparing inputs. It invokes the public native host and writes `/absolute/network.json.network.json`, `/absolute/network.json.relay.json`, and the command summary. A failed first phase leaves relay unattempted. A missing, failed, omitted, or unconfirmed phase never becomes a complete result.

Actual iOS Safari must run selected, WebSocket, and bad-certificate modes, with the selected carrier actually WebTransport. Missing WebTransport, native peers, certificate support, or reachable loopback blocks the command. It never silently downgrades. This source entry and desktop Playwright WebKit are not native acceptance evidence. The older manual WebSocket-only Safari preparation in [Development](development.md) remains narrower coverage.

## Failure controls

The normal browser CI matrix also runs this bounded control batch:

```sh
NETWORK_SCRATCH_ROOT=/work/tmp \
  bun packages/waffle/tests/network-browser-runner.ts --page-controls chromium
```

It checks process-level SIGINT and SIGTERM while a real fixture callback owns a held TCP socket, the scope-only registration negative, and primary plus cleanup errors through saved page diagnostics. Existing public-host controls cover registration replacement, lost operations, callback serialization, and unconfirmed cleanup. They are not duplicate complete positive network commands.
