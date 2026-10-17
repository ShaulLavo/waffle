import { expect, test } from "bun:test";
import { Wasi } from "../../runtime/core/wasi";
import { MemFS } from "../../runtime/fs/memory";
import { outcomeWord } from "../../runtime/proc/outcome";
import { ProcessABI } from "../../runtime/proc/abi";
import { createSignalState, requestSignal } from "../../runtime/proc/signals";
import { SubprocessHost } from "../src/subprocess";

for (const mode of ["legacy", "generic"] as const) test(`${mode} dequeue preserves later pending signals and releases the final WASI wait`, () => {
  const signals = { signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)),
    requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord() };
  const host = new SubprocessHost({ ...signals, output() {}, launch() { throw new Error("unexpected launch"); } });
  const memory = new WebAssembly.Memory({ initial: 1 });
  let waits = 0;
  const fs = new MemFS();
  const wasi = new Wasi({ fs, args: [], env: {}, preopens: {}, interrupt: signals.interrupt,
    stdout() {}, stderr() {}, sleep() { throw new Error("shared interrupt must select a native wait"); },
    wait(word, expected, milliseconds) { waits++; Atomics.wait(word, 0, expected, milliseconds); } });
  const unused = (): never => { throw new Error("unexpected service operation"); };
  const abi = new ProcessABI({ memory, descriptors: wasi.descriptors, fs, pid: 1, signals,
    service: { spawn: unused, wait: unused, kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused } });
  const signal = mode === "legacy" ? host.signal.bind(host) : abi.imports.signal!;
  const imports = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions();
  wasi.start({ exports: { memory, _start() {} } } as unknown as WebAssembly.Instance);
  const clock = (timeout = 0n) => {
    const view = new DataView(memory.buffer);
    view.setUint8(8, 0); view.setUint32(16, 1, true); view.setBigUint64(24, timeout, true);
    return imports.poll_oneoff!(0, 128, 1, 256);
  };
  try {
    signal(2, 2); signal(15, 2);
    requestSignal(signals, 2); requestSignal(signals, 15);
    expect(clock()).toBe(27);
    expect(signal(0, 4)).toBe(0);
    expect(Atomics.load(signals.interrupt, 0)).toBe(15);
    expect(signal(0, 0)).toBe(2);
    expect(clock()).toBe(27);
    expect(signal(0, 0)).toBe(15);
    expect(Atomics.load(signals.interrupt, 0)).toBe(0);
    expect(signal(0, 0)).toBe(0);
    expect(clock()).toBe(0);
    expect(waits).toBe(0);
    expect(clock(1_000_000n)).toBe(0);
    expect(waits).toBeGreaterThan(0);
  } finally { host.dispose(); wasi.descriptors.dispose(); }
});
