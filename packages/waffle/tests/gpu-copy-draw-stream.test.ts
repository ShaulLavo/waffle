import { expect, test } from "bun:test";
import { decodeCall } from "../browser/gpu/codec.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { encodeGpuCommand } from "../tooling/gpu-stream-layout.ts";
import { compileSchema, sha256 } from "../tooling/gpu-stream.ts";
import { list, record, text, type WireTables } from "../tooling/gpu-stream-model.ts";
import selection from "../browser/gpu/stream.json";
import expected from "./fixtures/gpu/copy-draw-expected.json";

for (const vector of expected.vectors) {
  test(`independent copy/draw bytes: ${vector.command}`, () => {
    const bytes = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    expect(encodeGpuCommand(gpuStream, vector.command, vector.input)).toEqual(bytes);
    expect(decodeCall(bytes).layout.name).toBe(vector.command);
  });
}

test("copy/draw selection preserves pinned argument order and exactly 20 append-only calls", async () => {
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  const calls = gpuStream.calls.filter((call) => call.opcode >= 69 && call.opcode <= 88);
  expect(calls.map((call) => call.name)).toEqual(expected.vectors.map((vector) => vector.command));
  expect(calls.map((call) => call.opcode)).toEqual(Array.from({ length: 20 }, (_, i) => 69 + i));
  const objects = list(record(yaml).objects).map(record);
  for (const call of calls) {
    const object = objects.find((entry) => entry.name === call.receiver);
    if (!object) throw new Error("Missing pinned receiver");
    const method = list(object.methods)
      .map(record)
      .find((entry) => `${call.receiver}.${entry.name}` === call.name);
    if (!method) throw new Error("Missing pinned method");
    const args = method.args ? list(method.args).map(record) : [];
    const names = args
      .filter((arg) => call.lowering.kind !== "set-immediates" || arg.name !== "size")
      .map((arg) => text(arg.name));
    expect(call.fields.map((field) => field.name)).toEqual(
      call.context === "top" ? ["receiver"].concat(names) : names,
    );
  }
  expect(compileSchema(yaml, selection).calls).toEqual(gpuStream.calls);
});

test("all prior 68 layouts and numeric enums remain byte-for-byte unchanged", () => {
  const digest = (value: unknown) => sha256(JSON.stringify(value));
  expect(digest(gpuStream.calls.filter((call) => call.opcode <= 68))).toBe(
    expected.prior68.callsSha256,
  );
  const tables: WireTables = gpuStream;
  for (const [name, hash] of Object.entries(expected.prior68.structs))
    expect(digest(tables.structs[name])).toBe(hash);
  for (const [name, hash] of Object.entries(expected.prior68.enums))
    expect(digest(tables.enums[name])).toBe(hash);
});

test("render immediates preserve offset, replace only pointer/size, and reject malformed spans", async () => {
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  const call = gpuStream.calls.find((entry) => entry.name === "render_pass_encoder.set_immediates");
  expect(call?.fields).toEqual([
    { name: "offset", type: "uint32", optional: false },
    { name: "data", type: "bytes", optional: false },
  ]);
  const broken = structuredClone(selection);
  const selected = broken.calls.find(
    (entry) => entry.name === "render_pass_encoder.set_immediates",
  );
  if (!selected) throw new Error("Missing immediate call");
  Reflect.set(selected.lowering, "span", { pointer: "data", size: "data_size" });
  expect(() => compileSchema(yaml, broken)).toThrow("lowering");
  const bytes = encodeGpuCommand(gpuStream, "render_pass_encoder.set_immediates", {
    offset: 4,
    data: [1, 2, 3, 4],
  });
  new DataView(bytes.buffer).setUint32(12, 0xffffffff, true);
  expect(() => decodeCall(bytes)).toThrow();
});
