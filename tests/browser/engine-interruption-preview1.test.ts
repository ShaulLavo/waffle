import { expect, test } from "bun:test";
import { WasiExit } from "../../runtime/core";
import { preview1SignalClockGuest } from "./engine-interruption-preview1";

function fixture(firstPollErrno = 27) {
  let memory: WebAssembly.Memory;
  let polls = 0, dequeues = 0;
  const output: string[] = [];
  const instance = new WebAssembly.Instance(new WebAssembly.Module(preview1SignalClockGuest()), {
    runtime_proc: {
      signal(signal: number, mode: number) { expect([signal, mode]).toEqual([2, 2]); return 0; },
      interrupted() { return dequeues++ === 0 ? 2 : 0; },
    },
    wasi_snapshot_preview1: {
      fd_write(fd: number, iov: number) {
        expect(fd).toBe(2);
        const view = new DataView(memory.buffer), pointer = view.getUint32(iov, true), size = view.getUint32(iov + 4, true);
        output.push(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, size)));
        return 0;
      },
      poll_oneoff(pointer: number, _out: number, count: number, events: number) {
        const view = new DataView(memory.buffer);
        expect(count).toBe(1);
        expect(view.getUint8(pointer + 8)).toBe(0);
        expect(view.getBigUint64(pointer + 24, true)).toBe(polls ? 10_000_000n : 5_000_000_000n);
        view.setUint32(events, 1, true);
        return polls++ ? 0 : firstPollErrno;
      },
      proc_exit(code: number): never { throw new WasiExit(code); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  return { instance, output, polls: () => polls };
}

test("original Preview1 guest uses only signal runtime imports and asserts EINTR then a clean clock poll", () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(preview1SignalClockGuest()));
  expect(imports.filter(entry => entry.module === "runtime_proc").map(entry => entry.name)).toEqual(["signal", "interrupted"]);
  const state = fixture();
  try { (state.instance.exports._start as Function)(); throw new Error("guest did not exit"); }
  catch (error) { expect(error).toBeInstanceOf(WasiExit); expect((error as WasiExit).code).toBe(23); }
  expect(state.output).toEqual(["ready\n", "poll-eintr\n", "poll-clean\n"]);
  expect(state.polls()).toBe(2);
});

test("Preview1 guest rejects a clock timeout masquerading as signal interruption", () => {
  const state = fixture(0);
  try { (state.instance.exports._start as Function)(); throw new Error("guest did not reject missing EINTR"); }
  catch (error) { expect(error).toBeInstanceOf(WasiExit); expect((error as WasiExit).code).toBe(102); }
  expect(state.output).toEqual(["ready\n"]);
});
