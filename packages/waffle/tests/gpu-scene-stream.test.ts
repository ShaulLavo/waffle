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

test("upload layouts replace only their pinned C pointer/size pair", async () => {
  const { compileSchema } = await import("../tooling/gpu-stream.ts");
  const selection = (await import("../browser/gpu/stream.json")).default;
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  for (const name of ["queue.write_buffer", "queue.write_texture"]) {
    const call = gpuStream.calls.find((entry) => entry.name === name);
    expect(call?.fields.map((field) => field.name)).not.toContain("size");
    expect(call?.fields.map((field) => field.name)).not.toContain("data_size");
    expect(call?.fields.find((field) => field.name === "data")?.type).toBe("bytes");
  }
  const badSpan = structuredClone(selection);
  const upload = badSpan.calls.find((entry) => entry.name === "queue.write_buffer");
  if (!upload) throw new Error("Missing upload selection");
  Reflect.set(upload.lowering, "span", { pointer: "data", size: "data_size" });
  expect(() => compileSchema(yaml, badSpan)).toThrow("lowering");
  const badDescriptor = structuredClone(selection);
  const create = badDescriptor.calls.find((entry) => entry.name === "device.create_buffer");
  if (!create) throw new Error("Missing creation selection");
  Reflect.set(create.lowering, "descriptor", "texture_descriptor");
  expect(() => compileSchema(yaml, badDescriptor)).toThrow("pinned C argument");
});
