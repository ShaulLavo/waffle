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
    revision: 3,
    hash: "0f2df0490932b1ea2b4c3ec076a9083d57bc91b2d2c060c3bc606270287dabd7",
  });
});
