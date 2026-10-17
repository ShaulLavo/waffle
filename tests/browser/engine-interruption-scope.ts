import { DescriptorTable } from "../../runtime/core/descriptors";
import type { FilesystemIdentity } from "../../runtime/fs";
import { readOutcome } from "../../runtime/proc/outcome";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState } from "../../runtime/proc/worker-client";
import { createRuntimeTerminalCodec } from "../src/runtime-terminals";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost } from "../src/subprocess";
import type { Runtime } from "@bun-wasm/runtime";
import type { Engine } from "../src/worker";

export type EngineInterruptionRoute = "legacy" | "runtimeProcess";
export type EngineSignalDelivery = "host" | "page-kill" | "page-killJob";
export interface EngineInterruptionChild {
  pid: number;
  jobId: number;
  requestedSignal: Int32Array;
  signalState: Int32Array;
  stdout: string;
  stderr: string;
}

export interface EngineInterruptionScope {
  broker: SubprocessBroker;
  children: ReadonlyMap<number, EngineInterruptionChild>;
  spawn(source: string): EngineInterruptionChild;
  drain(child: EngineInterruptionChild): void;
  wait(child: EngineInterruptionChild): number;
  kill(child: EngineInterruptionChild, signal: 2 | 15, delivery?: EngineSignalDelivery): Promise<number>;
  dispose(): void;
}

/** Original test adapter. Admission, descriptor tokens and launchRuntime are the
 * production path; no RunRequest or detached generic budget is manufactured. */
