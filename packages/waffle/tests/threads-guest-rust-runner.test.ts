import { expect, test } from "bun:test";
import { runThreadRust } from "./threads-guest-rust-runner.ts";

test("stock Rust runner requires an explicit verified artifact and never compiles implicitly", async () => {
  await expect(runThreadRust("/missing-waffle-thread-receipt", "pair")).rejects.toThrow();
});
