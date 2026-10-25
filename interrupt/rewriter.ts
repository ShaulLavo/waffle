import { rewriteInterruptsOwned, type InterruptRewriteOptions } from "./rewriter-internal.ts";

export type { InterruptRewriteOptions } from "./rewriter-internal.ts";

/** Instrument validated source bytes; compiled modules cannot be made safe here. */
export function rewriteInterrupts(
  input: Uint8Array,
  options: InterruptRewriteOptions = {},
): Uint8Array<ArrayBuffer> {
  // Own the bytes: parser and validators must see the same snapshot, including
  // when the caller supplied a SharedArrayBuffer or a subarray of a larger file.
  return rewriteInterruptsOwned(new Uint8Array(input), options);
}
