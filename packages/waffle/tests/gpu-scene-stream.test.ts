import { expect, test } from "bun:test";
import { decodeCall, WireReader } from "../browser/gpu/codec.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { encodeGpuCommand, encodeGpuStruct } from "../tooling/gpu-stream-layout.ts";
import expected from "./fixtures/gpu/scene-expected.json";

for (const vector of expected.vectors) {
  test(`independent G1 bytes: ${vector.name}`, () => {
    const input: Record<string, unknown> = { ...vector.input };
    if (input.size === "WHOLE_SIZE") input.size = 0xffffffffffffffffn;
    const literal = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    const encoded = encodeGpuCommand(gpuStream, vector.command, input);
    expect(encoded).toEqual(literal);
    expect(decodeCall(literal).layout.name).toBe(vector.command);
  });
}

for (const vector of expected.structs) {
  test(`independent G1 descriptor bytes: ${vector.name}`, () => {
    const input: Record<string, unknown> = { ...vector.input };
    if (input.size === "WHOLE_SIZE") input.size = 0xffffffffffffffffn;
    const literal = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    expect(encodeGpuStruct(gpuStream, vector.struct, input)).toEqual(literal);
    const reader = new WireReader(literal);
    const decoded = reader.type(`struct.${vector.struct}`);
    const numeric = JSON.stringify(decoded, (_key, value: unknown) => {
      if (typeof value !== "bigint") return value;
      return value === 0xffffffffffffffffn ? "WHOLE_SIZE" : Number(value);
    });
    expect(JSON.parse(numeric)).toEqual(vector.input);
    expect(reader.offset).toBe(literal.byteLength);
  });
}
