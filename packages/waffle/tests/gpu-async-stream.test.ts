import { expect, test } from "bun:test";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import {
  encodeGpuCommand,
  encodeGpuCompletion,
  encodeGpuStruct,
} from "../tooling/gpu-stream-layout.ts";
import expected from "./fixtures/gpu/async-expected.json";

function literal(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replaceAll(/\s/g, ""), "hex"));
}
function integers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(integers);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, integers(item)]));
  return value === "18446744073709551615" ? 0xffffffffffffffffn : value;
}
for (const vector of expected.commands) {
  test(`G2 independent command ${vector.command}`, () => {
    expect(encodeGpuCommand(gpuStream, vector.command, integers(vector.input))).toEqual(
      literal(vector.hex),
    );
  });
}
for (const vector of expected.completions) {
  test(`G2 independent completion ${vector.name}/${vector.token}`, () => {
    expect(
      encodeGpuCompletion(gpuStream, vector.name, vector.token, vector.status, vector.input),
    ).toEqual(literal(vector.hex));
  });
}
for (const vector of expected.structs) {
  test(`G2 independent output ${vector.name}`, () => {
    expect(encodeGpuStruct(gpuStream, vector.name, vector.input)).toEqual(literal(vector.hex));
  });
}

test("G2 keeps earlier calls, completions, enums, structs and private numbers", async () => {
  const { sha256 } = await import("../tooling/gpu-stream.ts");
  const { baseline } = expected;
  expect(sha256(JSON.stringify(gpuStream.calls.filter((call) => call.opcode <= 106)))).toBe(
    baseline.calls,
  );
  expect(sha256(JSON.stringify(gpuStream.completions.filter((entry) => entry.kind <= 15)))).toBe(
    baseline.completions,
  );
  for (const [name, digest] of Object.entries(baseline.structs))
    expect(sha256(JSON.stringify(Reflect.get(gpuStream.structs, name)))).toBe(digest);
  for (const [name, digest] of Object.entries(baseline.enums))
    expect(sha256(JSON.stringify(Reflect.get(gpuStream.enums, name)))).toBe(digest);
  expect(gpuStream.root).toEqual(baseline.root);
  expect(gpuStream.records.map((entry) => [entry.name, entry.opcode])).toEqual(
    baseline.records.map((entry) => [entry.name, entry.opcode]),
  );
  const { encodeGpuPrivate } = await import("../tooling/gpu-stream-layout.ts");
  expect(encodeGpuPrivate(gpuStream, expected.private.name, expected.private.input)).toEqual(
    literal(expected.private.hex),
  );
});

test("G2 generator checks mutable outputs, exact returns, callbacks and reserved values", async () => {
  const { compileSchema } = await import("../tooling/gpu-stream.ts");
  const { record, list } = await import("../tooling/gpu-stream-model.ts");
  const selection = (await import("../browser/gpu/stream.json")).default;
  const yaml: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url)).text(),
  );
  const alter = (change: (selection: Record<string, unknown>) => void) => {
    const input = structuredClone(selection);
    change(record(input));
    expect(() => compileSchema(yaml, input)).toThrow();
  };
  alter((s) => {
    Reflect.deleteProperty(record(s.cOutput), "adapter.get_features");
  });
  alter((s) => {
    record(list(s.calls)[106]).cReturn = "void";
  });
  alter((s) => {
    record(list(s.calls)[107]).lowering = { kind: "method", member: "getFeatures" };
  });
  alter((s) => {
    record(record(list(s.calls)[114]).callback).args = [];
  });
  alter((s) => {
    record(list(s.calls)[106]).opcode = 106;
  });
  const changed = structuredClone(yaml);
  const callback = list(record(changed).callbacks)
    .map(record)
    .find((c) => c.name === "compilation_info");
  if (!callback) throw new Error("Missing pinned callback");
  record(list(callback.args)[1]).pointer = "mutable";
  expect(() => compileSchema(changed, selection)).toThrow("Callback signature");
});

test.skipIf(!process.env.WASI_SDK_PATH)(
  "wasm32 C whole-map sentinel normalizes before widening against pinned header",
  async () => {
    const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const scratch = mkdtempSync(join(tmpdir(), "g2-source-"));
    try {
      writeFileSync(
        join(scratch, "sentinel.c"),
        `
#include "webgpu.h"
#include "waffle_gpu_stream.h"
_Static_assert(sizeof(size_t) == 4, "wasm32 source ABI");
_Static_assert(WGPU_WHOLE_MAP_SIZE == SIZE_MAX, "source whole-map sentinel");
_Static_assert(SIZE_MAX == UINT32_MAX, "wasm32 source width");
int check(void) {
  return waffle_gpu_map_size(WGPU_WHOLE_MAP_SIZE) == UINT64_MAX &&
    waffle_gpu_map_size(0) == 0 && waffle_gpu_map_size(16) == 16 &&
    waffle_gpu_map_size(UINT32_MAX - 1) == UINT64_C(4294967294);
}
`,
      );
      const clang = process.env.WASI_SDK_PATH
        ? join(process.env.WASI_SDK_PATH, "bin/clang")
        : "clang";
      const result = Bun.spawnSync(
        [
          clang,
          "--target=wasm32-wasip1",
          "-ffreestanding",
          "-nostdlib",
          "-O2",
          "-Werror",
          "-Wl,--no-entry",
          "-Wl,--export=check",
          "-I",
          resolve(import.meta.dir, "../browser/gpu/upstream"),
          "-I",
          resolve(import.meta.dir, "fixtures/gpu"),
          join(scratch, "sentinel.c"),
          "-o",
          join(scratch, "sentinel.wasm"),
        ],
        { stderr: "pipe" },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const module = await WebAssembly.instantiate(readFileSync(join(scratch, "sentinel.wasm")));
      const check = module.instance.exports.check;
      if (typeof check !== "function") throw new Error("Missing source sentinel control");
      expect(check()).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("production output sizing and direct shared-arena UTF-8 writing match independent C layouts", async () => {
  const { outputStruct } = await import("../browser/gpu/codec.ts");
  const { wireObject } = await import("../browser/gpu/codec.ts");
  for (const vector of expected.structs) {
    const value = wireObject(vector.input);
    const length = outputStruct(vector.name, value);
    const output = new Uint8Array(new SharedArrayBuffer(length));
    outputStruct(vector.name, value, output);
    expect(output).toEqual(literal(vector.hex));
  }
});
