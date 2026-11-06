import { expect, test } from "bun:test";
import { decodeCall, WireReader } from "../browser/gpu/codec.ts";
import { encodeGpuCommand } from "../tooling/gpu-stream-layout.ts";
import { compileSchema, sha256 } from "../tooling/gpu-stream.ts";
import selection from "../browser/gpu/stream.json";
import expected from "./fixtures/gpu/bundle-query-expected.json";
import { blob, encoded, h } from "./fixtures/gpu/bundle-query-fixture.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { list, record, type WireTables } from "../tooling/gpu-stream-model.ts";

test("the complete pinned render-bundle inventory has a typed recording context", async () => {
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  const bundle = list(record(yaml).objects)
    .map(record)
    .find((entry) => entry.name === "render_bundle_encoder");
  if (!bundle) throw new Error("Pinned bundle inventory missing");
  const calls = gpuStream.calls.filter((call) => call.receiver === "render_bundle_encoder");
  expect(calls.map((call) => call.name)).toEqual(
    list(bundle.methods).map((method) => `render_bundle_encoder.${record(method).name}`),
  );
  expect(calls.every((call) => call.context === "bundle")).toBe(true);
  expect(gpuStream.records.find((entry) => entry.name === "render-bundle")).toEqual({
    name: "render-bundle",
    opcode: 0x1002,
    enabled: true,
    fields: [
      { name: "encoder", type: "object.render_bundle_encoder", optional: false },
      { name: "commands", type: "bytes", optional: false },
    ],
  });
});

for (const vector of expected.vectors) {
  test(`independent bundle/query bytes: ${vector.name}`, () => {
    const bytes = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    expect(encodeGpuCommand(gpuStream, vector.command, vector.input)).toEqual(bytes);
    expect(decodeCall(bytes).layout.name).toBe(vector.command);
  });
}

test("the bundle envelope uses a receiver and immediate byte span, with a guest-owned finish result", () => {
  const bytes = blob(0x1002, 6, [
    encoded("render_bundle_encoder.finish", { result: h(10), descriptor: null }),
  ]);
  expect(bytes).toEqual(
    Uint8Array.from(Buffer.from(expected.records[0]!.hex.replaceAll(/\s/g, ""), "hex")),
  );
  const reader = new WireReader(bytes, 8);
  expect(reader.type("object.render_bundle_encoder")).toEqual(h(6));
  const commands = reader.type("bytes");
  if (!(commands instanceof Uint8Array)) throw new Error("Missing bundle commands");
  expect(decodeCall(commands).fields.result).toEqual(h(10));
  reader.finish();
});

test("bundle immediates replace precisely the pinned pointer and paired size, not offset", async () => {
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  const immediates = gpuStream.calls.find(
    (call) => call.name === "render_bundle_encoder.set_immediates",
  );
  expect(immediates?.fields).toEqual([
    { name: "offset", type: "uint32", optional: false },
    { name: "data", type: "bytes", optional: false },
  ]);
  const broken = structuredClone(selection);
  const selected = broken.calls.find(
    (call) => call.name === "render_bundle_encoder.set_immediates",
  );
  if (!selected) throw new Error("Bundle immediate selection missing");
  Reflect.set(selected.lowering, "span", { pointer: "data", size: "data_size" });
  expect(() => compileSchema(yaml, broken)).toThrow("lowering");
  const bytes = encoded("render_bundle_encoder.set_immediates", {
    offset: 8,
    data: new Uint8Array(8192).fill(23),
  });
  expect(decodeCall(bytes).fields.data).toEqual(new Uint8Array(8192).fill(23));
  new DataView(bytes.buffer).setUint32(12, 0xffffffff, true);
  expect(() => decodeCall(bytes)).toThrow();
});

test("the compute-parent calls, descriptor layouts, and numeric enums stay unchanged", () => {
  function digest(value: unknown) {
    return sha256(JSON.stringify(value));
  }
  expect(digest(gpuStream.calls.filter((call) => call.opcode <= 45))).toBe(
    expected.prior45.callsSha256,
  );
  const tables: WireTables = gpuStream;
  for (const [name, hash] of Object.entries(expected.prior45.structs))
    expect(digest(tables.structs[name])).toBe(hash);
  for (const [name, hash] of Object.entries(expected.prior45.enums))
    expect(digest(tables.enums[name])).toBe(hash);
});
