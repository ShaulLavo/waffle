import { expect, test } from "bun:test";
import { runtimeProcFixture } from "./runtime-proc-fixtures";

test("failed spawn reports its exact negative return and request without changing stage48", () => {
  let memory: WebAssembly.Memory, nextFd = 123;
  const diagnostics: string[] = [];
  let request = "";
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
  const unused = () => { throw new Error("rejected spawn continued guest execution"); };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(runtimeProcFixture()), {
    runtime_proc: {
      read: () => -6,
      write(fd: number, ptr: number, length: number) {
        expect(fd).toBe(2); diagnostics.push(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return length;
      },
      pipe(ptr: number) { const view = new DataView(memory.buffer); view.setUint32(ptr, nextFd++, true); view.setUint32(ptr + 4, nextFd++, true); return 0; },
      dup: (fd: number) => fd + 1000,
      spawn(ptr: number, length: number) { request = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length)); return -28; },
      wait: unused, job_of: unused, poll: unused,
    },
    wasi_snapshot_preview1: {
      args_sizes_get(ptr: number) { new DataView(memory.buffer).setUint32(ptr, 2, true); return 0; },
      fd_close: () => 0, proc_exit(code: number) { throw new Exit(code); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  try { (instance.exports._start as () => void)(); throw new Error("bad spawn was accepted"); }
  catch (error) { expect(error).toBeInstanceOf(Exit); expect((error as Exit).code).toBe(48); }
  expect(diagnostics).toEqual(["runtime-proc-spawn-return: -0000000028\nrequest: ", request]);
  expect(JSON.parse(request).fds).toEqual([{ child: 0, parent: 123 }, { child: 1, parent: 126 },
    { child: 10, parent: 126 }, { child: 2, parent: 2 }, { child: 11, parent: 1 }]);
});

test("artifact-free process guest has only generic ABI and preview1 imports", () => {
  const bytes = runtimeProcFixture();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
  expect(imports.filter(item => item.module === "runtime_proc").map(item => item.name))
    .toEqual(["read", "write", "pipe", "dup", "spawn", "wait", "job_of", "poll"]);
  expect(imports.every(item => item.module === "runtime_proc" || item.module === "wasi_snapshot_preview1")).toBe(true);
});

test("parent fixture keeps byte checks while retrying nonblocking AGAIN and short reads", () => {
  let memory: WebAssembly.Memory;
  let pipe = 0, reads = 0, waits = 0, polls = 0;
  const closed: number[] = [], writes: string[] = [];
  let spawned: unknown;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(runtimeProcFixture()), {
    runtime_proc: {
      read(_fd: number, ptr: number, length: number) {
        reads++;
        const response = [-6, "R", -6, "po", -6, "ng", ""][reads - 1];
        if (typeof response === "number") return response;
        const bytes = new TextEncoder().encode(response);
        expect(length).toBeGreaterThanOrEqual(bytes.length);
        new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
        return bytes.length;
      },
      write(_fd: number, ptr: number, length: number) { writes.push(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return length; },
      pipe(ptr: number) { const view = new DataView(memory.buffer); view.setUint32(ptr, 123 + pipe * 2, true); view.setUint32(ptr + 4, 124 + pipe++ * 2, true); return 0; },
      dup(fd: number) { return fd + 1000; },
      spawn(ptr: number, length: number) { spawned = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return 2; },
      wait(_pid: number, ptr: number) { if (++waits === 1) return -6; const view = new DataView(memory.buffer); view.setUint32(ptr, 0, true); view.setInt32(ptr + 4, 23, true); return 0; },
      job_of() { return 1; },
      poll(ptr: number, count: number, timeout: number, out: number) {
        expect(count).toBe(1); expect(timeout).toBe(5000); polls++;
        const view = new DataView(memory.buffer);
        view.setBigUint64(out, view.getBigUint64(ptr + 8, true), true);
        view.setUint32(out + 8, view.getUint32(ptr, true), true);
        view.setUint32(out + 12, polls === 5 ? 1 : 0, true);
        return 1;
      },
    },
    wasi_snapshot_preview1: {
      args_sizes_get(ptr: number) { new DataView(memory.buffer).setUint32(ptr, 2, true); return 0; },
      fd_close(fd: number) { closed.push(fd); return 0; },
      proc_exit(code: number) { throw new Error(`fixture exited at stage ${code}`); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._start as () => void)();
  expect(spawned).toEqual({ executable: "bun", argv: ["abi-child"], env: { PWD: "/" }, cwd: "/", job: 1,
    fds: [{ child: 0, parent: 123 }, { child: 1, parent: 126 }, { child: 10, parent: 126 }, { child: 2, parent: 2 }, { child: 11, parent: 1 }] });
  expect(closed).toEqual([124, 125, 123, 126, 1124, 1125]);
  expect(writes).toEqual(["ping", "runtime-proc-ok\n"]);
  expect(reads).toBe(7); expect(waits).toBe(2); expect(polls).toBe(6);
});

test("child fixture closes its inherited alias, waits for stdin EOF and exits with status 23", () => {
  let memory: WebAssembly.Memory;
  let reads = 0, polls = 0;
  const closed: number[] = [], writes: string[] = [];
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
  const unused = () => { throw new Error("child called a parent-only import"); };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(runtimeProcFixture()), {
    runtime_proc: {
      read(fd: number, ptr: number, length: number) {
        expect(fd).toBe(0); reads++;
        if (reads === 1) return -6;
        if (reads === 4) return 0;
        const bytes = new TextEncoder().encode(reads === 2 ? "pi" : "ng");
        expect(length).toBe(reads === 2 ? 4 : 2); new Uint8Array(memory.buffer, ptr, 2).set(bytes); return 2;
      },
      write(fd: number, ptr: number, length: number) {
        expect(fd).toBe(writes.length < 2 ? 10 : writes.length === 2 ? 11 : 2);
        writes.push(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length))); return length;
      },
      pipe: unused, dup: unused, spawn: unused, wait: unused, job_of: unused,
      poll(ptr: number, count: number, timeout: number, out: number) {
        expect(count).toBe(1); expect(timeout).toBe(5000); polls++;
        const view = new DataView(memory.buffer);
        view.setBigUint64(out, view.getBigUint64(ptr + 8, true), true);
        view.setUint32(out + 8, view.getUint32(ptr, true), true);
        view.setUint32(out + 12, polls === 3 ? 1 : 0, true); return 1;
      },
    },
    wasi_snapshot_preview1: {
      args_sizes_get(ptr: number) { new DataView(memory.buffer).setUint32(ptr, 1, true); return 0; },
      fd_close(fd: number) { closed.push(fd); return 0; }, proc_exit(code: number) { throw new Exit(code); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  try { (instance.exports._start as () => void)(); throw new Error("child returned instead of calling proc_exit"); }
  catch (error) { expect(error).toBeInstanceOf(Exit); expect((error as Exit).code).toBe(23); }
  expect(writes).toEqual(["R", "pong", "child-stdout\n", "child-stderr\n"]); expect(closed).toEqual([1, 0, 10, 11, 2]);
  expect(reads).toBe(4); expect(polls).toBe(3);
});

for (const returned of [0, -8]) test(`child fixture still fails early EOF or unexpected read errno (${returned})`, () => {
  let memory: WebAssembly.Memory;
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(runtimeProcFixture()), {
    runtime_proc: {
      read: () => returned, write: (_fd: number, _ptr: number, length: number) => length,
      pipe: () => 0, dup: () => 0, spawn: () => 0, wait: () => 0, job_of: () => 0,
      poll(ptr: number, _count: number, _timeout: number, out: number) {
        const view = new DataView(memory.buffer);
        view.setBigUint64(out, view.getBigUint64(ptr + 8, true), true);
        view.setUint32(out + 8, view.getUint32(ptr, true), true); view.setUint32(out + 12, 0, true); return 1;
      },
    },
    wasi_snapshot_preview1: {
      args_sizes_get(ptr: number) { new DataView(memory.buffer).setUint32(ptr, 1, true); return 0; },
      fd_close: () => 0, proc_exit(code: number) { throw new Exit(code); },
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  try { (instance.exports._start as () => void)(); throw new Error("bad child read was accepted"); }
  catch (error) { expect(error).toBeInstanceOf(Exit); expect((error as Exit).code).toBe(83); }
});
