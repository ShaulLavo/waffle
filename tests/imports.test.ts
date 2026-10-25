import { expect, test } from "bun:test";
import { Wasi } from "../core/index";
import { MemFS } from "../fs/memory";

const enc = new TextEncoder();
const name = (text: string) => [text.length].concat(Array.from(enc.encode(text)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
function guest(namespace: string, field: string, memory = false) {
  const imported = name(namespace).concat(name(field), memory ? [2, 1, 1, 2] : [0, 0]);
  return new WebAssembly.Module(
    new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 0, 1, 0x7f]),
        section(2, [1].concat(imported)),
      ),
    ),
  );
}
function host(options: Partial<import("../core/wasi.js").WasiOptions> = {}) {
  return new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    ...options,
  });
}

test("unknown namespaces fail during linking, not later as fabricated errno stubs", () => {
  expect(() => host().imports(guest("unknown", "call"))).toThrow("unknown.call");
});
test("unknown preview1 names fail during linking", () => {
  expect(() => host().imports(guest("wasi_snapshot_preview1", "not_a_syscall"))).toThrow(
    "not_a_syscall",
  );
});
test("explicit adapter namespaces supply only declared imports", () => {
  const call = () => 42;
  const h = host({ namespaces: { runtime_proc: { call } } });
  const module = guest("runtime_proc", "call");
  const imported = h.imports(module).runtime_proc!.call;
  if (typeof imported !== "function") throw new Error("missing imported function");
  expect(imported()).toBe(42);
  expect(() => h.imports(guest("runtime_proc", "absent"))).toThrow("runtime_proc.absent");
});
test("imported memory is explicit and is used without a memory export", () => {
  const module = guest("env", "memory", true);
  expect(() => host().imports(module)).toThrow("env.memory");
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const h = host({ namespaces: { env: { memory } } });
  new WebAssembly.Instance(module, h.imports(module));
  h.start({ exports: { _start() {} } });
  expect(h["functions"]().clock_time_get(0, 0n, 0)).toBe(0);
  expect(new DataView(memory.buffer).getBigUint64(0, true)).toBeGreaterThan(0n);
});

test("namespace and import lookup ignore inherited object properties", () => {
  expect(() => host({ namespaces: {} }).imports(guest("__proto__", "toString"))).toThrow(
    "__proto__.toString",
  );
  expect(() => host().imports(guest("wasi_snapshot_preview1", "toString"))).toThrow("toString");
});

test("binding memory is idempotent and rejects replacement before mutating host views", () => {
  const h = host();
  const first = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const second = new WebAssembly.Memory({ initial: 1 });
  h.bindMemory(first);
  h.bindMemory(first);
  expect(() => h.bindMemory(second)).toThrow("cannot replace");
  const tick = h["functions"]().clock_time_get;
  expect(tick(0, 0n, 0)).toBe(0);
  expect(new DataView(first.buffer).getBigUint64(0, true)).toBeGreaterThan(0n);
  expect(new DataView(second.buffer).getBigUint64(0, true)).toBe(0n);
  first.grow(0);
  expect(tick(0, 0n, 8)).toBe(0);
  first.grow(1);
  expect(tick(0, 0n, 65536)).toBe(0);
});

test("per-member env imports cannot supply missing process or WASI functions", () => {
  const h = host();
  expect(() => h.imports(guest("runtime_proc", "fake"), { env: { fake: () => 0 } })).toThrow(
    "runtime_proc.fake",
  );
  expect(() =>
    h.imports(guest("wasi_snapshot_preview1", "fake"), { env: { fake: () => 0 } }),
  ).toThrow("fake");
});
