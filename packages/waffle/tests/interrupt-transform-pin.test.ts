import { expect, test } from "bun:test";
import { INTERRUPT_REWRITER_REVISION } from "../interrupt/rewriter-internal.js";

test("the persistent interrupt revision pins the exact admission implementation", async () => {
  const bytes = await Bun.file(
    new URL("../interrupt/rewriter-internal.ts", import.meta.url),
  ).bytes();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(
    { revision: INTERRUPT_REWRITER_REVISION, hash },
    "Bump INTERRUPT_REWRITER_REVISION and update its pinned hash after any rewriter edit",
  ).toEqual({
    revision: 9,
    hash: "9e29c7d438dd60ecb646fc21bf4f8593655364a1b77b1dc5721984f4e5fd8475",
  });
});
