import { expect, test } from "bun:test";
import { decodeCall, WireReader } from "../browser/gpu/codec.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { encodeGpuCommand, encodeGpuStruct } from "../tooling/gpu-stream-layout.ts";
import expected from "./fixtures/gpu/compute-expected.json";

for (const vector of expected.vectors) {
  test(`independent compute bytes: ${vector.name}`, () => {
    const literal = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    expect(encodeGpuCommand(gpuStream, vector.command, vector.input)).toEqual(literal);
    expect(decodeCall(literal).layout.name).toBe(vector.command);
  });
}
for (const vector of expected.structs) {
  test(`independent compute descriptor: ${vector.name}`, () => {
    const literal = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    expect(encodeGpuStruct(gpuStream, vector.struct, vector.input)).toEqual(literal);
    const reader = new WireReader(literal);
    expect(reader.type(`struct.${vector.struct}`)).toEqual(vector.input);
    expect(reader.offset).toBe(literal.byteLength);
  });
}