export async function createRuntimeEngineScope(module: WebAssembly.Module, engine: Engine, runtime: Runtime,
  workerUrl = new URL("./engine-interruption-worker.js", location.href).href) {
  const filesystem = runtime.filesystem;
  const descriptors = new DescriptorTable();
  const identities: FilesystemIdentity[] = [];
  const children = new Map<number, EngineInterruptionChild>();
  const outcomes = new Map<number, BigInt64Array>();
  let broker: SubprocessBroker | undefined;
  let active: EngineInterruptionChild | undefined;
  let failure: unknown;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { broker?.dispose(); }
    finally {
      try { descriptors.dispose(); }
      finally { for (const identity of identities) filesystem.revoke(identity); }
    }
  }
  try {
    const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    const identity = filesystem.createIdentity(); identities.push(identity);
    root.data = { filesystem: identity };
    const decoder = new TextDecoder();
    broker = new SubprocessBroker(workerUrl, runtime, {
      output(fd, bytes) {
        if (!active) throw new Error("generic output has no test-owned child");
        if (fd === 2) active.stderr += decoder.decode(bytes); else active.stdout += decoder.decode(bytes);
      },
    });
    runtime.registerProgram("bun", { module, adapter: `bun:${engine}`, cooperative: true });
    for (const fd of [0, 1, 2]) {
      const installed = descriptors.open({ kind: "terminal", read: () => 0,
        write: chunks => chunks.reduce((size, bytes) => size + bytes.length, 0),
        readiness: () => ({ readable: true, writable: true, hangup: fd === 0 }) }, (1n << 29n) - 1n, 0n);
      if (installed !== fd) throw new Error("generic test stdio descriptor mismatch");
    }
    const codec = createRuntimeTerminalCodec({ descriptors, fallback: {
      export() { throw new Error("unexpected non-terminal test descriptor"); },
      import() { throw new Error("unexpected non-terminal test token"); },
      discard() { throw new Error("unexpected non-terminal test token"); },
    } });
    await broker.adoptRuntimeRoot(root);
    const pageBroker = broker;
    const client = new WorkerProcessClient({ transport: root, descriptors, codec,
      prepareSpawn() {
        const filesystemIdentity = filesystem.createIdentity(); identities.push(filesystemIdentity);
        return { data: { filesystem: filesystemIdentity,
          pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } };
      },
      postMessage(message) {
        if (message.operation !== "spawn") throw new Error("unexpected generic test controller operation");
        const state = workerProcessState(message.transport);
        active = { pid: state.pid, jobId: state.job, requestedSignal: state.signals.requestedSignal,
          signalState: state.signals.signalState, stdout: "", stderr: "" };
        children.set(active.pid, active); outcomes.set(active.pid, state.signals.outcome);
        void pageBroker.runtimeMessage(message, client.pid).catch(error => { failure = error; });
      },
    });
    return {
      broker: pageBroker, children,
      spawn(source: string) {
        if (children.size) throw new Error("one generic guest per interruption scope");
        const pid = client.spawn(client.pid, { executable: "bun", argv: ["bun", "-e", source], cwd: "/home/user", env: {}, job: -1,
          fds: [0, 1, 2].map(fd => ({ parent: fd, child: fd })) });
        const child = children.get(pid);
        if (!child) throw new Error("generic admission did not publish child state");
        return child;
      },
      drain(_child: EngineInterruptionChild) { if (failure) throw failure; },
      wait(child: EngineInterruptionChild) { return readOutcome(outcomes.get(child.pid)!)?.status ?? -2; },
      async kill(child: EngineInterruptionChild, signal: 2 | 15, delivery: EngineSignalDelivery = "page-kill") {
        if (delivery === "page-killJob") await pageBroker.killJob(child.jobId, signal);
        else await pageBroker.kill(child.pid, signal);
        return 0;
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}

export function createLegacyEngineScope(module: WebAssembly.Module, engine: Engine, runtime: Runtime,
  workerUrl: string, adapter: "bun" | "preview1" = "bun"): EngineInterruptionScope {
  const fs = runtime.filesystem;
  const decoder = new TextDecoder();
  const pid = runtime.identities.pid(), job = runtime.identities.job();
  const broker = new SubprocessBroker(workerUrl, runtime, { root: { pid, job } });
  // Preview1 here is only our byte-encoded signal-clock fixture: it explicitly
  // handles/dequeues signals through poll_oneoff, not an untrusted guest upload.
  broker.register("bun", adapter === "preview1" ? { module, adapter, cooperative: true } : { module, adapter, engine });
  const children = new Map<number, EngineInterruptionChild>();
  const host = new SubprocessHost({
    pid, jobId: job, identity: runtime.identities.buffer,
    output() {}, onChildClose: childPid => broker.close(pid, childPid),
    launch(meta, transport) {
      const identity = fs.createIdentity();
      children.set(transport.pid, { pid: transport.pid, jobId: transport.jobId,
        requestedSignal: new Int32Array(transport.requestedSignal), signalState: new Int32Array(transport.signalState), stdout: "", stderr: "" });
      broker.spawn({ executable: "bun", argv: meta.argv, pid: transport.pid, parentPid: transport.parentPid,
        jobId: transport.jobId, cwd: "/home/user", env: {}, filesystem: identity, child: transport,
        trace: false, slots: "imports", spawnBroker: true });
      return { revoke() { fs.revoke(identity); }, terminate() {} };
    },
  });
  return { broker, children,
    drain(child) {
      for (const fd of [1, 2]) for (;;) {
        const bytes = host.read(host.pipe(child.pid, fd));
        if (!(bytes instanceof Uint8Array)) break;
        if (fd === 1) child.stdout += decoder.decode(bytes); else child.stderr += decoder.decode(bytes);
      }
    },
    spawn(source) {
      // Signal the guest job without also default-killing this scope's controller.
      // The generic adapter uses the same real production new-job admission.
      const pid = host.spawn(JSON.stringify({ executable: "bun", argv: ["bun", "-e", source], job: -1 }));
      if (pid <= 0) throw new Error(`spawn failed: ${pid}`);
      const child = children.get(pid);
      if (!child) throw new Error("spawn transport missing");
      return child;
    },
    wait: child => host.wait(child.pid),
    async kill(child, signal, delivery = "host") {
      if (delivery === "host") return host.kill(child.pid, signal);
      if (delivery === "page-killJob") await broker.killJob(child.jobId, signal);
      else await broker.kill(child.pid, signal);
      return 0;
    },
    dispose() { broker.dispose(); host.dispose(); },
  };
}
