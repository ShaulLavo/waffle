import { expect, test } from "bun:test";
import { decodeCall } from "../browser/gpu/codec.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { encodeGpuCommand } from "../tooling/gpu-stream-layout.ts";
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
