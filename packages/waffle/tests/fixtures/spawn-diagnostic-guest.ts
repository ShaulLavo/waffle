import type { ProcessABI } from "../../proc/abi.ts";

const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
const spawn = [0, 0x20, 0, 0x20, 1, 0x10, 0, 0x0b];
const diagnostic = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x10, 1, 0x0b];
const module = new WebAssembly.Module(
  new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
      section(
        2,
        [3].concat(
          text("runtime_proc"),
          text("spawn"),
          [0, 0],
          text("runtime_proc"),
          text("spawn_error"),
          [0, 1],
          text("env"),
          text("memory"),
          [2, 0, 1],
        ),
      ),
      section(3, [2, 0, 1]),
      section(7, [2].concat(text("spawn"), [0, 2], text("spawn_error"), [0, 3])),
      section(10, [2, spawn.length].concat(spawn, [diagnostic.length], diagnostic)),
    ),
  ),
);

export function spawnDiagnosticGuest(abi: ProcessABI, memory: WebAssembly.Memory) {
  const instance = new WebAssembly.Instance(module, { runtime_proc: abi.imports, env: { memory } });
  return instance.exports as {
    spawn(ptr: number, length: number): number;
    spawn_error(pid: number, ptr: number, capacity: number): number;
  };
}
