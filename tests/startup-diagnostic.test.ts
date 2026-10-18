import { test } from "bun:test";
import { browserStartupDiagnostic } from "./startup-diagnostic-browser.js";

test("real bootstrap startup failure keeps stderr until its one complete diagnostic drains", () =>
  browserStartupDiagnostic(new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href), 15_000);

for (const mode of ["stalled", "closed", "dispose"] as const) test(`startup diagnostic teardown finishes with a ${mode} reader`, () =>
  browserStartupDiagnostic(new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href, mode), 15_000);

test("executor completion cannot duplicate broker-owned startup diagnostics", () =>
  browserStartupDiagnostic(new URL("./fixtures/startup-diagnostic-worker.ts", import.meta.url).href, "drain", true), 15_000);
