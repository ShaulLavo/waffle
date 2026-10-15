import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { MemFS } from "../src/fs";
import { memoryViews } from "../src/memory-views.js";
import { HOST_CALL_FD } from "../src/net/trampoline";
import { Wasi } from "../src/wasi";

const wasm = new URL("../../dist/bun.wasm", import.meta.url);
for (const fallback of [false, true]) {
  test.skipIf(!existsSync(wasm))(`WASI reacquires memory after a growing host callback (fallback=${fallback})`, () => {
    const wasi = new Wasi({ args: ["bun", "--version"], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {} });
    const module = new WebAssembly.Module(readFileSync(wasm));
    const imports = wasi.imports(module);
    const instance = new WebAssembly.Instance(module, imports);
    const memory = instance.exports.memory;
    if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
    expect(wasi.start(instance)).toBe(0);
    const views = memoryViews(memory);
    const end = memory.buffer.byteLength;
    const saved = views.view().getInt32(0, true);
    views.view().setInt32(0, 7, true);
    wasi.hostCall = (slot) => {
      expect(slot).toBe(7);
      memory.grow(1);
      return 42;
    };
    expect(imports.wasi_snapshot_preview1.sock_send(HOST_CALL_FD, 0, 5, 0, end + 8)).toBe(0);
    expect(views.view().getInt32(end + 8, true)).toBe(42);
    views.view().setInt32(0, saved, true);
  });
}
