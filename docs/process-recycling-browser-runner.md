# Run process recycling tests on iOS Safari

Use the same process cases as the desktop browser command. On the Mac, set `IOS_UDID` to the exact Simulator identifier, then run:

```sh
PROCESS_SCRATCH_ROOT="$HOME/tmp" IOS_UDID="$IOS_UDID" \
  bun packages/waffle/tests/process-recycling-browser-runner.ts ios-safari \
  --result /absolute/path/process-result.json
```

The command discovers every label from `processBrowserCases()` and calls the unchanged `runProcessBrowserCase(label)` in a fresh document. Each body retains its real Workers, original assertions, internal waits, and fixture cleanup. One 600-second deadline includes native imports, asset preparation, discovery, and all cases. Navigation retains the original 30-second bound.

Set `PROCESS_TEST_FILTER` to select labels by substring. A filtered result lists every required, selected, and omitted label and exits with code 4 unless a host failure takes precedence. Check the selected outcomes too. Code 4 is not a full-suite pass, even when every selected case passes. No match fails the run.

The result retains the actual returned labels and page error reports. Nonzero results other than precondition failures also produce `<result>.diagnostics.json` with the actual fixture failure stacks and collected reports. Native execution has no Playwright navigation or network transcript. `PROCESS_NAVIGATION_WIRE=1` is unsupported in native mode and stops before creating resources. It does not silently skip the requested capture.

The fixtures use only `MemFS`, direct shared connections, or a filesystem Worker configured with `mode: "memory"`. The command registers no IndexedDB database or OPFS directory, rejects durable allocation reports, and requires an empty finish ledger. It never deletes unrelated browser storage.

## Run local failure controls

Run the controls with the normal browser test dependencies installed:

```sh
PROCESS_SCRATCH_ROOT="$TMPDIR" \
  bun packages/waffle/tests/process-recycling-browser-runner.ts --page-controls chromium
```

These controls run representative original bodies, not another complete campaign. They reject wrong returned labels, missing Worker assets, uncaught Worker errors, and actual page errors. Successful cell-clone and startup-pool controls forbid durable storage opens in both the page and filesystem Worker. Normal `bun run test:browser` runs the controls after the reporter controls. Normal unit tests cover discovery order, fake host failures, the original command clock, storage rejection, and byte parity with every original Bun producer.

The desktop command still defaults to Chromium, Firefox, and WebKit. Its original body, options, and navigation diagnostics are unchanged; only the imports wait until desktop dispatch. Playwright WebKit is not actual iOS Safari evidence.
