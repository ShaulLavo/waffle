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
    revision: 7,
    hash: "7497d5f60b659449f17089411a47338ec6d70fcbafc441ed8dcfffd63cf1f81d",
  });
});
