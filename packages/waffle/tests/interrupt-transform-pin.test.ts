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
    revision: 6,
    hash: "8e353ef4407048a624e63a3ca1cb800cdc0ca3ac3385a6e956e8684194ecfb6b",
  });
});
