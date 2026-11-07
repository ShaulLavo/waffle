import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GPU_ASYNC_FIXTURE_WASM, verifiedGpuAsyncFixture } from "../scripts/build-gpu-fixture.js";
import { AsyncProtocolHost, type AsyncReplyFault } from "./fixtures/gpu/async-host.js";
import expected from "./fixtures/gpu/async-expected.json";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.GPU_SCRATCH_ROOT ?? "/work/tmp", "waffle-g2-c-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const directory = process.env.GPU_FIXTURE_DIR;
const wasm = directory ? verifiedGpuAsyncFixture(directory) : undefined;

test("C local mapping leases and source sentinel pass without a GPU", () => {
  const output = join(scratch, "local");
  const build = Bun.spawnSync([
    "cc",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DGPU_ASYNC_LOCAL_ONLY",
    join(root, "tests/fixtures/gpu/async.c"),
    "-o",
    output,
  ]);
  expect(build.exitCode).toBe(0);
  const result = Bun.spawnSync([output]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("GPU_ASYNC_LOCAL_OK");
});

describe.skipIf(!wasm)(
  "real compiled C decoder under protocol controls, not native acceptance",
  () => {
    function host(args: string[] = [], fault: AsyncReplyFault = "none") {
      if (!wasm) throw new Error("Set GPU_FIXTURE_DIR to a verified compiled producer output");
      return new AsyncProtocolHost(wasm, args, fault);
    }
    test("wasm32-wasip1 imports have no JS stream producer or unexpected custom capability", () => {
      if (!wasm) throw new Error("Missing WASM");
      const module = new WebAssembly.Module(wasm);
      expect(
        WebAssembly.Module.imports(module)
          .filter((entry) => entry.module !== "wasi_snapshot_preview1")
          .map((entry) => `${entry.module}.${entry.name}`)
          .sort(),
      ).toEqual([
        "runtime_gpu.append",
        "runtime_gpu.close",
        "runtime_gpu.completions",
        "runtime_gpu.open",
        "runtime_gpu.payload",
      ]);
      expect(WebAssembly.Module.imports(module).every((entry) => entry.kind === "function")).toBe(
        true,
      );
    });
    test("actual C query/map encoders match the independently authored schema literals", () => {
      const control = host(["--vectors"]);
      expect(control.run()).toBe(0);
      const vectors = new Map(
        control.output
          .join("")
          .trim()
          .split("\n")
          .map((line) => {
            const [name, bytes] = line.split(" ");
            return [name, bytes];
          }),
      );
      for (const vector of expected.commands) {
        const opcode = Number.parseInt(vector.hex.slice(0, 2), 16);
        expect(
          vectors.get(opcode === 115 ? "map" : opcode === 116 ? "unmap" : `query-${opcode}`),
        ).toBe(vector.hex.replaceAll(/\s/g, ""));
      }
      expect(vectors.get("writes")).toBe(expected.private.hex.replaceAll(/\s/g, ""));
      expect(control.commands).toEqual([]);
    });
    test("C pumps its own bytes, payload retry and one-consumption checks", () => {
      const control = host();
      const code = control.run();
      expect(control.protocolErrors).toEqual([]);
      expect(control.errors.join("")).toBe("");
      expect(code).toBe(0);
      expect(control.output.join("")).toContain("GPU_ASYNC_OK compiled=C");
      expect(control.closed).toBe(true);
      expect(control.payloadCalls.some((call) => call.status === -28)).toBe(true);
      expect(control.payloadCalls.some((call) => call.status === -42)).toBe(true);
      expect(control.payloadCalls.some((call) => call.status === -8)).toBe(true);
      const maps = control.decoded.filter((call) => call.layout.name === "buffer.map_async");
      expect(maps.some((call) => call.fields.size === 0xffffffffffffffffn)).toBe(true);
      expect(maps.some((call) => call.fields.size === 0n)).toBe(true);
      expect(maps.some((call) => call.fields.offset === 8n && call.fields.size === 24n)).toBe(true);
    });
    test.each([
      "token",
      "query-opcode",
      "query-truncated",
      "void-scalar",
      "output-chain",
      "map-length",
      "map-status",
      "compilation-location",
      "compilation-chain",
      "loss-reason",
      "payload-reusable",
      "short-consumes",
    ] satisfies AsyncReplyFault[])("C assertions reject the %s reply control", (fault) => {
      const control = host([], fault);
      expect(control.run()).toBe(1);
      expect(control.errors.join("")).toContain("GPU_ASYNC_FAIL");
      expect(control.output.join("")).not.toContain("GPU_ASYNC_OK compiled=C");
      expect(control.closed).toBe(true);
    });
    test.each(["--suppress-writes", "--corrupt-range", "--reuse-payload", "--malformed-map"])(
      "guest negative %s fails a real C assertion rather than adding a log",
      (flag) => {
        const control = host([flag]);
        expect(control.run()).toBe(1);
        expect(control.errors.join("")).toContain("GPU_ASYNC_FAIL");
        expect(control.output.join("")).not.toContain("GPU_ASYNC_OK compiled=C");
      },
    );
    test("async source, pinned header and output bytes participate in producer freshness", () => {
      if (!directory || !wasm) throw new Error("Missing compiled producer");
      const copy = join(scratch, "artifact");
      mkdirSync(copy);
      for (const name of [GPU_ASYNC_FIXTURE_WASM, "async.inputs.json"])
        cpSync(join(directory, name), join(copy, name));
      const metadata: unknown = JSON.parse(readFileSync(join(copy, "async.inputs.json"), "utf8"));
      if (!metadata || typeof metadata !== "object" || !("contract" in metadata))
        throw new Error("Missing contract");
      const contract = metadata.contract;
      if (
        !contract ||
        typeof contract !== "object" ||
        !("inputs" in contract) ||
        !Array.isArray(contract.inputs)
      )
        throw new Error("Missing source inputs");
      const sourceRoot = join(scratch, "source");
      for (const input of contract.inputs) {
        if (
          !input ||
          typeof input !== "object" ||
          !("path" in input) ||
          typeof input.path !== "string"
        )
          throw new Error("Invalid source input");
        mkdirSync(dirname(join(sourceRoot, input.path)), { recursive: true });
        cpSync(join(root, input.path), join(sourceRoot, input.path));
      }
      expect(verifiedGpuAsyncFixture(copy, sourceRoot)).toEqual(wasm);
      for (const path of [
        "tests/fixtures/gpu/async.c",
        "tests/fixtures/gpu/async_encode.h",
        "browser/gpu/upstream/webgpu.h",
        "tests/fixtures/gpu/async-expected.json",
      ]) {
        const file = join(sourceRoot, path),
          bytes = readFileSync(file);
        writeFileSync(file, "stale input");
        expect(() => verifiedGpuAsyncFixture(copy, sourceRoot)).toThrow("inputs changed");
        writeFileSync(file, bytes);
      }
      writeFileSync(join(copy, GPU_ASYNC_FIXTURE_WASM), wasm.subarray(0, 16));
      expect(() => verifiedGpuAsyncFixture(copy, sourceRoot)).toThrow("artifact changed");
      expect(readdirSync(copy).sort()).toEqual(["async.inputs.json", "async.wasm"]);
    });
  },
);

test("compiled native result parser rejects missing markers and wrong exits", async () => {
  const { requireCompiledAsyncResult } = await import("./gpu-async-browser-runner.js");
  expect(() =>
    requireCompiledAsyncResult({
      exit: { kind: "exited", code: 0 },
      text: "GPU_ASYNC_OK",
      errors: [],
    }),
  ).toThrow("Missing compiled result marker");
  expect(() =>
    requireCompiledAsyncResult({ exit: { kind: "exited", code: 1 }, text: "", errors: [] }),
  ).toThrow("failed");
});
test("native negative parser requires its exact assertion and protocol terminal", async () => {
  const { requireCompiledAsyncNegative } = await import("./gpu-async-browser-runner.js");
  const result = {
    exit: { kind: "exited", code: 1 },
    text: "GPU_ASYNC_FAIL stage=payload-once",
    errors: [],
  };
  expect(() => requireCompiledAsyncNegative(result, "--reuse-payload")).not.toThrow();
  expect(() => requireCompiledAsyncNegative(result, "--suppress-writes")).toThrow("Wrong negative");
  result.text = "GPU_ASYNC_FAIL stage=completion-correlation";
  expect(() => requireCompiledAsyncNegative(result, "--corrupt-range")).toThrow(
    "Missing protocol terminal",
  );
  result.text = "GPU_ASYNC_TERMINAL reason=2\nGPU_ASYNC_FAIL stage=completion-correlation";
  expect(() => requireCompiledAsyncNegative(result, "--corrupt-range")).not.toThrow();
  result.text += "\nGPU_ASYNC_OK";
  expect(() => requireCompiledAsyncNegative(result, "--corrupt-range")).toThrow("Invalid negative");
});
