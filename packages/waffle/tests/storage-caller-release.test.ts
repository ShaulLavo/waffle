import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { indexeddbCallerDelivery } from "./fixtures/indexeddb-caller-delivery.js";
import { openFilesystemWorkerBackend } from "../browser/filesystem-worker-backend.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const result = await promise.then(
    () => ({ kind: "pass" as const }),
    (error: unknown) => ({ kind: "fail" as const, error }),
  );
  if (result.kind !== "fail") throw new Error("Expected the original operation to fail");
  return result.error;
}
async function recovery(
  caller: "committed" | "worker",
  primary: unknown,
  failConfirmation: boolean,
): Promise<void> {
  const confirmation = new Error("recovery confirmation");
  const native = indexeddbCallerDelivery({
    recoveryFailure: { value: primary },
    ...(failConfirmation ? { queryFailure: { value: confirmation } } : {}),
  });
  try {
    const opening =
      caller === "committed"
        ? IndexedDBStorage.openCommitted("recovery", { locks: native.locks })
        : openFilesystemWorkerBackend(
            { implementation: "indexeddb", name: "worker-recovery" },
            { onOwnershipLost() {} },
          );
    const result = await rejection(opening);
    if (!failConfirmation) {
      expect(result).toBe(primary);
      return;
    }
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) throw new Error("Missing joined failures");
    expect(result.errors[0]).toBe(primary);
    expect(result.errors[1]).toBe(confirmation);
    expect(result.cause).toBe(primary);
    expect(native.queries).toBe(1);
  } finally {
    native.restore();
  }
}
function recoveryCases(caller: "committed" | "worker"): void {
  for (const primary of [undefined, null, false, 0, "", new Error("recovery")]) {
    test(`${caller} recovery retains primary and confirmation: ${String(primary)}`, () =>
      recovery(caller, primary, true));
    test(`${caller} recovery preserves sole primary: ${String(primary)}`, () =>
      recovery(caller, primary, false));
  }
}
recoveryCases("committed");
recoveryCases("worker");
async function background(mode: "loss" | "versionchange"): Promise<void> {
  const path = fileURLToPath(
    new URL("./fixtures/indexeddb-background-confirmation.ts", import.meta.url),
  );
  const child = Bun.spawn([process.execPath, path, mode], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(5000),
  });
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result: unknown = JSON.parse(stdout);
    expect(result).toEqual({ mode, unhandled: 0, confirmationRetained: true, queries: 1 });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
for (const mode of ["loss", "versionchange"] as const)
  test(`background ${mode} observes and retains confirmation failure`, () => background(mode));
