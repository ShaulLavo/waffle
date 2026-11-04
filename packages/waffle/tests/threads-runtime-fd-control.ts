import assert from "node:assert/strict";
import { createRuntime } from "../runtime.ts";
import { BrowserProcessBroker } from "../browser/process-broker.ts";
import { DescriptorTable } from "../core/descriptors.ts";
import { RIGHTS_ALL } from "../core/rights.ts";
import { FilesystemClient } from "../fs/client.ts";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec.ts";
import { PipeController } from "../proc/pipes.ts";
import { createWorkerPipeCodec } from "../proc/worker-pipes.ts";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.ts";
import { bytes, declareSharedMemoryPlatform } from "../memory/index.ts";
import type { GuestWorkerEvent } from "../thread/guest-worker.ts";
import type { ThreadServiceEvent } from "../thread/runtime-protocol.ts";
import type { FdServiceEvent } from "./threads-runtime-fd-service.ts";
import { descriptorModule, fdLayout, type DescriptorCase } from "./threads-runtime-fd-module.ts";

type ObservedEvent =
  | FdServiceEvent
  | GuestWorkerEvent
  | ThreadServiceEvent
  | { kind: "fd-held"; operation: string; args: unknown[] }
  | { kind: "fd-released" | "fd-armed" };
type Completed = Extract<FdServiceEvent, { kind: "fd-completed" }>;
const selected = process.argv[2];
if (selected !== "read" && selected !== "write") throw new Error("expected read or write");

