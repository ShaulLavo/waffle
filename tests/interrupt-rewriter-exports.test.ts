import { expect, test } from "bun:test";
import * as rewriter from "waffle/interrupt/rewriter";
import type { InterruptRewriteOptions } from "waffle/interrupt/rewriter";

test("the public rewriter package entry exports only the defensive wrapper", () => {
  expect(rewriter).not.toHaveProperty("rewriteInterruptsOwned");
  expect(Object.keys(rewriter)).toEqual(["rewriteInterrupts"]);
  const options: InterruptRewriteOptions = { interval: 1 };
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  expect(WebAssembly.validate(rewriter.rewriteInterrupts(bytes, options))).toBe(true);
});
