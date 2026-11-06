import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildGpuFixture,
  GPU_FIXTURE_WASM,
  verifiedGpuFixture,
} from "../scripts/build-gpu-fixture.ts";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import { encodeGpuCommand, encodeGpuCompletion } from "../tooling/gpu-stream-layout.ts";
import expected from "./fixtures/gpu/expected.json";
import { retireCommandGroup } from "../scripts/owned-command.ts";

const packageRoot = resolve(import.meta.dir, "..");
const scratchRoot = process.env.GPU_SCRATCH_ROOT ?? tmpdir();
const fixtureDirectory = process.env.GPU_FIXTURE_DIR;
const sdk = process.env.WASI_SDK_PATH;
const compiled = Boolean(fixtureDirectory || sdk);
let scratch: string;
let artifactDirectory: string;
let wasm: Uint8Array<ArrayBuffer>;
let safeToRemove = true;

beforeAll(async () => {
  scratch = mkdtempSync(join(scratchRoot, "gpu-fixture-"));
  artifactDirectory = fixtureDirectory ?? join(scratch, "artifact");
  if (!fixtureDirectory && sdk) await buildGpuFixture(artifactDirectory);
  if (compiled) wasm = verifiedGpuFixture(artifactDirectory);
});
afterAll(() => {
  if (safeToRemove) rmSync(scratch, { recursive: true, force: true });
  else console.error(`Compiler retirement unconfirmed; retained scratch: ${scratch}`);
});

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
const handle = (id: number) => ({ id, generation: 1 });

function renderCommands(): Uint8Array {
  const begin = encodeGpuCommand(gpuStream, "command_encoder.begin_render_pass", {
    result: handle(11),
    descriptor: {
      next_in_chain: [],
      label: "",
      color_attachments: [
        {
          next_in_chain: [],
          view: handle(9),
          depth_slice: 0xffffffff,
          resolve_target: null,
          load_op: 2,
          store_op: 1,
          clear_value: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depth_stencil_attachment: null,
      occlusion_query_set: null,
      timestamp_writes: null,
    },
  });
  const records = [begin].concat([
    encodeGpuCommand(gpuStream, "render_pass_encoder.set_pipeline", { pipeline: handle(7) }),
    encodeGpuCommand(gpuStream, "render_pass_encoder.draw", {
      vertex_count: 3,
      instance_count: 1,
      first_vertex: 0,
      first_instance: 0,
    }),
    encodeGpuCommand(gpuStream, "render_pass_encoder.end", {}),
    encodeGpuCommand(gpuStream, "command_encoder.finish", { result: handle(12), descriptor: null }),
  ]);
  return Buffer.concat(records);
}

test("the actual C encoders match ten independent vectors and the nested render layout", () => {
  const executable = join(scratch, "vectors");
  run([
    "cc",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DGPU_FIXTURE_VECTORS_ONLY",
    join(import.meta.dir, "fixtures/gpu/triangle.c"),
    "-o",
    executable,
  ]);
  const vectors = new Map(
    run([executable])
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(" ");
        if (!key || !value) throw new Error("Invalid C vector output");
        return [key, value];
      }),
  );
  for (const vector of expected.vectors)
    expect(vectors.get(vector.command)).toBe(vector.hex.replaceAll(" ", ""));
  expect(vectors.get("configure")).toBe(
    hex(
      encodeGpuCommand(gpuStream, "surface.configure", {
        receiver: handle(4),
        config: {
          next_in_chain: [],
          device: handle(3),
          format: 27,
          usage: 16n,
          width: 64,
          height: 48,
          view_formats: [],
          alpha_mode: 1,
          present_mode: 1,
        },
      }),
    ),
  );
  // The encode envelope's count is followed by unaligned byte data, not a C struct.
  const nested = renderCommands();
  const envelope = Buffer.alloc((20 + nested.length + 7) & ~7);
  envelope.writeUInt16LE(0x1001, 0);
  envelope.writeUInt32LE(envelope.length, 4);
  envelope.writeUInt32LE(10, 8);
  envelope.writeUInt32LE(1, 12);
  envelope.writeUInt32LE(nested.length, 16);
  envelope.set(nested, 20);
  expect(vectors.get("encode")).toBe(hex(envelope));
  const goldenPipeline = expected.vectors.find(
    (entry) => entry.command === "device.create_render_pipeline",
  );
  if (!goldenPipeline) throw new Error("Missing pipeline golden");
  const descriptor = record(record(goldenPipeline.input).descriptor);
  expect(vectors.get("pipeline")).toBe(
    hex(
      encodeGpuCommand(gpuStream, "device.create_render_pipeline", {
        ...goldenPipeline.input,
        descriptor: {
          ...descriptor,
          fragment: {
            next_in_chain: [],
            module: handle(6),
            entry_point: null,
            constants: [],
            targets: [{ next_in_chain: [], format: 27, blend: null, write_mask: 15n }],
          },
        },
      }),
    ),
  );
  expect(vectors.get("view")).toBe(
    hex(
      encodeGpuCommand(gpuStream, "texture.create_view", {
        result: handle(9),
        receiver: handle(8),
        descriptor: null,
      }),
    ),
  );
  expect(vectors.get("submit")).toBe(
    hex(
      encodeGpuCommand(gpuStream, "queue.submit", {
        receiver: handle(5),
        commands: [handle(12)],
      }),
    ),
  );
});

