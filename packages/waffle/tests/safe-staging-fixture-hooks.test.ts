import { expect, spyOn, test } from "bun:test";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { checkpointDecodeControl } from "./indexeddb-checkpoint-decode-browser.js";
import { safeStagingNative } from "./safe-staging-browser.js";
import { stagingDatabaseName } from "./page-runner/safe-staging-allocation.js";

const run = "b3912068-3872-4a01-a79b-ed67c9fcd7c5";
for (const fixture of ["staging", "decoder"] as const) {
  test(`${fixture} constructor waits for a successful current allocation ACK`, async () => {
    const opening = spyOn(IndexedDBStorage, fixture === "staging" ? "openCommitted" : "open");
    const acknowledged = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let current = true;
    const name = stagingDatabaseName(
      run,
      async () => {
        entered.resolve();
        await acknowledged.promise;
      },
      () => current,
    );
    const pending =
      fixture === "staging"
        ? safeStagingNative("genesisReopen", name)
        : checkpointDecodeControl.run(name);
    try {
      await Promise.race([entered.promise, pending.catch(() => {})]);
      expect(opening).not.toHaveBeenCalled();
      current = false;
      acknowledged.resolve();
      await expect(pending).rejects.toThrow("acknowledgement is no longer current");
      expect(opening).not.toHaveBeenCalled();
    } finally {
      current = false;
      acknowledged.resolve();
      await pending.catch(() => {});
      opening.mockRestore();
    }
  });
  test(`${fixture} rejects allocation without opening or deleting storage`, async () => {
    const opening = spyOn(IndexedDBStorage, fixture === "staging" ? "openCommitted" : "open");
    const rejected = { exact: "allocation rejected" };
    const name = stagingDatabaseName(
      run,
      () => Promise.reject(rejected),
      () => true,
    );
    try {
      const pending =
        fixture === "staging"
          ? safeStagingNative("genesisReopen", name)
          : checkpointDecodeControl.run(name);
      const outcome: unknown = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(opening).not.toHaveBeenCalled();
      expect(outcome).toBe(rejected);
    } finally {
      opening.mockRestore();
    }
  });
}
