import type { FunctionSignature } from "./metadata.js";

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value);
  return bytes;
}

function signed(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40);
    bytes.push(done ? byte : byte | 0x80);
    if (done) return bytes;
  }
}

function vector(items: readonly number[][]): number[] {
  return unsigned(items.length).concat(items.flat());
}

function section(id: number, items: readonly number[][]): number[] {
  const body = vector(items);
  return [id].concat(unsigned(body.length), body);
}

function name(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return unsigned(bytes.length).concat(bytes);
}

function body(index: number, signature: FunctionSignature): number[] {
  const code = [0].concat(
    signature.params.flatMap((_, local) => [0x20].concat(unsigned(local))),
    [0x23, 0, 0x41],
    signed(index),
    [0x6a, 0x11],
    unsigned(index),
    [0, 0x0b],
  );
  return unsigned(code.length).concat(code);
}

/**
 * Encodes a typed forwarding module. Export `f<i>` has signature `i` and performs
 * `call_indirect` through `env.table[env.base + i]` with that exact type, so a side can
 * import its own definitions before they exist. It owns no memory, stack or start.
 */
export function relayModule(signatures: readonly FunctionSignature[]): Uint8Array<ArrayBuffer> {
  const types = signatures.map((signature) =>
    [0x60].concat(
      unsigned(signature.params.length),
      signature.params,
      unsigned(signature.results.length),
      signature.results,
    ),
  );
  const imports = [
    name("env").concat(name("table"), [1, 0x70, 0, 0]),
    name("env").concat(name("base"), [3, 0x7f, 0]),
  ];
  const functions = signatures.map((_, index) => unsigned(index));
  const exports = signatures.map((_, index) => name(`f${index}`).concat([0], unsigned(index)));
  const bodies = signatures.map((signature, index) => body(index, signature));
  return Uint8Array.from(
    [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(
      section(1, types),
      section(2, imports),
      section(3, functions),
      section(7, exports),
      section(10, bodies),
    ),
  );
}
