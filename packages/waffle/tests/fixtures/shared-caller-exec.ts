import assert from "node:assert/strict";
import { createRuntime, type RuntimeProcessContext } from "../../runtime.js";
import { DescriptorTable } from "../../core/descriptors.js";
import { captureProcessObserver } from "../../proc/observation.js";
import { readOutcome } from "../../proc/outcome.js";
import type { LinkedWorkerRequest } from "../../link/index.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
  workerProcessPipeRegistry,
  workerProcessState,
} from "../../proc/worker-client.js";
import { createWorkerPipeCodec, WorkerPipeHost } from "../../proc/worker-pipes.js";
import { attachPipePublicationRegistry, type PipeEndpoint } from "../../proc/pipes.js";
import { groupLinkProgram } from "./group-link-program.js";
import { BrowserProcessBroker } from "../../browser/process-broker.js";
import { FilesystemSection, type FilesystemIdentity } from "../../fs/protocol.js";

export type SharedExecMode =
  | "replace"
  | "unclassified"
  | "missing"
  | "shebang"
  | "registration"
  | "filesystem-fence"
  | "controller-fence"
  | "controller-stop"
  | "source-acquisition"
  | "target-acquisition"
  | "descriptors"
  | "native-failure"
  | "filesystem-failure"
  | "controller-failure"
  | "cleanup-failure";

