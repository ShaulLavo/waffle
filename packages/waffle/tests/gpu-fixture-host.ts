import { expect } from "bun:test";
import { gpuStream } from "../browser/gpu/generated/tables.js";
import { encodeGpuCompletion } from "../tooling/gpu-stream-layout.js";
const handle = (id: number) => ({ id, generation: 1 });

class FixtureExit extends Error {
  constructor(readonly code: number) {
    super(`Guest exited ${code}`);
  }
}
export type ReplyFault =
  | "none"
  | "adapter"
  | "scope"
  | "present"
  | "token"
  | "framing"
  | "exception"
  | "late-exception";

// A protocol-only command runner. It has no GPU or canvas and cannot qualify rendering.
export class FixtureProtocolHost {
  memory = new WebAssembly.Memory({ initial: 4 });
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly commands: Uint8Array[] = [];
  readonly replies: Uint8Array[] = [];
  readonly reads: number[] = [];
  readonly timeouts: bigint[] = [];
  readonly readPresentCounts: number[] = [];
  readonly scopes: number[] = [];
  readonly acquired = new Set<number>();
  readonly presented = new Set<number>();
  closed = false;
  closes = 0;
  credit = false;
  readonly args: Uint8Array[];
  constructor(
    readonly wasm: Uint8Array<ArrayBuffer>,
    args: string[],
    readonly fault: ReplyFault = "none",
    readonly injectExpiredValidation = false,
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
      const texture = view.getUint32(8, true);
      this.acquired.add(texture);
      this.reply("surface-texture", view.getUint32(16, true), {
        texture: handle(texture),
        status: 1,
      });
      return;
    }
    if (opcode === 19) {
      this.scopes.push(1);
      return;
    }
    if (opcode === 10 && this.presented.has(view.getUint32(16, true))) {
      this.lateView();
      return;
    }
    if (opcode === 0x1000 && view.getUint32(8, true) === 8) {
      this.acquired.delete(view.getUint32(12, true));
      return;
    }
    if (opcode === 20) {
      this.reply("error-scope", view.getUint32(8, true), {
        status: 1,
        type: this.fault === "scope" ? 2 : (this.scopes.pop() ?? 1),
        message: "",
      });
      return;
    }
    if (opcode !== 6) return;
    this.credit = true;
    for (const id of this.acquired) this.presented.add(id);
    this.acquired.clear();
    this.reply("present", view.getUint32(8, true), { status: this.fault === "present" ? 2 : 1 });
  }
  lateView(): void {
    // Deliberate reply injection, not a WebGPU validation implementation.
    if (this.fault === "late-exception") {
      this.replies.push(
        encodeGpuCompletion(gpuStream, "call-exception", 0, -28, {
          opcode: 10,
          message: "injected late exception",
        }),
      );
      return;
    }
    if (this.injectExpiredValidation) this.scopes[this.scopes.length - 1] = 2;
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
    this.readPresentCounts.push(this.commands.filter((bytes) => bytes[0] === 6).length);
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
    const instance = new WebAssembly.Instance(new WebAssembly.Module(this.wasm), this.imports());
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

