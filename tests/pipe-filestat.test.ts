import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { PipeController } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { browserPipeFilestat } from "./pipe-filestat-browser.js";
import {
  assertPipeFilestat,
  pipeFilestatModule,
  pipeReadRights,
  pipeWriteRights,
  type PipeFilestatGuest,
} from "./fixtures/pipe-filestat-guest.js";

test("pipe metadata rights and filestat survive local supervisor inheritance without widening", () => {
  const fs = new MemFS();
  const processImports: Record<string, (...args: number[]) => number> = {};
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: {},
    namespaces: { runtime_proc: processImports },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("not started");
    },
  });
  const pid = supervisor.createRoot({ descriptors: wasi.descriptors });
  const abi = new ProcessABI({
    memory: () => guest.memory,
    descriptors: wasi.descriptors,
    fs,
    pid,
    service: supervisor,
    signals: supervisor.get(pid)!,
  });
  const module = pipeFilestatModule();
  Object.assign(processImports, abi.imports);
  const imports = wasi.imports(module);
  const instance = new WebAssembly.Instance(module, imports);
  const guest = instance.exports as unknown as PipeFilestatGuest;
  const childWasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: {},
    namespaces: { runtime_proc: { pipe: () => -52, spawn: () => -52 } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  try {
    wasi.start(instance);
    expect(guest.pipe(32)).toBe(0);
    const view = new DataView(guest.memory.buffer),
      read = view.getUint32(32, true),
      write = view.getUint32(36, true);
    assertPipeFilestat(guest, read, pipeReadRights);
    assertPipeFilestat(guest, write, pipeWriteRights);
    const request = new TextEncoder().encode(
      JSON.stringify({
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: 0,
        fds: [
          { parent: read, child: 17 },
          { parent: write, child: 18 },
        ],
      }),
    );
    new Uint8Array(guest.memory.buffer).set(request, 1024);
    const child = guest.spawn(1024, request.length);
    expect(child).toBeGreaterThan(0);
    const bindings = supervisor.get(child)!.descriptors;
    for (const [target, source] of [
      [17, read],
      [18, write],
    ]) {
      childWasi.descriptors.inherit(target!, bindings.get(target!)!);
      wasi.descriptors.close(source!);
    }
    const childInstance = new WebAssembly.Instance(module, childWasi.imports(module));
    childWasi.start(childInstance);
    const childGuest = childInstance.exports as unknown as PipeFilestatGuest;
    assertPipeFilestat(childGuest, 17, pipeReadRights);
    assertPipeFilestat(childGuest, 18, pipeWriteRights);
    // The syscall remains capability-checked: removing the new right still denies metadata.
    childWasi.descriptors.get(17)!.rightsBase &= ~(1n << 21n);
    expect(childGuest.fd_filestat_get(17, 256)).toBe(76);
  } finally {
    childWasi.descriptors.dispose();
    supervisor.dispose();
    wasi.descriptors.dispose();
  }
});

test("stdio pipe bindings already allow filestat without changing their rights", () => {
  const pipe = new PipeController();
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdio: { 0: pipe.retain(1, "read"), 1: pipe.retain(1, "write") },
    namespaces: { runtime_proc: { pipe: () => -52, spawn: () => -52 } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  try {
    const module = pipeFilestatModule(),
      instance = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(instance);
    const guest = instance.exports as unknown as PipeFilestatGuest;
    for (const fd of [0, 1]) {
      expect(guest.fd_filestat_get(fd, 256)).toBe(0);
      expect(new DataView(guest.memory.buffer).getUint8(272)).toBe(0);
      expect(wasi.descriptors.get(fd)!.rightsBase & (1n << 21n)).toBe(1n << 21n);
    }
  } finally {
    wasi.descriptors.dispose();
    pipe.dispose();
  }
});

test("guest pipe filestat survives transfer to a real child Worker after parent close", async () => {
  await browserPipeFilestat(new URL("./fixtures/pipe-filestat-worker.ts", import.meta.url).href);
}, 15_000);
