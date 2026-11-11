# Run the complete network command

The normal command runs every loopback case for all selected engines before any relay phase. Each phase uses the public page host and the same original browser workload.

## Desktop engines

Install the frozen dependencies, prepare the normal network artifact, and install Playwright's browsers as described in [Development](development.md). Then run:

```sh
NETWORK_SCRATCH_ROOT=/work/tmp NETWORK_TEST_PORT=0 \
  bun packages/waffle/tests/network-browser-runner.ts chromium firefox webkit
```

`NETWORK_TEST_PORT` defaults to 43827. Zero requests an ephemeral first-phase port. Every relay phase uses an ephemeral port independently of storage test settings. The scratch root's resolved path must fit in 36 UTF-8 bytes. Without an explicit scratch setting, the command uses the system temporary directory.

The first phase returns eleven ordered results, including the real Preview 1 listener and service-worker HTTP exchange. Relay phases retain the original target bytes, SSLRequest, denied and refused connections, reset and half-close cases, cancellation, and fixture idle and close checks. The `webkit` and `ios-safari` targets select WebSocket-only configuration before fixture startup. They never attempt WebTransport or replay after a timeout. Chromium and Firefox still require the actual selected WebTransport carrier, the complete fragmented open exchange, and the bad-certificate rejection control.

The normal desktop run also installs a benign foreign root service worker and cache. It checks that the root registration, active worker UUID, and cache keys survive each owned phase. This is cooperative same-origin ownership. It does not isolate against hostile same-origin code racing a registration replacement or answering another page's virtual-port messages.

The command prints the summary evidence path. Phase evidence retains raw original returns and cleanup outcomes. One 600,000 ms command deadline covers preparation and both stages. The first stage shares its original phase deadline across engines. Each relay phase keeps its own original deadline, still bounded by the command deadline. SIGINT and SIGTERM cancel the same owned work and await bounded containment. Unjoined callbacks or registration attempts remain failed obligations, not successful cleanup.

## Native entry

On a separately qualified Darwin host, use the exact simulator UDID:

```sh
NETWORK_SCRATCH_ROOT=/absolute/short/scratch IOS_UDID=<exact-simulator-uuid> \
  bun packages/waffle/tests/network-browser-runner.ts ios-safari --result /absolute/network.json
```

The native entry validates its CLI, Darwin, and UDID before preparing inputs. It invokes the public native host and writes `/absolute/network.json.network.json`, `/absolute/network.json.relay.json`, and the command summary. A failed first phase leaves relay unattempted. A missing, failed, omitted, or unconfirmed phase never becomes a complete result.

The owner selected the production WebSocket relay path for Safari on November 10, 2026. The complete native command retains both phases, all eleven first-phase labels, and the full WebSocket relay workload. The result must contain exactly the WebSocket mode and carrier, zero WebTransport constructions, 98,317 helper bytes, and the original Preview 1 echo, denied, and reset results. Fixture verification and full command teardown remain required.

Safari's WebTransport-only selected and bad-certificate branches are deferred by that decision, not passed. The adapter logs this deferral explicitly. The pinned fails-components relay libraries remain at 1.6.11. Their native peer supports draft 02/07, while the saved desktop Safari observation identifies draft 6-9 and a zero session-credit wait. This is an interoperability mismatch, not a proved build-matched platform root cause. A native upgrade is estimated at 4 to 7 agent hours before additional platform qualification. No library upgrade is included, and the upstream draft remains unposted.

Safari does not need the optional native WebTransport peers for this WebSocket profile. Reachable loopback, the prepared network artifact, the normal Worker assets, and the native host's Darwin and simulator prerequisites remain required. This source entry and desktop Playwright profile parity are not native Safari acceptance evidence. The older manual WebSocket-only preparation in [Development](development.md) remains narrower than the complete command.

## Failure controls

The normal browser CI matrix also runs this bounded control batch:

```sh
NETWORK_SCRATCH_ROOT=/work/tmp \
  bun packages/waffle/tests/network-browser-runner.ts --page-controls chromium
```

It checks process-level SIGINT and SIGTERM while a real fixture callback owns a held TCP socket, the scope-only registration negative, slow sentinel initialization under the existing navigation deadline, and primary plus cleanup errors through saved page diagnostics. Existing public-host controls cover registration replacement, lost operations, callback serialization, and unconfirmed cleanup. They are not duplicate complete positive network commands.
