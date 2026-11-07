import { expect, test } from "bun:test";
import { decodeCall } from "../browser/gpu/codec.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { encodeGpuCommand } from "../tooling/gpu-stream-layout.ts";
import expected from "./fixtures/gpu/label-expected.json";

for (const vector of expected.vectors) {
  test(`independent label bytes: ${vector.command}`, () => {
    const literal = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    expect(encodeGpuCommand(gpuStream, vector.command, vector.input)).toEqual(literal);
    const decoded = decodeCall(literal);
    expect<string>(decoded.layout.context).toBe(vector.context);
    expect<unknown>(decoded.fields).toEqual(vector.input);
    expect(decoded.layout.fields).toEqual(
      (vector.context === "top"
        ? [{ name: "receiver", type: `object.${decoded.layout.receiver}`, optional: false }]
        : []
      ).concat([{ name: "label", type: "string_with_default_empty", optional: false }]),
    );
  });
}

test("label arguments are required, empty is explicit, and nested receivers are omitted", () => {
  for (const vector of expected.vectors) {
    const fields = vector.context === "top" ? { receiver: { id: 7, generation: 3 } } : {};
    expect(() => encodeGpuCommand(gpuStream, vector.command, fields)).toThrow("string");
    expect(() => encodeGpuCommand(gpuStream, vector.command, { ...fields, label: null })).toThrow();
    const bytes = encodeGpuCommand(gpuStream, vector.command, { ...fields, label: "" });
    expect(decodeCall(bytes).fields.label).toBe("");
    if (vector.context === "top") continue;
    expect(() =>
      encodeGpuCommand(gpuStream, vector.command, {
        receiver: { id: 7, generation: 3 },
        label: "L",
      }),
    ).toThrow("omitted field receiver");
  }
});

test("literal UTF-8 labels include byte lengths and four/eight-byte padding", () => {
  const top = Uint8Array.from(
    Buffer.from(
      "5b00000020000000 0700000003000000 05000000 cebb e78cab 000000 00000000".replaceAll(
        /\s/g,
        "",
      ),
      "hex",
    ),
  );
  const pass = Uint8Array.from(
    Buffer.from(
      "6400000018000000 05000000 cebb e78cab 000000 00000000".replaceAll(/\s/g, ""),
      "hex",
    ),
  );
  expect(
    encodeGpuCommand(gpuStream, "buffer.set_label", {
      receiver: { id: 7, generation: 3 },
      label: "λ猫",
    }),
  ).toEqual(top);
  expect(encodeGpuCommand(gpuStream, "render_pass_encoder.set_label", { label: "λ猫" })).toEqual(
    pass,
  );
  expect(decodeCall(top).fields.label).toBe("λ猫");
  expect(decodeCall(pass).fields).toEqual({ label: "λ猫" });
});

test("generator rejects altered label target, receiver context and optional C arguments", async () => {
  const { compileSchema } = await import("../tooling/gpu-stream.ts");
  const { record, list } = await import("../tooling/gpu-stream-model.ts");
  const selection = (await import("../browser/gpu/stream.json")).default;
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  for (const change of [{ target: "surface-reference" }, { context: "pass" }]) {
    const changed = structuredClone(selection);
    const call = changed.calls.find((call) => call.name === "buffer.set_label");
    if (!call) throw new Error("Missing label selection");
    if ("context" in change) Reflect.set(call, "context", change.context);
    else Reflect.set(call.lowering, "target", change.target);
    expect(() => compileSchema(yaml, changed)).toThrow("Label lowering");
  }
  const changed = structuredClone(yaml);
  const buffer = list(record(changed).objects)
    .map(record)
    .find((object) => object.name === "buffer");
  if (!buffer) throw new Error("Missing pinned buffer");
  const label = list(buffer.methods)
    .map(record)
    .find((method) => method.name === "set_label");
  if (!label) throw new Error("Missing pinned label");
  Reflect.set(record(list(label.args)[0]), "optional", true);
  expect(() => compileSchema(changed, selection)).toThrow("required YAML label");
});
