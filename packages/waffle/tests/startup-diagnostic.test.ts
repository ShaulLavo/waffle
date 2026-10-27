import { test } from "bun:test";
import { browserStartupDiagnostic } from "./startup-diagnostic-browser.js";

test(
  "real bootstrap startup failure reports once to host after ordered acknowledgement",
  () =>
    browserStartupDiagnostic(
      new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href,
    ),
  15_000,
);

for (const mode of ["stalled", "closed", "dispose"] as const)
  test(
    `suppressed startup diagnostic teardown finishes with a ${mode} reader`,
    () =>
      browserStartupDiagnostic(
        new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href,
        mode,
      ),
    15_000,
  );

test(
  "startup diagnostic capability never delays EOF from a running normal child",
  () =>
    browserStartupDiagnostic(
      new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href,
      "normal",
    ),
  15_000,
);

test(
  "executor completion cannot duplicate broker-owned startup diagnostics",
  () =>
    browserStartupDiagnostic(
      new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href,
      "drain",
      true,
    ),
  15_000,
);
