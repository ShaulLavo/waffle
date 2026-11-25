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
    revision: 8,
    hash: "862d57cc9e78871bae74f314217a8f15829646a963e9ee405ac69f46f89909ec",
  });
});