test("an explicit pinned SDK is required, with no ambient compiler fallback", async () => {
  const result = Bun.spawnSync(
    [process.execPath, join(packageRoot, "scripts/build-gpu-fixture.ts"), join(scratch, "no-sdk")],
    { env: { ...process.env, WASI_SDK_PATH: "" }, stderr: "pipe" },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("WASI_SDK_PATH must be an absolute path");
  expect(readdirSync(scratch)).not.toContain("no-sdk");
});

test("a compiler failure removes scratch and never replaces an earlier artifact", async () => {
  const failed = join(scratch, "failed");
  const fakeSdk = join(scratch, "failing-sdk");
  mkdirSync(join(fakeSdk, "bin"), { recursive: true });
  writeFileSync(join(fakeSdk, "VERSION"), "34.0\nwasi-libc: 2e6fb9d8ee0c\n");
  const clang = join(fakeSdk, "bin/clang");
  writeFileSync(
    clang,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "clang version 23.1.0-wasi-sdk failure-test"; exit 0; fi\necho "intentional compile failure" >&2\nexit 42\n',
  );
  chmodSync(clang, 0o755);
  mkdirSync(failed);
  writeFileSync(join(failed, GPU_FIXTURE_WASM), "earlier artifact");
  const child = Bun.spawnSync(
    [process.execPath, join(packageRoot, "scripts/build-gpu-fixture.ts"), failed],
    {
      env: { ...process.env, WASI_SDK_PATH: fakeSdk },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("intentional compile failure");
  expect(readdirSync(failed)).toEqual([GPU_FIXTURE_WASM]);
  expect(readFileSync(join(failed, GPU_FIXTURE_WASM), "utf8")).toBe("earlier artifact");
});

async function retireRecordedCompiler(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned compiler PID");
  try {
    await retireCommandGroup(pid);
  } catch (error) {
    safeToRemove = false;
    throw error;
  }
}

test("an interrupted compiler retires its process group before removing scratch", async () => {
  const directory = join(scratch, "interrupted");
  const fakeSdk = join(scratch, "interrupted-sdk");
  mkdirSync(join(fakeSdk, "bin"), { recursive: true });
  writeFileSync(join(fakeSdk, "VERSION"), "34.0\nwasi-libc: 2e6fb9d8ee0c\n");
  const clang = join(fakeSdk, "bin/clang");
  const pidFile = join(scratch, "interrupt-compiler.pid");
  writeFileSync(
    clang,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "clang version 23.1.0-wasi-sdk interrupt-test"; exit 0; fi\necho "$$" > "$GPU_FIXTURE_INTERRUPT_PID"\necho compiler-ready\nexec sleep 30\n',
  );
  chmodSync(clang, 0o755);
  const child = Bun.spawn(
    [process.execPath, join(packageRoot, "scripts/build-gpu-fixture.ts"), directory],
    {
      env: { ...process.env, WASI_SDK_PATH: fakeSdk, GPU_FIXTURE_INTERRUPT_PID: pidFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("compiler-ready");
    reader.releaseLock();
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await retireRecordedCompiler(pidFile);
  }
}, 10000);

describe.skipIf(!compiled)("compiled Preview 1 C fixture", () => {
  test("has exactly the real custom imports and the expected WASI command imports", () => {
    const module = new WebAssembly.Module(wasm);
    for (const section of [
      ".debug_info",
      ".debug_line",
      ".debug_str",
      ".debug_abbrev",
      ".debug_ranges",
    ])
      expect(WebAssembly.Module.customSections(module, section)).toEqual([]);
    const imports = WebAssembly.Module.imports(module).map(
      (entry) => `${entry.module}.${entry.name}`,
    );
    imports.sort();
    expect(imports).toEqual([
      "runtime_gpu.append",
      "runtime_gpu.close",
      "runtime_gpu.completions",
      "runtime_gpu.open",
      "runtime_gpu.payload",
      "runtime_window.surface_info",
      "runtime_window.surfaces",
      "wasi_snapshot_preview1.args_get",
      "wasi_snapshot_preview1.args_sizes_get",
      "wasi_snapshot_preview1.clock_time_get",
      "wasi_snapshot_preview1.fd_close",
      "wasi_snapshot_preview1.fd_fdstat_get",
      "wasi_snapshot_preview1.fd_read",
      "wasi_snapshot_preview1.fd_seek",
      "wasi_snapshot_preview1.fd_write",
      "wasi_snapshot_preview1.proc_exit",
    ]);
  });
  test("cache verification needs no SDK and rejects corrupt artifacts", () => {
    const copy = join(scratch, "corrupt");
    mkdirSync(copy);
    for (const file of [GPU_FIXTURE_WASM, "triangle.inputs.json"])
      cpSync(join(artifactDirectory, file), join(copy, file));
    expect(verifiedGpuFixture(copy)).toEqual(wasm);
    writeFileSync(join(copy, GPU_FIXTURE_WASM), wasm.subarray(0, 16));
    expect(() => verifiedGpuFixture(copy)).toThrow("artifact changed");
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(packageRoot, "scripts/build-gpu-fixture.ts"),
        artifactDirectory,
        "--verify",
      ],
      { env: { ...process.env, WASI_SDK_PATH: "" } },
    );
    expect(result.exitCode).toBe(0);
  });
  test("all compiler, schema, golden and generated layout inputs invalidate the cache", () => {
    const sourceRoot = join(scratch, "source");
    const metadata = record(
      JSON.parse(readFileSync(join(artifactDirectory, "triangle.inputs.json"), "utf8")),
    );
    const inputs = record(metadata.contract).inputs;
    if (!Array.isArray(inputs)) throw new Error("Expected fixture input list");
    const paths = Array.from(inputs, (input) => {
      const path = record(input).path;
      if (typeof path !== "string") throw new Error("Expected fixture input path");
      return path;
    });
    for (const path of paths) {
      mkdirSync(dirname(join(sourceRoot, path)), { recursive: true });
      cpSync(join(packageRoot, path), join(sourceRoot, path));
    }
    expect(verifiedGpuFixture(artifactDirectory, sourceRoot)).toEqual(wasm);
    for (const path of paths) {
      const original = readFileSync(join(sourceRoot, path));
      writeFileSync(join(sourceRoot, path), "stale fixture input");
      expect(() => verifiedGpuFixture(artifactDirectory, sourceRoot)).toThrow("inputs changed");
      writeFileSync(join(sourceRoot, path), original);
    }
    expect(paths).toContain("browser/gpu/upstream/webgpu.yml");
    expect(paths).toContain("tests/fixtures/gpu/waffle_gpu_stream.h");
    expect(paths).toContain("tooling/gpu-stream.ts");
    expect(paths).toContain("tests/fixtures/gpu/gpu_encode.h");
  });
});

class FixtureExit extends Error {
  constructor(readonly code: number) {
    super(`Guest exited ${code}`);
  }
}
type ReplyFault = "none" | "adapter" | "scope" | "present" | "token" | "framing" | "exception";

// A protocol-only command runner. It has no GPU or canvas and cannot qualify rendering.
class FixtureProtocolHost {
  memory = new WebAssembly.Memory({ initial: 4 });
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly commands: Uint8Array[] = [];
  readonly replies: Uint8Array[] = [];
  readonly reads: number[] = [];
  readonly timeouts: bigint[] = [];
  closed = false;
  closes = 0;
  credit = false;
  readonly args: Uint8Array[];
  constructor(
    args: string[],
    readonly fault: ReplyFault = "none",
  ) {
    this.args = ["triangle"].concat(args).map((arg) => new TextEncoder().encode(`${arg}\0`));
  }
  get view(): DataView {
    return new DataView(this.memory.buffer);
  }
  word(ptr: number, value: number): void {
    this.view.setUint32(ptr, value, true);
  }
  put(ptr: number, bytes: Uint8Array): void {
    new Uint8Array(this.memory.buffer).set(bytes, ptr);
  }
  bytes(ptr: number, length: number): Uint8Array {
    return new Uint8Array(this.memory.buffer).slice(ptr, ptr + length);
  }
  reply(name: string, token: number, value: Record<string, unknown>): void {
    this.replies.push(encodeGpuCompletion(gpuStream, name, token, 0, value));
  }
  command(bytes: Uint8Array): void {
    this.commands.push(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const opcode = view.getUint16(0, true);
    if (opcode === 1 || opcode === 2) {
      this.reply(opcode === 1 ? "adapter" : "device", view.getUint32(16, true), {
        status: this.fault === "adapter" && opcode === 1 ? 3 : 1,
        [opcode === 1 ? "adapter" : "device"]: handle(opcode === 1 ? 2 : 3),
        message: "",
      });
      return;
    }
    if (opcode === 5) {
      this.reply("surface-texture", view.getUint32(16, true), { texture: handle(8), status: 1 });
      return;
    }
    if (opcode === 20) {
      this.reply("error-scope", view.getUint32(8, true), {
        status: 1,
        type: this.fault === "scope" ? 2 : 1,
        message: "",
      });
      return;
    }
    if (opcode !== 6) return;
    this.credit = true;
    this.reply("present", view.getUint32(8, true), { status: this.fault === "present" ? 2 : 1 });
  }
  append(ptr: number, length: number): number {
    const bytes = this.bytes(ptr, length);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    while (offset < length) {
      const count = view.getUint32(offset + 4, true);
      if (count < 8 || count % 8 || count > length - offset) throw new Error("Invalid C framing");
      this.command(bytes.slice(offset, offset + count));
      offset += count;
    }
    return 0;
  }
  completions(ptr: number, length: number, timeout: bigint, written: number): number {
    this.timeouts.push(timeout);
    if (this.timeouts.length > 32) throw new Error("Fixture spun without progress");
    if (this.replies.length === 0 && this.credit) {
      this.credit = false;
      this.reply("frame-credit", 0, { surface: handle(4) });
    }
    const bytes = Buffer.concat(this.replies.splice(0));
    if (bytes.length > length) throw new Error("Short completion destination");
    if (bytes.length && this.fault === "token") bytes.writeUInt32LE(99, 8);
    if (bytes.length && this.fault === "framing") bytes.writeUInt32LE(15, 4);
    if (bytes.length && this.fault === "exception") bytes.writeUInt16LE(8, 0);
    this.put(ptr, bytes);
    this.word(written, bytes.length);
    return 0;
  }
  fdWrite(fd: number, iovs: number, count: number, written: number): number {
    let length = 0;
    for (let index = 0; index < count; index++) {
      const ptr = this.view.getUint32(iovs + index * 8, true);
      const size = this.view.getUint32(iovs + index * 8 + 4, true);
      (fd === 2 ? this.errors : this.output).push(new TextDecoder().decode(this.bytes(ptr, size)));
      length += size;
    }
    this.word(written, length);
    return 0;
  }
  fdRead(fd: number, iovs: number, _count: number, written: number): number {
    this.reads.push(fd);
    this.put(this.view.getUint32(iovs, true), new Uint8Array([10]));
    this.word(written, 1);
    return 0;
  }
  imports(): WebAssembly.Imports {
    return {
      runtime_window: {
        surfaces: (ptr: number, length: number) => {
          expect(length).toBe(32);
          this.word(ptr, 7);
          return 1;
        },
        surface_info: (id: number, ptr: number) => {
          expect(id).toBe(7);
          for (const [offset, value] of [64, 48, 1000, 3].entries())
            this.word(ptr + offset * 4, value);
          return 0;
        },
      },
      runtime_gpu: {
        open: (_flags: number, ptr: number) => {
          this.word(ptr, 17);
          return 0;
        },
        append: (_conn: number, ptr: number, length: number) => this.append(ptr, length),
        completions: (_conn: number, ptr: number, length: number, timeout: bigint, out: number) =>
          this.completions(ptr, length, timeout, out),
        close: (_conn: number) => {
          this.closed = true;
          this.closes++;
          return 0;
        },
        payload: (_conn: number, _handle: number, _ptr: number, _length: number) =>
          this.closed ? -64 : -8,
      },
      wasi_snapshot_preview1: this.wasi(),
    };
  }
  wasi(): WebAssembly.ModuleImports {
    return {
      args_sizes_get: (count: number, size: number) => {
        this.word(count, this.args.length);
        this.word(
          size,
          this.args.reduce((total, arg) => total + arg.length, 0),
        );
        return 0;
      },
      args_get: (argv: number, buffer: number) => {
        let offset = buffer;
        for (const [index, arg] of this.args.entries()) {
          this.word(argv + index * 4, offset);
          this.put(offset, arg);
          offset += arg.length;
        }
        return 0;
      },
      clock_time_get: () => 0,
      fd_close: () => 0,
      fd_seek: () => 70,
      fd_fdstat_get: (_fd: number, ptr: number) => {
        this.put(ptr, new Uint8Array(24));
        return 0;
      },
      fd_write: (fd: number, iovs: number, count: number, out: number) =>
        this.fdWrite(fd, iovs, count, out),
      fd_read: (fd: number, iovs: number, count: number, out: number) =>
        this.fdRead(fd, iovs, count, out),
      proc_exit: (code: number) => {
        throw new FixtureExit(code);
      },
    };
  }
  run(): number {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), this.imports());
    const memory = instance.exports.memory;
    const start = instance.exports._start;
    if (!(memory instanceof WebAssembly.Memory) || typeof start !== "function")
      throw new Error("Missing command exports");
    this.memory = memory;
    try {
      start();
      return 0;
    } catch (error) {
      if (error instanceof FixtureExit) return error.code;
      throw error;
    }
  }
}

describe.skipIf(!compiled)("compiled C completion handling, not GPU acceptance", () => {
  test("uses real imports, supplied dimensions, monotonic tokens, split barriers and fd 0 reads", () => {
    const host = new FixtureProtocolHost(["green", "--split", "--pause-acquired"]);
    expect(host.run()).toBe(0);
    expect(host.errors.join("")).toBe("");
    expect(host.output.join("")).toContain("GPU_FRAME colour=green frame=1 validation=none");
    expect(host.output.join("")).toContain("GPU_WAIT_STDIN stage=acquired");
    expect(host.output.join("")).toContain("GPU_WAIT_STDIN stage=frame");
    expect(host.reads).toEqual([0, 0]);
    expect(host.timeouts.filter((timeout) => timeout === -1n).length).toBe(11);
    expect(host.timeouts.at(-1)).toBe(0n);
    expect(host.closes).toBe(2);
    const opcodes = host.commands.map((bytes) => new DataView(bytes.buffer).getUint16(0, true));
    expect(opcodes.filter((opcode) => opcode === 20).length).toBe(6);
    const tokens = host.commands
      .filter((bytes) => [1, 2, 5, 6, 20].includes(new DataView(bytes.buffer).getUint16(0, true)))
      .map((bytes) => {
        const view = new DataView(bytes.buffer);
        return view.getUint32([6, 20].includes(bytes[0] ?? 0) ? 8 : 16, true);
      });
    expect(tokens).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  test.each([
    "adapter",
    "scope",
    "present",
    "token",
    "framing",
    "exception",
  ] satisfies ReplyFault[])(
    "rejects %s failure rather than printing a successful frame marker",
    (fault) => {
      const host = new FixtureProtocolHost(["red"], fault);
      expect(host.run()).toBe(1);
      expect(host.errors.join("")).toContain("GPU_FAIL");
      expect(host.output.join("")).not.toContain("GPU_FRAME");
      expect(host.closed).toBe(true);
      expect(host.closes).toBe(1);
    },
  );
  test("second-colour and RGBA8 options change the guest's emitted commands", () => {
    const red = new FixtureProtocolHost(["red"]);
    const blue = new FixtureProtocolHost(["blue", "--rgba8"]);
    expect(red.run()).toBe(0);
    expect(blue.run()).toBe(0);
    const shader = blue.commands.find((bytes) => bytes[0] === 8);
    expect(new TextDecoder().decode(shader)).toContain("vec4f(0.0,0.0,1.0,1.0)");
    const config = blue.commands.find((bytes) => bytes[0] === 4);
    if (!config) throw new Error("Missing surface configuration");
    expect(new DataView(config.buffer).getUint32(28, true)).toBe(22);
    expect(blue.output.join("")).toContain("GPU_FRAME colour=blue");
    expect(red.commands).not.toEqual(blue.commands);
  });
});
