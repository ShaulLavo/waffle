import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

test("generated C cursors independently encode sampler f32 and u16 fields", () => {
  const scratch = mkdtempSync(join(process.env.GPU_SCRATCH_ROOT ?? tmpdir(), "gpu-scene-c-"));
  try {
    const source = join(scratch, "sampler.c");
    const binary = join(scratch, "sampler");
    writeFileSync(
      source,
      `#include "waffle_gpu_stream.h"
#include <stdio.h>
int main(void) {
  unsigned char bytes[80] = {0}; WaffleGpuWriter w = {bytes, sizeof(bytes), 0, 0};
  size_t start = waffle_gpu_begin(&w, WAFFLE_GPU_OP_DEVICE_CREATE_SAMPLER);
  waffle_gpu_handle(&w, 6, 1); waffle_gpu_handle(&w, 3, 1);
  waffle_gpu_u32(&w, 1); waffle_gpu_u32(&w, 0); waffle_gpu_string(&w, "", 0);
  for (unsigned i = 0; i < 6; ++i) waffle_gpu_u32(&w, 0);
  waffle_gpu_f32(&w, 0); waffle_gpu_f32(&w, 32); waffle_gpu_u32(&w, 0);
  waffle_gpu_u16(&w, 0x1234); waffle_gpu_end(&w, start);
  if (w.error) return 1;
  for (size_t i = 0; i < w.offset; ++i) printf("%02x", bytes[i]);
  return 0;
}`,
    );
    const compiled = spawnSync(
      "cc",
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-I",
        resolve(import.meta.dir, "fixtures/gpu"),
        source,
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    expect(compiled.stderr).toBe("");
    expect(compiled.status).toBe(0);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const vector = expected.vectors.find(
      (entry) => entry.name === "sampler u16 is two-byte aligned",
    );
    if (!vector) throw new Error("Missing independent sampler vector");
    expect(run.stdout).toBe(vector.hex.replaceAll(/\s/g, ""));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
