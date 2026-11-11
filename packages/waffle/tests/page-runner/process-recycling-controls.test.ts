import { expect, test } from "bun:test";
import type { SuiteResult } from "waffle/testing/page-runner";
import { checkProcessControl } from "./process-recycling-controls.js";
import { processRecyclingAdapter } from "./process-recycling-suite.js";

function result(): SuiteResult {
  const required = processRecyclingAdapter.inventory().map((item) => item.id);
  const id = required[0]!;
  const confirmed: SuiteResult["cleanup"]["session"] = {
    status: "confirmed",
    detail: "Owned resources stopped",
  };
  return {
    firstCommandFailure: null,
    suite: "process-control",
    run: "control-run",
    required,
    selected: [id],
    omitted: required.slice(1),
    outcomes: { [id]: { status: "fail", detail: "ORIGINAL_PROCESS_FAILURE" } },
    results: { [id]: "ACTUAL_UNEXPECTED_RESULT" },
    failures: [{ group: id, category: "case", detail: "ACTUAL_HOST_FAILURE" }],
    runComplete: true,
    documents: [],
    transitions: [],
    ledger: [],
    registrationAttempts: [],
    storageRemaining: [],
    cleanup: {
      session: confirmed,
      launcher: confirmed,
      serviceDisposition: "No service created",
      server: confirmed,
      scratch: confirmed,
      fixture: { status: "not-created", detail: "No fixture" },
      callbacks: { status: "not-created", detail: "No callbacks" },
      storage: { status: "not-created", detail: "Memory only" },
    },
    exit: 1,
  };
}

for (const mode of ["memory-only", "startup-memory"] as const) {
  test(`${mode} control retains the actual rejected body and host evidence`, () => {
    const value = result();
    const before = JSON.stringify(value);
    expect(() => checkProcessControl(value, mode)).toThrow(mode);
    expect(() => checkProcessControl(value, mode)).toThrow("ORIGINAL_PROCESS_FAILURE");
    expect(() => checkProcessControl(value, mode)).toThrow("ACTUAL_UNEXPECTED_RESULT");
    expect(() => checkProcessControl(value, mode)).toThrow("ACTUAL_HOST_FAILURE");
    expect(JSON.stringify(value)).toBe(before);
  });

  test(`${mode} control still accepts only the original passed label`, () => {
    const value = result();
    const id = value.selected[0]!;
    value.outcomes = { [id]: { status: "pass", provisional: false } };
    value.results = { [id]: id };
    value.failures = [];
    value.exit = 4;
    expect(() => checkProcessControl(value, mode)).not.toThrow();
    value.results[id] = "INVENTED_RESULT";
    expect(() => checkProcessControl(value, mode)).toThrow();
    value.results[id] = id;
    value.exit = 1;
    expect(() => checkProcessControl(value, mode)).toThrow();
  });
}
