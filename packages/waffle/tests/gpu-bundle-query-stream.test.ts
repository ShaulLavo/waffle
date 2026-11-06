import { expect, test } from "bun:test";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { list, record } from "../tooling/gpu-stream-model.ts";

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
  expect(calls.every((call) => String(call.context) === "bundle")).toBe(true);
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
