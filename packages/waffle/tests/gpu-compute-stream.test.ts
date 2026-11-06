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
    expect<unknown>(reader.type(`struct.${vector.struct}`)).toEqual(vector.input);
    expect(reader.offset).toBe(literal.byteLength);
  });
}

test("the complete pinned compute-pass inventory is selected and immediates replace only data and size", async () => {
  const { compileSchema } = await import("../tooling/gpu-stream.ts");
  const { list, record } = await import("../tooling/gpu-stream-model.ts");
  const selection = (await import("../browser/gpu/stream.json")).default;
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  const source = record(yaml);
  const pass = list(source.objects)
    .map(record)
    .find((object) => object.name === "compute_pass_encoder");
  if (!pass) throw new Error("Pinned compute inventory missing");
  expect(
    gpuStream.calls
      .filter((call) => call.receiver === "compute_pass_encoder")
      .map((call) => call.name),
  ).toEqual(list(pass.methods).map((method) => `compute_pass_encoder.${record(method).name}`));
  const immediates = gpuStream.calls.find(
    (call) => call.name === "compute_pass_encoder.set_immediates",
  );
  expect(immediates?.fields).toEqual([
    { name: "offset", type: "uint32", optional: false },
    { name: "data", type: "bytes", optional: false },
  ]);
  const broken = structuredClone(selection);
  const changed = broken.calls.find((call) => call.name === "compute_pass_encoder.set_immediates");
  if (!changed) throw new Error("Missing immediate lowering");
  Reflect.set(changed.lowering, "span", { pointer: "data", size: "data_size" });
  expect(() => compileSchema(yaml, broken)).toThrow("lowering");
});
