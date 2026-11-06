import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  gpuDescriptorAdapters,
  gpuEventRoutes,
  gpuStream,
  gpuStreamSources,
  gpuSentinels,
  gpuDictionaryMembers,
  gpuDictionaryRules,
  gpuObjectKinds,
  gpuCOutputs,
} from "../browser/gpu/generated/tables.ts";
import selection from "../browser/gpu/stream.json";
import expected from "./fixtures/gpu/expected.json";
import enums from "./fixtures/gpu/enums.json";
import { compileSchema, generate, sha256 } from "../tooling/gpu-stream.ts";
import {
  encodeGpuCommand,
  encodeGpuCompletion,
  encodeGpuStruct,
  gpuEnum,
  gpuFlags,
  gpuSafeNumber,
} from "../tooling/gpu-stream-layout.ts";

const root = resolve(import.meta.dir, "..");
const yaml = Bun.YAML.parse(readFileSync(join(root, "browser/gpu/upstream/webgpu.yml"), "utf8"));

function selected() {
  return structuredClone(selection);
}

function scratch(): string {
  return mkdtempSync(join(process.env.GPU_SCRATCH_ROOT ?? tmpdir(), "waffle-gpu-schema-"));
}

test("schema scratch follows an explicit portable root", () => {
  const directory = mkdtempSync(join(tmpdir(), "waffle-gpu-schema-root-"));
  const previous = process.env.GPU_SCRATCH_ROOT;
  let path: string | undefined;
  try {
    process.env.GPU_SCRATCH_ROOT = directory;
    path = scratch();
    expect(dirname(path)).toBe(directory);
  } finally {
    if (previous === undefined) delete process.env.GPU_SCRATCH_ROOT;
    else process.env.GPU_SCRATCH_ROOT = previous;
    if (path) rmSync(path, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

function copyInputs(path: string): void {
  for (const file of Object.keys(gpuStreamSources)) {
    mkdirSync(resolve(path, file, ".."), { recursive: true });
    cpSync(join(root, file), join(path, file));
  }
}

describe("pinned C schema and generator", () => {
  test("pins upstream bytes and BSD license independently of generated outputs", () => {
    expect(sha256(readFileSync(join(root, "browser/gpu/upstream/webgpu.yml")))).toBe(
      "9268864efc29edc2e4fa40949643d14ae5bf6664447eadfccdeaefe7e14d130b",
    );
    expect(sha256(readFileSync(join(root, "browser/gpu/upstream/LICENSE")))).toBe(
      "17420d366df90c474bd70ad474694956cdb7fc64be70387a49a45458c4152d22",
    );
    expect(compileSchema(yaml, selection)).toEqual(gpuStream);
  });

  test("all outputs and source hashes are fresh in the quality entry", async () => {
    await generate(root, true);
    const manifest = await Bun.file(join(root, "package.json")).json();
    expect(manifest.scripts.quality).toContain("check:gpu-stream");
    expect(manifest.scripts["check:gpu-stream"]).toBe("bun tooling/gpu-stream.ts --check");
  });

  test("rejects stale TS, C, adapter and independent fixture inputs without rewriting", async () => {
    const path = scratch();
    try {
      copyInputs(path);
      await generate(path);
      const ts = join(path, "browser/gpu/generated/tables.ts");
      const header = join(path, "tests/fixtures/gpu/waffle_gpu_stream.h");
      writeFileSync(ts, "stale");
      await expect(generate(path, true)).rejects.toThrow("Stale GPU output");
      expect(readFileSync(ts, "utf8")).toBe("stale");
      await generate(path);
      writeFileSync(header, "stale");
      await expect(generate(path, true)).rejects.toThrow("waffle_gpu_stream.h");
      await generate(path);
      writeFileSync(join(path, "tooling/gpu-stream-layout.ts"), "changed adapter input");
      await expect(generate(path, true)).rejects.toThrow("Stale GPU output");
      await generate(path);
      writeFileSync(join(path, "tests/fixtures/gpu/expected.json"), "changed independent fixture");
      await expect(generate(path, true)).rejects.toThrow("Stale GPU output");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("refuses tampered schema/license before writing outputs", async () => {
    const path = scratch();
    try {
      copyInputs(path);
      writeFileSync(join(path, "browser/gpu/upstream/LICENSE"), "different license");
      await expect(generate(path)).rejects.toThrow("hash mismatch");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects duplicate, reserved, missing and retired opcodes", () => {
    const duplicate = selected();
    duplicate.calls[1]!.opcode = 1;
    expect(() => compileSchema(yaml, duplicate)).toThrow();
    const reserved = selected();
    reserved.calls[0]!.opcode = 0x1000;
    expect(() => compileSchema(yaml, reserved)).toThrow();
    const missing = selected();
    Reflect.deleteProperty(missing.calls[0]!, "opcode");
    expect(() => compileSchema(yaml, missing)).toThrow();
    const retired = { ...selected(), retiredOpcodes: [1] };
    expect(() => compileSchema(yaml, retired)).toThrow("retired");
    const renumbered = selected();
    renumbered.records[0]!.opcode = 0x1010;
    expect(() => compileSchema(yaml, renumbered)).toThrow();
  });

  test("rejects missing signatures, callback results, named adapters and enum mappings", () => {
    const badCall = selected();
    badCall.calls[0]!.name = "instance.unknown";
    expect(() => compileSchema(yaml, badCall)).toThrow("Missing YAML call");
    const badReturn = selected();
    badReturn.calls[0]!.result.kind = "void";
    expect(() => compileSchema(yaml, badReturn)).toThrow("Callback result mismatch");
    const badAdapter = selected();
    Reflect.set(badAdapter.calls[0]!, "lowering", { kind: "guess-from-yaml" });
    expect(() => compileSchema(yaml, badAdapter)).toThrow("named lowering");
    const missingReply = selected();
    missingReply.calls[0]!.token = null;
    expect(() => compileSchema(yaml, missingReply)).toThrow("reply/token");
    const missingEnums = selected();
    Reflect.deleteProperty(missingEnums.browserEnums, "enum.error_filter");
    expect(() => compileSchema(yaml, missingEnums)).toThrow("Missing explicit enum");
    const incompleteEnums = selected();
    Reflect.deleteProperty(incompleteEnums.browserEnums["enum.error_filter"], "validation");
    expect(() => compileSchema(yaml, incompleteEnums)).toThrow("Incomplete enum");
  });
});

for (const vector of expected.vectors) {
  test(`independent bytes: ${vector.name}`, () => {
    const actual = encodeGpuCommand(gpuStream, vector.command, vector.input);
    expect(Buffer.from(actual).toString("hex")).toBe(vector.hex.replaceAll(/\s/g, ""));
    expect(actual.byteLength % 8).toBe(0);
  });
}

test("C enum values agree with independent primary-header transcriptions", () => {
  for (const [type, entries] of Object.entries(enums.values)) {
    const actual = gpuStream.enums[type as keyof typeof gpuStream.enums];
    expect(actual).toMatchObject(entries);
  }
  expect(gpuEnum(gpuStream, "enum.texture_format", 27)).toBe("bgra8unorm");
  expect(gpuEnum(gpuStream, "enum.error_filter", 1)).toBe("validation");
  expect(gpuEnum(gpuStream, "enum.primitive_topology", 0)).toBeUndefined();
  expect(gpuEnum(gpuStream, "enum.optional_bool", 2)).toBeUndefined();
  expect(() => gpuEnum(gpuStream, "enum.texture_format", 0x1234)).toThrow("Unknown");
  expect(() => gpuEnum(gpuStream, "enum.backend_type", 1)).toThrow("Unsupported");
  expect(gpuFlags(gpuStream, "bitflag.texture_usage", 17n)).toBe(17);
  expect(gpuFlags(gpuStream, "bitflag.color_write_mask", 15n)).toBe(15);
  expect(() => gpuFlags(gpuStream, "bitflag.color_write_mask", 16n)).toThrow("Unsupported");
  expect(() => gpuFlags(gpuStream, "bitflag.texture_usage", 32n)).toThrow("Unsupported");
});

test("named lowering covers callbacks, surface statuses, auto layout and event omission", () => {
  expect(gpuStream.root).toEqual({ object: "instance", id: 1, generation: 1 });
  expect(gpuEventRoutes).toEqual({
    "device_descriptor.device_lost_callback_info": "device-lost",
    "device_descriptor.uncaptured_error_callback_info": "uncaptured-error",
  });
  expect(gpuStream.structs.device_descriptor.fields.map((field) => field.name)).not.toContain(
    "device_lost_callback_info",
  );
  expect(gpuDescriptorAdapters["auto-layout"].rules.layout).toBe(
    "null-handle-to-auto-otherwise-resolve",
  );
  expect(gpuDescriptorAdapters["stable-frame"].rules.usage).toBe("u64-safe-number-add-copy-src");
  expect(gpuSentinels["render_pass_color_attachment.depth_slice"]).toBe("uint32_max-to-omit");
  expect(gpuStream.calls.find((call) => call.name === "surface.present")?.result).toEqual({
    kind: "scalar",
    type: "enum.status",
  });
  expect(
    gpuStream.completions
      .find((entry) => entry.name === "surface-texture")
      ?.fields.map((field) => field.name),
  ).toEqual(["texture", "status"]);
});

test("u64/flags are eight-byte aligned and retain all bits until checked lowering", () => {
  const bytes = encodeGpuStruct(gpuStream, "vertex_attribute", {
    next_in_chain: [],
    format: 28,
    offset: 9007199254740991n,
    shader_location: 0xffffffff,
  });
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(0, true)).toBe(0);
  expect(view.getBigUint64(8, true)).toBe(9007199254740991n);
  expect(view.getUint32(16, true)).toBe(0xffffffff);
  expect(gpuSafeNumber(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => gpuSafeNumber(9007199254740992n)).toThrow("Lossy");
  expect(() => gpuSafeNumber(-1n)).toThrow("Lossy");
  expect(() =>
    encodeGpuStruct(gpuStream, "vertex_attribute", {
      next_in_chain: [],
      format: 28,
      offset: 1n << 64n,
      shader_location: 0,
    }),
  ).toThrow("bounds");
});

test("rejects unsafe integers, zero tokens/handles, callback pointers and unsupported chains", () => {
  const input = expected.vectors[0]!.input;
  expect(() =>
    encodeGpuCommand(gpuStream, "instance.request_adapter", { ...input, token: 0 }),
  ).toThrow("Zero");
  expect(() =>
    encodeGpuCommand(gpuStream, "instance.request_adapter", { ...input, token: 2 ** 32 }),
  ).toThrow("bounds");
  expect(() =>
    encodeGpuCommand(gpuStream, "instance.request_adapter", { ...input, token: 1.1 }),
  ).toThrow("bounds");
  expect(() =>
    encodeGpuCommand(gpuStream, "instance.request_adapter", {
      ...input,
      receiver: { id: 0, generation: 1 },
    }),
  ).toThrow("handle");
  expect(() =>
    encodeGpuCommand(gpuStream, "instance.request_adapter", { ...input, callback_info: 0 }),
  ).toThrow("omitted field");
  expect(() =>
    encodeGpuStruct(gpuStream, "shader_module_descriptor", {
      next_in_chain: [{ sType: 1, value: {} }],
      label: "",
    }),
  ).toThrow("sType");
  expect(() =>
    encodeGpuCommand(gpuStream, "render_pass_encoder.draw", {
      vertex_count: 9007199254740992,
      instance_count: 1,
      first_vertex: 0,
      first_instance: 0,
    }),
  ).toThrow("exact integer");
});

test("generated C header compiles and independently writes the root vector", () => {
  const path = scratch();
  try {
    const source = join(path, "layout.c");
    const binary = join(path, "layout");
    writeFileSync(
      source,
      `#include "waffle_gpu_stream.h"
#include <stdio.h>
int main(void) {
  unsigned char bytes[128] = {0}; WaffleGpuWriter w = {bytes, sizeof(bytes), 0, 0};
  size_t start = waffle_gpu_begin(&w, WAFFLE_GPU_OP_INSTANCE_REQUEST_ADAPTER);
  waffle_gpu_handle(&w, 2, 1); waffle_gpu_token(&w, 1);
  waffle_gpu_handle(&w, WAFFLE_GPU_ROOT_ID, WAFFLE_GPU_ROOT_GENERATION);
  waffle_gpu_u32(&w, 0); waffle_gpu_end(&w, start);
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
        join(root, "tests/fixtures/gpu"),
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
    expect(run.stdout).toBe(expected.vectors[0]!.hex.replaceAll(/\s/g, ""));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

for (const vector of expected.completions) {
  test(`independent completion bytes: ${vector.name}`, () => {
    const bytes = encodeGpuCompletion(
      gpuStream,
      vector.completion,
      vector.token,
      vector.status,
      vector.input,
    );
    expect(Buffer.from(bytes).toString("hex")).toBe(vector.hex.replaceAll(/\s/g, ""));
  });
}

test("dictionary names and special policies are explicit selection inputs", () => {
  expect(gpuDictionaryMembers.vertex_state.entry_point).toBe("entryPoint");
  expect(gpuDictionaryMembers.request_adapter_options.compatible_surface).toBeNull();
  expect(gpuDictionaryRules.constantEntries).toBe(
    "array-of-key-value-to-record-reject-duplicate-keys",
  );
  expect(gpuObjectKinds.device).toBe(3);
  expect(gpuCOutputs["surface.get_current_texture"].fields).toEqual(["texture", "status"]);
  expect(gpuStream.calls.find((entry) => entry.name === "instance.request_adapter")?.cReturn).toBe(
    "struct.future",
  );
  expect(
    gpuStream.calls.find((entry) => entry.name === "instance.request_adapter")?.callback?.future,
  ).toBe("token-as-future-id");
});