function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function run(selected: DescriptorCase) {
  const NativeWorker = globalThis.Worker;
  const workers: Worker[] = [];
  const stopped = new Set<Worker>();
  const events: ObservedEvent[] = [];
  const changes = new Set<() => void>();
  const targets = new WeakMap<Worker, string>();
  const filesystemWorker = () =>
    workers.find((worker) => targets.get(worker)?.includes("threads-runtime-fd-filesystem"));
  let memory: WebAssembly.Memory | undefined;
  function observe(event: MessageEvent<ObservedEvent>) {
    if (!("kind" in event.data)) return;
    events.push(event.data);
    for (const changed of changes) changed();
  }
  function until(predicate: () => boolean, label: string): Promise<void> {
    const done = Promise.withResolvers<void>();
    const changed = () => {
      if (predicate()) done.resolve();
    };
    changes.add(changed);
    changed();
    return deadline(done.promise, label).finally(() => changes.delete(changed));
  }
  function completed(kind: string, fd: number, address?: number): Completed[] {
    return events
      .filter((event): event is Completed => event.kind === "fd-completed")
      .filter(
        ({ request }) =>
          request.kind === kind &&
          request.fd === fd &&
          (address === undefined || ("spans" in request && request.spans[0]?.address === address)),
      );
  }
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.push(this);
      targets.set(this, String(url));
      this.addEventListener("message", observe);
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if (
        message &&
        typeof message === "object" &&
        "kind" in message &&
        message.kind === "thread-service" &&
        "memory" in message &&
        message.memory instanceof WebAssembly.Memory
      ) {
        assert.equal(memory, undefined, "exactly one canonical service initialization");
        memory = message.memory;
      }
      if (transfer === undefined) return super.postMessage(message);
      if (Array.isArray(transfer)) return super.postMessage(message, transfer);
      return super.postMessage(message, transfer);
    }
    override terminate() {
      assert.equal(stopped.has(this), false, "each native Worker stops exactly once");
      stopped.add(this);
      return super.terminate();
    }
  };
  const errors: string[] = [];
  let filesystem: ConstructorParameters<typeof BrowserProcessBroker>[0]["filesystem"] | undefined;
  const runtime = createRuntime({
    sharedMemory: declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
    filesystem: {
      mode: "memory",
      workerURL: new URL("./threads-runtime-fd-filesystem.ts", import.meta.url),
    },
    processHost: (options) => {
      filesystem = options.filesystem;
      return new BrowserProcessBroker({
        ...options,
        onError: (error) => errors.push(String(error)),
      });
    },
  });
  const descriptors = new DescriptorTable();
  const input = new PipeController({ relay: "manual" });
  const output = new PipeController({ relay: "manual" });
  let files: FilesystemClient | undefined;
  let disposed = false;
  try {
    runtime.registerAdapter("fd-proof", (context, service) =>
      service.launchWorker(context, {
        workerUrl: new URL("../browser/preview1-worker.ts", import.meta.url).href,
        threaded: {
          serviceWorkerUrl: new URL("./threads-runtime-fd-service.ts", import.meta.url).href,
          guestWorkerUrl: new URL("../thread/guest-bootstrap.ts", import.meta.url).href,
        },
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      }),
    );
    runtime.registerProgram("/fd-proof", {
      adapter: "fd-proof",
      source: descriptorModule(selected),
    });
    await runtime.filesystem.writeFile("/fd-proof", "registered");
    await runtime.filesystem.writeFile("/original", "ABCDEFGHIJ");
    await runtime.filesystem.writeFile("/replacement", "1234567890");
    const service = await runtime.processes();
    const supervisor = await service.ready();
    assert(filesystem);
    const root = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
      capacity: 8,
    });
    const identity = runtime.filesystem.createIdentity();
    root.data = { filesystem: identity };
    files = new FilesystemClient(filesystem.connect(identity));
    const preopen: number = await files.asyncCall("preopen", ["/"]);
    for (const [fd, name] of [
      [4, "original"],
      [5, "replacement"],
    ] as const) {
      const { node: handle }: { node: number } = await files.asyncCall("resolve", [preopen, name]);
      files.retain(handle);
      descriptors.openAt(
        fd,
        { kind: "file", handle, offset: 0, append: false },
        RIGHTS_ALL,
        RIGHTS_ALL,
        () => files?.release(handle),
      );
    }
    const inputWriter = input.retain(root.pid, "write");
    const outputReader = output.retain(root.pid, "read");
    descriptors.openAt(0, input.retain(root.pid, "read"), RIGHTS_ALL, RIGHTS_ALL);
    descriptors.openAt(1, output.retain(root.pid, "write"), RIGHTS_ALL, RIGHTS_ALL);
    const notices: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: createWorkerPipeCodec(),
      postMessage: (message) => notices.push(message),
      prepareSpawn: () => {
        const target = runtime.filesystem.createIdentity();
        return {
          data: { filesystem: target },
          codec: createWorkerPipeCodec({
            fallback: createFilesystemDescriptorCodec(files, target),
          }),
        };
      },
    });
    await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
    const fsWorker = filesystemWorker();
    assert(fsWorker);
    fsWorker.postMessage({ kind: "fd-arm", selected });
    await until(() => events.some((event) => event.kind === "fd-armed"), "filesystem arm");
    const pid = client.spawn(root.pid, {
      executable: "/fd-proof",
      argv: ["fd-proof"],
      env: {},
      cwd: "/",
      job: -1,
      fds: [0, 1, 4, 5].map((fd) => ({ parent: fd, child: fd })),
    });
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
    await supervisor.start(pid);
    await until(
      () => events.some((event) => event.kind === "fd-held"),
      "real file preparation held",
    );
    assert(memory);
    const heldEvent = events.find((event) => event.kind === "fd-held");
    assert(heldEvent?.kind === "fd-held");
    const inherited = descriptors.get(4)?.resource;
    assert(inherited?.kind === "file");
    assert.equal(heldEvent.operation, selected);
    assert.deepEqual(
      heldEvent.args,
      selected === "read" ? [inherited.handle, 2, 0] : [inherited.handle, 0],
    );
    const ready = events.filter((event) => event.kind === "ready");
    assert.equal(ready.length, 2);
    assert.deepEqual(
      ready.map((event) => event.thread.pid),
      [pid, pid],
    );
    assert.deepEqual(
      ready.map((event) => event.thread.tid),
      [1, 2],
    );
    const guestMemory = memory;
    const view = new DataView(guestMemory.buffer);
    const text = (address: number, length: number) =>
      new TextDecoder().decode(new Uint8Array(guestMemory.buffer, address, length));
    const cursorProof = {
      first: text(288, 2),
      firstCount: view.getUint32(264, true),
      firstCursor: Number(view.getBigUint64(272, true)),
      child: text(352, 2),
      childCount: view.getUint32(328, true),
      childCursor: Number(view.getBigUint64(336, true)),
      childSeek: Number(view.getBigUint64(344, true)),
      childWrite: view.getUint32(648, true),
      writtenCursor: Number(view.getBigUint64(656, true)),
      resumed: text(416, 2),
      resumedCount: view.getUint32(392, true),
      resumedCursor: Number(view.getBigUint64(400, true)),
      resetCursor: Number(view.getBigUint64(408, true)),
    };
    assert.deepEqual(cursorProof, {
      first: "AB",
      firstCount: 2,
      firstCursor: 2,
      child: "CD",
      childCount: 2,
      childCursor: 4,
      childSeek: 5,
      childWrite: 2,
      writtenCursor: 7,
      resumed: "HI",
      resumedCount: 2,
      resumedCursor: 9,
      resetCursor: 0,
    });
    const heldAddress = fdLayout.held + 32;
    assert.equal(completed(selected, 4, heldAddress).length, 0);
    assert.equal(inputWriter.tryWrite([new Uint8Array([90])]), 1);
    await until(() => completed("write", 1, 992).length === 1, "sibling pipe and reuse progress");
    const pipeBytes = new Uint8Array(3);
    assert.equal(outputReader.tryRead([pipeBytes.subarray(0, 1)]), 1);
    assert.equal(outputReader.tryRead([pipeBytes.subarray(1, 2)]), 1);
    assert.equal(new TextDecoder().decode(pipeBytes.subarray(0, 2)), "PR");
    assert.equal(
      completed(selected, 4, heldAddress).length,
      0,
      "original still pending after reuse",
    );
    const beforeRelease = completed("tell", 4).at(-1)?.original;
    assert.deepEqual(beforeRelease, { references: 1, offset: 0 });
    assert.equal(view.getUint32(776, true), 1);
    assert.equal(text(800, 1), "Z");
    assert.equal(text(544, 2), "12");
    assert.equal(Number(view.getBigUint64(528, true)), 0);
    assert.equal(Number(view.getBigUint64(912, true)), 3);
    assert.equal(view.getUint32(456, true), 0, "pending file count not published");
    fsWorker.postMessage({ kind: "fd-release" });
    await until(
      () => completed("write", 1, 736).length === 1,
      "original pin retires after file completion",
    );
    assert.equal(outputReader.tryRead([pipeBytes.subarray(2)]), 1);
    assert.equal(new TextDecoder().decode(pipeBytes), "PRM");
    const originalCompletions = completed(selected, 4, heldAddress);
    assert.equal(originalCompletions.length, 1);
    const originalCompletion = originalCompletions[0];
    assert.deepEqual(originalCompletion?.result, { kind: "ok", value: 2 });
    assert.deepEqual(originalCompletion?.original, { references: 0, offset: 2 });
    assert.equal(view.getUint32(456, true), 2);
    assert.equal(text(480, 2), selected === "read" ? "AB" : "UV");
    assert.equal(Number(view.getBigUint64(464, true)), 3, "main sees the replacement cursor");
    assert.equal(text(608, 1), "4");
    assert.equal(view.getUint32(584, true), 1);
    assert.equal(Number(view.getBigUint64(592, true)), 4);
    const resume = (address: number) => {
      const words = new Int32Array(guestMemory.buffer);
      Atomics.store(words, address / 4, 1);
      Atomics.notify(words, address / 4);
    };
    resume(fdLayout.childRelease);
    await until(
      () => events.some((event) => event.kind === "host-idle" && event.thread.tid === 2),
      "real sibling idle",
    );
    resume(fdLayout.mainRelease);
    const exit = await deadline(supervisor.waitForExit(root.pid, pid), "real Runtime exit");
    assert.deepEqual(exit, { kind: "exited", code: 0, status: 0 });
    const originalBytes = new TextDecoder().decode(await runtime.filesystem.readFile("/original"));
    const replacementBytes = new TextDecoder().decode(
      await runtime.filesystem.readFile("/replacement"),
    );
    assert.equal(originalBytes, selected === "read" ? "ABCDExyHIJ" : "UVCDExyHIJ");
    assert.equal(replacementBytes, "12Q4567890");
    await deadline(runtime.dispose(), "real Runtime disposal");
    disposed = true;
    assert.deepEqual(errors, []);
    assert.equal(workers.length, 4);
    assert.equal(stopped.size, workers.length);
    const drained = events.filter((event) => event.kind === "drained").length;
    const serviceDisposed = events.filter((event) => event.kind === "disposed").length;
    assert.equal(drained, 1);
    assert.equal(serviceDisposed, 1);
    const snapshot = runtime.sharedMemory.snapshot();
    const controlDebts = snapshot.holders
      .filter((holder) => holder.state === "debt")
      .map((holder) => ({ label: holder.label, bytes: holder.declaredBytes }));
    assert.deepEqual(controlDebts, [
      { label: "guest-control", bytes: 80 },
      { label: "guest-control", bytes: 80 },
    ]);
    assert.equal(snapshot.debtBytes, 160);
    const backing = snapshot.sharedGuests;
    assert.equal(backing.length, 1);
    assert.equal(backing[0]?.phase, "awaiting-collection");
    assert.equal(backing[0]?.fence, "passed");
    assert.deepEqual(backing[0]?.aliases, { reserved: 0, transferred: 0, retained: 0 });
    assert.equal(backing[0]?.continuations.active, 0);
    return {
      selected,
      cursorProof,
      beforeRelease,
      originalCompletion,
      originalBytes,
      replacementBytes,
      pipe: new TextDecoder().decode(pipeBytes),
      heldEvent,
      ready,
      debtBytes: snapshot.debtBytes,
      controlDebts,
      exit,
      workers: workers.length,
      stopped: stopped.size,
      backing,
      calls: events.filter((event) => event.kind === "fd-completed"),
      drained,
      disposed: serviceDisposed,
      errors,
    };
  } finally {
    filesystemWorker()?.postMessage({ kind: "fd-release" });
    if (!disposed) await deadline(runtime.dispose(), "failed proof disposal").catch(() => {});
    descriptors.dispose();
    files?.dispose();
    input.dispose();
    output.dispose();
    for (const worker of workers) {
      if (!stopped.has(worker)) await Reflect.apply(NativeWorker.prototype.terminate, worker, []);
    }
    globalThis.Worker = NativeWorker;
  }
}
console.log(JSON.stringify(await run(selected)));