/** Public Runtime, genuine filesystem Worker, imported PIE and gated real native return. */
export async function sharedCallerExec(mode: SharedExecMode) {
  const NativeWorker = globalThis.Worker;
  const nativeTerminate = NativeWorker.prototype.terminate;
  const workers: Worker[] = [];
  const stopped = new Set<Worker>();
  const stopEntered = Promise.withResolvers<void>();
  const stopGate = Promise.withResolvers<void>();
  const sourceReady = Promise.withResolvers<void>();
  const rejected = Promise.withResolvers<unknown>();
  const targetEntered = Promise.withResolvers<void>();
  const targetGate = Promise.withResolvers<void>();
  const fenceEntered = Promise.withResolvers<void>();
  const controllerStopEntered = Promise.withResolvers<void>();
  const controllerStopGate = Promise.withResolvers<void>();
  const handleGate = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  let sourceFilesystem: FilesystemIdentity | undefined;
  let heldSection: FilesystemSection | undefined;
  let sectionActive = false;
  let sourceWorker: Worker | undefined;
  let source: RuntimeProcessContext | undefined;
  let target: RuntimeProcessContext | undefined;
  let targetEntries = 0;
  let replacedRegistrationEntries = 0;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let descriptorPipe: PipeEndpoint | undefined;
  const descriptors = new DescriptorTable();
  const negative = mode === "unclassified" || mode === "missing" || mode === "shebang";
  const debt = mode.endsWith("-failure");
  const cleanup = {
    createdWorkers: 0,
    nativeReturns: 0,
    runtimeDisposed: false,
    debtOwnerRetained: debt,
  };
  const failure = new Error(`injected ${mode}`);
  let faulted = false;
  const failStop = () => {
    faulted = true;
    throw failure;
  };
  let retiring = false;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.push(this);
      if (String(url).endsWith("shared-caller-exec-worker.ts")) sourceWorker = workers.at(-1);
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "replaced") replaced.resolve();
        if (data?.type !== "error") return;
        rejected.reject(new Error(data.message));
        sourceReady.reject(new Error(data.message));
      });
    }
    override async terminate() {
      if (this === sourceWorker && !retiring && !negative) {
        stopEntered.resolve();
        await stopGate.promise;
        if (mode === "native-failure") failStop();
      }
      await Reflect.apply(nativeTerminate, this, []);
      stopped.add(this);
    }
  };
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "control-ready") sourceReady.resolve();
    if (message.type === "control-rejected") rejected.resolve(message);
  };
  const start = performance.now();
  const run = async () => {
    const plan = await groupLinkProgram();
    assert(WebAssembly.Module.imports(plan.module).some((entry) => entry.kind === "memory"));
    assert(!WebAssembly.Module.exports(plan.module).some((entry) => entry.kind === "memory"));
    runtime = createRuntime({
      filesystem: {
        mode: "memory",
        workerURL: new URL("../../browser/fs-worker.ts", import.meta.url),
      },
      memoryGroups: { maximumPages: 65536, stackBytes: 65536 },
      processHost: (options) =>
        new BrowserProcessBroker({
          ...options,
          onError: () => {},
          filesystem: {
            ...options.filesystem,
            quiesce: async (identity) => {
              if (mode === "filesystem-fence" && identity.sections === sourceFilesystem?.sections) {
                fenceEntered.resolve();
              }
              await options.filesystem.quiesce(identity);
              if (mode === "filesystem-failure" && identity.sections === sourceFilesystem?.sections)
                failStop();
            },
          },
        }),
    });
    runtime.registerAdapter("source", (context, service) => {
      source = context;
      if (
        mode === "controller-fence" ||
        mode === "controller-stop" ||
        mode === "controller-failure"
      ) {
        const filesystem = runtime!.filesystem.createIdentity();
        heldSection = new FilesystemSection(filesystem);
        if (mode === "controller-fence") {
          heldSection.enter();
          sectionActive = true;
        }
        service.registerController(context.pid, {
          filesystem,
          quiesce: () => {
            fenceEntered.resolve();
          },
          stop: async () => {
            controllerStopEntered.resolve();
            if (mode === "controller-failure") failStop();
            await controllerStopGate.promise;
          },
        });
      }
      const handle = service.launchWorker<LinkedWorkerRequest>(context, {
        workerUrl: new URL("./shared-caller-exec-worker.ts", import.meta.url).href,
        memoryGroup: "new",
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          linkPlan: plan.linkPlan,
        },
        onMessage,
        cleanup: mode === "cleanup-failure" ? failStop : undefined,
      });
      return mode === "source-acquisition" ? handleGate.promise.then(() => handle) : handle;
    });
    const launch = (context: RuntimeProcessContext) => {
      target = context;
      targetEntries++;
      if (mode === "descriptors") {
        const root = context.descriptors.rootPreopen();
        assert.equal(context.descriptors.get(19), root);
        assert.equal(root?.rightsBase, 17n);
        assert.equal(root?.rightsInheriting, 19n);
        assert.equal(context.descriptors.get(21)?.preopen, undefined);
        const rootAlias = context.descriptors.get(21);
        assert(root?.resource.kind === "directory" && rootAlias?.resource.kind === "directory");
        assert.equal(rootAlias.resource.handle, root.resource.handle);
        const first = context.descriptors.get(7)!;
        const second = context.descriptors.get(11)!;
        assert.equal(first.description, second.description);
        assert.equal(first.rightsBase, 3n);
        assert.equal(second.rightsBase, 1n);
        assert(first.resource.kind === "file");
        assert.equal(first.resource.offset, 3);
        assert.equal(first.resource.fdflags, 5);
        assert.equal(first.resource.append, true);
        const pipe = context.descriptors.get(17)!;
        assert.equal(pipe.description, context.descriptors.get(23)?.description);
        assert(pipe.resource.kind === "pipe");
        assert.equal(pipe.resource.fdflags, 4);
        assert.equal(pipe.resource.tryWrite?.([new Uint8Array([73])]), 1);
        assert.deepEqual(context.descriptors.inheritable(), [7, 11, 17, 21, 23]);
      }
      assert.equal("takeWorker" in service, true);
      assert.throws(
        () =>
          service.launchWorker(context, {
            workerUrl: "forbidden",
            request: { module: context.module, args: [], env: {} },
          }),
        /host-only image/,
      );
      assert.throws(() => service.admitRootMemoryGroup(context.pid, plan), /host-only image/);
      context.started();
      targetEntered.resolve();
      void targetGate.promise.then(() => context.exit(137));
      const handle = { terminate: () => targetGate.resolve() };
      return mode === "target-acquisition" ? handleGate.promise.then(() => handle) : handle;
    };
    const unregister =
      mode === "unclassified"
        ? runtime.registerAdapter("held-host", launch)
        : runtime.registerHostAdapter("held-host", (context, restricted) => {
            assert.equal("takeWorker" in restricted, false);
            return launch(context);
          });
    const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const loading = Promise.withResolvers<WebAssembly.Module>();
    const loaderEntered = Promise.withResolvers<void>();
    runtime.registerProgram("/source", {
      adapter: "source",
      module: plan.module,
      cooperative: true,
    });
    runtime.registerProgram("/held-host", {
      adapter: "held-host",
      cooperative: true,
      module:
        mode === "registration"
          ? () => {
              loaderEntered.resolve();
              return loading.promise;
            }
          : empty,
    });
    await runtime.filesystem.writeFile("/source", "registered");
    await runtime.filesystem.writeFile("/held-host", "registered");
    await runtime.filesystem.writeFile("/script", "#!/source\n");
    await runtime.filesystem.writeFile("/still-usable", "original runtime filesystem");
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const root = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
      capacity: 8,
    });
    root.data = { filesystem: runtime.filesystem.createIdentity() };
    const notices: WorkerProcessMessage[] = [];
    let parentPipes: WorkerPipeHost | undefined;
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: createWorkerPipeCodec(),
      postMessage: (message) => notices.push(message),
      prepareSpawn: (pid) => {
        parentPipes?.registry.registerProcess(pid);
        const filesystem = runtime!.filesystem.createIdentity();
        sourceFilesystem = filesystem;
        return { data: { filesystem } };
      },
    });
    await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
    if (mode === "descriptors") {
      parentPipes = new WorkerPipeHost({
        transport: root,
        registry: attachPipePublicationRegistry(workerProcessPipeRegistry(root)),
        postMessage: (message) => notices.push(message),
      });
      const endpoints = parentPipes.createPipe();
      descriptorPipe = endpoints[0];
      descriptors.openAt(9, endpoints[1], 0n, 0n);
    }
    const pid = client.spawn(root.pid, {
      executable: "/source",
      argv: ["source"],
      env: {
        TARGET: mode === "missing" ? "/missing" : mode === "shebang" ? "/script" : "/held-host",
        EXPECT: mode === "missing" ? "-44" : "-58",
        DESCRIPTORS: mode === "descriptors" ? "1" : "0",
      },
      cwd: "/",
      job: -1,
      fds: mode === "descriptors" ? [{ parent: 9, child: 3 }] : [],
    });
    for (const message of notices) await service.runtimeMessage(message, root.pid);
    if (mode === "descriptors") descriptors.close(9);
    const starting = supervisor.start(pid);
    if (mode !== "source-acquisition") await starting;
    await sourceReady.promise;
    assert(source && sourceWorker);
    const admittedWorker = sourceWorker;
    const admittedSource = source;
    const admittedRuntime = runtime;
    const originalRootPid = workerProcessState(service.transportFor(pid)!).rootPid;
    const observer = captureProcessObserver(source.observation);
    const group = service.memoryGroupOf(pid);
    assert(group);
    const original = service.memoryGroups();
    const charge = original[0]?.committedBytes;
    if (mode === "filesystem-fence") {
      assert(sourceFilesystem);
      heldSection = new FilesystemSection(sourceFilesystem);
      heldSection.enter();
      sectionActive = true;
    }
    sourceWorker.postMessage({ kind: "exec" });
    const settleLookup = async () => {
      if (mode === "filesystem-fence" || mode === "controller-fence") {
        await fenceEntered.promise;
        assert.equal(targetEntries, 0);
        assert.equal(stopped.has(admittedWorker), false);
        assert.equal(service.memoryGroups()[0]?.committedBytes, charge);
        if (sectionActive) {
          heldSection!.exit();
          sectionActive = false;
        }
        controllerStopGate.resolve();
      }
      if (mode === "source-acquisition") {
        await replaced.promise;
        assert.equal(targetEntries, 0);
        assert.equal(stopped.has(admittedWorker), false);
        assert.equal(service.memoryGroupOf(pid), group);
        handleGate.resolve();
        await starting;
      }
      if (mode === "registration") {
        await loaderEntered.promise;
        unregister();
        admittedRuntime.registerAdapter("held-host", () => {
          replacedRegistrationEntries++;
          throw new Error("replacement registration must never enter");
        });
        loading.resolve(empty);
      }
    };
    await settleLookup();
    if (debt) {
      stopGate.resolve();
      controllerStopGate.resolve();
      while (service.memoryGroups()[0]?.retained !== 1)
        await new Promise((resolve) => setTimeout(resolve, 1));
      const exit = readOutcome(source.outcome);
      assert(exit);
      assert.equal(exit.kind, "exited");
      assert.equal(exit.code, 126);
      assert.equal(service.memoryGroups()[0]?.committedBytes, charge);
      assert.equal(targetEntries, 0);
      assert.notEqual(observer.read().kind, "terminated");
      assert.equal(faulted, true);
      return {
        mode,
        outcome: "PASS",
        exit,
        retained: true,
        cleanup,
        finalObservation: observer.read(),
        durationMs: performance.now() - start,
      };
    }
    const finishPositive = async () => {
      await Promise.race([
        stopEntered.promise,
        rejected.promise.then(() => {
          throw new Error("shared caller was rejected before native stop");
        }),
      ]);
      assert.equal(stopped.has(admittedWorker), false);
      assert.equal(service.memoryGroupOf(pid), group);
      assert.equal(service.memoryGroups()[0]?.committedBytes, charge);
      assert.equal(service.memoryGroups()[0]?.members, 1);
      assert.equal(targetEntries, 0);
      assert.equal(service.transportFor(pid)?.generation, 1);
      assert.deepEqual(observer.read(), { kind: "pending" });
      if (mode === "descriptors") assert.equal(descriptorPipe?.tryRead([new Uint8Array(1)]), -6);
      stopGate.resolve();
      if (mode === "controller-stop") {
        await controllerStopEntered.promise;
        assert.equal(stopped.has(admittedWorker), true);
        assert.equal(targetEntries, 0);
        assert.equal(service.memoryGroupOf(pid), group);
        assert.equal(service.memoryGroups()[0]?.committedBytes, charge);
        controllerStopGate.resolve();
      }
      await targetEntered.promise;
      assert(target);
      assert.equal(target.pid, admittedSource.pid);
      assert.equal(target.parentPid, admittedSource.parentPid);
      assert.equal(target.job, admittedSource.job);
      assert.equal(workerProcessState(service.transportFor(pid)!).rootPid, originalRootPid);
      assert.equal(target.generation, admittedSource.generation + 1);
      assert.equal(stopped.has(admittedWorker), true);
      assert.equal(service.memoryGroupOf(pid), undefined);
      assert.deepEqual(service.memoryGroups(), []);
      assert.equal(service.transportFor(pid)?.generation, 2);
      assert.equal(supervisor.wait(root.pid, pid), null);
      assert.deepEqual(observer.read(), { kind: "pending" });
      if (mode === "descriptors") {
        const data = new Uint8Array(1);
        assert.equal(descriptorPipe?.tryRead([data]), 1);
        assert.equal(data[0], 73);
        assert.equal(descriptorPipe?.tryRead([data]), -6);
      }
      targetGate.resolve();
      handleGate.resolve();
    };
    if (negative) {
      await rejected.promise;
      assert.equal(service.transportFor(pid)?.generation, 1);
      assert.deepEqual(service.memoryGroups(), original);
      assert.equal(targetEntries, 0);
      assert.deepEqual(observer.read(), { kind: "pending" });
      sourceWorker.postMessage({ kind: "release" });
    } else await finishPositive();
    const exit = await supervisor.waitForExit(root.pid, pid);
    assert.equal(exit.kind, "exited");
    assert.equal(exit.code, negative ? 0 : 137);
    while (observer.read().kind !== "terminated")
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(observer.read().kind, "terminated");
    assert.equal(replacedRegistrationEntries, 0);
    assert.equal(targetEntries, negative ? 0 : 1);
    if (mode === "descriptors") assert.equal(descriptorPipe?.tryRead([new Uint8Array(1)]), 0);
    return {
      mode,
      outcome: "PASS",
      exit,
      targetEntries,
      sourceNativeReturned: stopped.has(admittedWorker),
      groupsBefore: original,
      identity: {
        pid,
        parentPid: admittedSource.parentPid,
        rootPid: originalRootPid,
        job: admittedSource.job,
        generationBefore: admittedSource.generation,
        generationAfter: target?.generation ?? admittedSource.generation,
      },
      cleanup,
      finalObservation: observer.read(),
      durationMs: performance.now() - start,
    };
  };
  const stopRemainingWorkers = async () => {
    for (const worker of workers) {
      if (stopped.has(worker)) continue;
      await Reflect.apply(nativeTerminate, worker, []);
      stopped.add(worker);
    }
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("shared exec 60 second hang cap")), 60000);
      }),
    ]);
  } finally {
    retiring = true;
    clearTimeout(deadline);
    stopGate.resolve();
    controllerStopGate.resolve();
    handleGate.resolve();
    if (sectionActive) heldSection?.exit();
    targetGate.resolve();
    sourceWorker?.postMessage({ kind: "release" });
    try {
      const disposing = runtime?.dispose();
      if (debt && faulted) await assert.rejects(disposing!);
      else {
        await disposing;
        cleanup.runtimeDisposed = true;
      }
    } finally {
      descriptors.dispose();
      descriptorPipe?.close();
      await stopRemainingWorkers();
      globalThis.Worker = NativeWorker;
    }
    assert.equal(stopped.size, workers.length);
    cleanup.createdWorkers = workers.length;
    cleanup.nativeReturns = stopped.size;
  }
}
