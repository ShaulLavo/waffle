export const Int32Array = globalThis.Int32Array;

/** @compileFixture Parsed by the authority guard, never called. */
export function unlistedGetter(view: Int32Array): ArrayBufferLike {
  return view.buffer;
}
