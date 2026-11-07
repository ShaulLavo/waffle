import { expect, test } from "bun:test";
import { storageLockCases } from "./storage-lock-cases.js";
import { storageLockAdapter, storageLockName } from "./storage-lock-host.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("storage-lock preserves nineteen ordered backend-qualified case identities and scenario arguments", () => {
  const inventory = storageLockAdapter.inventory();
  expect(inventory).toHaveLength(19);
  expect(inventory.map((item) => item.id)).toEqual(
    `opfs: contested open waits and reads flushed data
opfs: early reload after owner close becomes ready
opfs: crashed owner releases lock to waiter
opfs: dispose while waiting removes queued request
opfs: several waiters acquire ownership FIFO
opfs: guest work remains pending until ownership
indexeddb: contested open waits and reads flushed data
indexeddb: early reload after owner close becomes ready
indexeddb: crashed owner releases lock to waiter
indexeddb: dispose while waiting removes queued request
indexeddb: several waiters acquire ownership FIFO
indexeddb: guest work remains pending until ownership
indexeddb: default takeover still fences the old owner
indexeddb: explicit takeover still fences the old owner
opfs: takeover is rejected for OPFS
indexeddb: ownership loss during gated recovery acknowledges disposal
indexeddb: ownership loss during gated recovery fails without disposal
indexeddb: ownership loss after gated recovery retains failed cleanup owner
indexeddb: ownership loss before recovered backend publication rejects startup`.split("\n"),
  );
  expect(inventory.map((item) => item.id)).toEqual(storageLockCases.map((item) => item.id));
  expect(inventory.map((item) => item.label)).toEqual(inventory.map((item) => item.id));
  expect(storageLockCases.map((item) => item.ordinal)).toEqual(
    Array.from({ length: 19 }, (_, index) => index + 1),
  );
  expect(storageLockCases.filter((item) => item.backend === "opfs")).toHaveLength(7);
  expect(storageLockCases.filter((item) => item.backend === "indexeddb")).toHaveLength(12);
  expect(storageLockCases.slice(12).map((item) => item.scenario)).toEqual([
    { kind: "takeover", policy: "default" },
    { kind: "takeover", policy: "takeover" },
    { kind: "opfsTakeoverRejected" },
    { kind: "recovery", timing: "disposing" },
    { kind: "recovery", timing: "recovering" },
    { kind: "recovery", timing: "ready" },
    { kind: "lateRecoveryPublication" },
  ]);
  expect(inventory.filter((item) => item.label.includes("opfs:"))).toHaveLength(7);
  expect(inventory.filter((item) => item.label.includes("early reload"))).toHaveLength(2);
  expect(inventory.filter((item) => item.label.includes("indexeddb: early reload"))).toHaveLength(
    1,
  );
});
test("all peer allocations are the exact authorized case name and backend", () => {
  for (const item of storageLockCases) {
    const name = storageLockName("run", item);
    const entry =
      item.backend === "indexeddb"
        ? { kind: "indexeddb" as const, name }
        : {
            kind: "opfs-directory" as const,
            name: `bun-wasm-${btoa(JSON.stringify(name)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`,
          };
    const allocation = storageLockAdapter.policy.allocation;
    expect(allocation).toBeDefined();
    allocation?.(entry, [item.id], "run");
    expect(() => allocation?.(entry, [item.id], "foreign")).toThrow();
    expect(() => allocation?.({ ...entry, name: entry.name + "=" }, [item.id], "run")).toThrow();
    expect(() => allocation?.(entry, [], "run")).toThrow();
  }
  expect(storageLockAdapter.budgets(1)).toEqual(storageLockAdapter.budgets(19));
  expect(storageLockAdapter.budgets(19).run).toBe(600_000);
  expect(storageLockAdapter.budgets(19).operation).toBe(15_000);
});
test("native command entry precedes desktop parsing and keeps the actual desktop Worker oracle", () => {
  const source = readFileSync(resolve(import.meta.dir, "storage-lock-browser-runner.ts"), "utf8");
  expect(source.indexOf('process.argv[2] === "ios-safari"')).toBeLessThan(
    source.indexOf('option("--source"'),
  );
  expect(source).toContain("const startedAt = performance.now()");
  expect(source).toContain("const workers = owner.workers()");
  expect(source).toContain('worker.evaluate(() => location.pathname === "/recovery-fs-worker.js")');
});
