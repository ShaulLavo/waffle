import { expect, test } from "bun:test";
import { runThreadRust, threadRustMemoryPlan } from "./threads-guest-rust-runner.ts";
import { guestModule } from "./threads-guest-module.ts";

test("stock Rust runner requires an explicit verified artifact and never compiles implicitly", async () => {
  await expect(runThreadRust("/missing-waffle-thread-receipt", "pair")).rejects.toThrow();
});

test("the compiler-free runner keeps the source minimum and selects one bounded ceiling", () => {
  expect(threadRustMemoryPlan(guestModule())).toEqual({
    initialPages: 2,
    maximumPages: 512,
    sourceMaximumPages: 512,
  });
  expect(threadRustMemoryPlan(guestModule(), 128)).toEqual({
    initialPages: 2,
    maximumPages: 128,
    sourceMaximumPages: 512,
  });
  expect(threadRustMemoryPlan(guestModule(), 1024).maximumPages).toBe(512);
  for (const maximum of [0, 1, 1.5, 65537, NaN])
    expect(() => threadRustMemoryPlan(guestModule(), maximum)).toThrow();
});

const directory = process.env.THREAD_FIXTURE_DIR;
for (const mode of ["pair", "repeat", "nested"] as const) {
  test.skipIf(!directory)(
    `unchanged stock Rust ${mode} runs with real growth below the 32 MiB ceiling`,
    async () => {
      if (!directory) throw new Error("explicit stock fixture required");
      const result = await runThreadRust(directory, mode);
      expect(result.fixtureSha256).toBe(
        "410f9f16ee994fd58a9e3e3382fbf0c092d5231518e9d6a21360582ca402fa40",
      );
      expect(result).toMatchObject({
        initialPages: 17,
        maximumPages: 512,
        sourceMaximumPages: 16384,
        ceilingBytes: 33554432,
        initialGuestBytes: 1114112,
        bufferIdentityChanged: true,
        compilerInvoked: false,
        retainedWaits: 0,
      });
      expect(result.currentGuestBytes).toBeGreaterThan(result.initialGuestBytes);
      expect(result.currentGuestBytes).toBeLessThanOrEqual(result.ceilingBytes);
      expect(result.returned).toBe(mode === "repeat" ? 16 : 2);
      expect(result.spawned).toBe(result.returned);
      expect(result.waitRegistrations).toBeGreaterThan(0);
    },
  );
}
