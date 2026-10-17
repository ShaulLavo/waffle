import { expect, test } from "bun:test";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest, WorkerMessage } from "../src/worker";
import { workerProcessState } from "../../runtime/proc/worker-client";
import { createLegacyEngineScope, createRuntimeEngineScope } from "./engine-interruption-scope";
import { setSignalDisposition, takeSignal } from "../../runtime/proc/signals";
import { preview1SignalClockGuest } from "./engine-interruption-preview1";

// Exercise the actual page-side production admission and launchRuntime. This is
// structural harness coverage; real interpreters and native waits run in browsers.
test("generic engine scope reaches real launchRuntime without legacy ChildTransport", async () => {
  const NativeWorker = globalThis.Worker;
  const workers: FakeWorker[] = [], ports: MessagePort[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    onerror = null;
    request?: RunRequest;
    stopped = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) { this.request = request; }
    terminate() { this.stopped = true; }
  }
  const identity = createFilesystemIdentity();
  const fs = { client: { connection: identity, sweep() {} }, revoke: revokeFilesystem, reap() {},
    async quiesce(value: typeof identity) { revokeFilesystem(value); },
    connect(value: typeof identity) {
      const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
      return { ...value, port: channel.port1 };
    },
  } as unknown as SharedFilesystem;
  let owned: Awaited<ReturnType<typeof createRuntimeEngineScope>> | undefined;
  // Arm teardown before substituting Worker or allocating the scope.
  try {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    owned = await createRuntimeEngineScope(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), "quickjs", fs,
      "http://localhost/engine-interruption-worker.js");
    const child = owned.spawn("fixture-source");
    const deadline = Date.now() + 2_000;
    while (!workers[0]?.request) {
      if (Date.now() > deadline) throw new Error("real generic launchRuntime was not reached");
      await Bun.sleep(1);
    }
    const worker = workers[0]!, request = worker.request!;
    expect(request.child).toBeUndefined();
    expect(request.runtimeProcess).toBeDefined();
    expect(request.budget).toBeInstanceOf(SharedArrayBuffer);
    expect(request.args).toEqual(["bun", "-e", "fixture-source"]);
    expect(request.pid).toBe(child.pid);
    const state = workerProcessState(request.runtimeProcess!);
    expect(child.signalState.buffer).toBe(state.signals.signalState.buffer);
    expect(child.signalState.byteOffset).toBe(state.signals.signalState.byteOffset);
    expect(request.runtimeProcess!.bindings.map(binding => binding.fd)).toEqual([0, 1, 2]);
    const text = new TextEncoder();
    worker.onmessage!({ data: { type: "stderr", data: text.encode("ready\n") } } as MessageEvent<WorkerMessage>);
    expect(child.stderr).toBe("ready\n");
    worker.onmessage!({ data: { type: "exit", code: 23 } } as MessageEvent<WorkerMessage>);
    expect((await owned.broker.wait(child.pid)).code).toBe(23);
    expect(owned.wait(child)).toBe(23);
  } finally {
    owned?.dispose();
    for (const port of ports) port.close();
    globalThis.Worker = NativeWorker;
    revokeFilesystem(identity);
  }
  expect(workers.every(worker => worker.stopped)).toBe(true);
});

for (const route of ["legacy", "runtimeProcess", "owned-preview1"] as const) {
  test(`${route} page killJob handles the guest without killing its waiting controller`, async () => {
    const NativeWorker = globalThis.Worker;
    const workers: FakeWorker[] = [], ports: MessagePort[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
      onerror = null;
      request?: RunRequest;
      stopped = false;
      constructor() { workers.push(this); }
      postMessage(request: RunRequest) { this.request = request; }
      terminate() { this.stopped = true; }
    }
    const identity = createFilesystemIdentity();
    const fs = { client: { connection: identity, sweep() {} }, revoke: revokeFilesystem, reap() {},
      async quiesce(value: typeof identity) { revokeFilesystem(value); },
      connect(value: typeof identity) {
        const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
        return { ...value, port: channel.port1 };
      },
    } as unknown as SharedFilesystem;
    let owned: Awaited<ReturnType<typeof createRuntimeEngineScope>> | ReturnType<typeof createLegacyEngineScope> | undefined;
    try {
      globalThis.Worker = FakeWorker as unknown as typeof Worker;
      const module = new WebAssembly.Module(route === "owned-preview1" ? preview1SignalClockGuest()
        : new Uint8Array([0,97,115,109,1,0,0,0]));
      const url = "http://localhost/engine-interruption-worker.js";
      owned = route === "runtimeProcess" ? await createRuntimeEngineScope(module, "quickjs", fs, url)
        : createLegacyEngineScope(module, route === "owned-preview1" ? "browser" : "quickjs", fs, url,
          route === "owned-preview1" ? "preview1" : "bun");
      const child = owned.spawn("fixture-source");
      const deadline = Date.now() + 2_000;
      while (!workers[0]?.request) {
        if (Date.now() > deadline) throw new Error("real production guest launch was not reached");
        await Bun.sleep(1);
      }
      const request = workers[0]!.request!;
      expect(request.module).toBe(module);
      expect(request.interruptible).not.toBe(true);
      expect(request.adapter).toBe(route === "owned-preview1" ? "preview1" : "bun");
      if (route === "owned-preview1") {
        expect(WebAssembly.Module.imports(request.module)).toContainEqual({ module: "runtime_proc", name: "interrupted", kind: "function" });
      }
      const supervisor = await owned.broker.ready();
      const root = supervisor.get(1)!;
      setSignalDisposition(child.signalState, 2, 2);
      await owned.kill(child, 2, "page-killJob");
      expect(takeSignal(child.signalState)).toBe(2);
      // A real page job signal must not also default-kill the test's waiter.
      expect(root.result).toBeNull();
      workers[0]!.onmessage!({ data: { type: "exit", code: 23 } } as MessageEvent<WorkerMessage>);
      expect((await owned.broker.wait(child.pid))).toMatchObject({ kind: "exited", code: 23 });
      expect(owned.wait(child)).toBe(23);
      expect(child.jobId).not.toBe(root.job);
    } finally {
      owned?.dispose();
      for (const port of ports) port.close();
      globalThis.Worker = NativeWorker;
      revokeFilesystem(identity);
    }
    expect(workers.every(worker => worker.stopped)).toBe(true);
  });
}
