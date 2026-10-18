import { BrowserProcessBroker } from "../browser/process-broker.js";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { DescriptorTable } from "../core/descriptors.js";
import { serializeTaggedCells, type TaggedCells } from "../proc/control.js";
import {
  collectDirectoryJob,
  collectDirectoryProcess,
  confirmDirectoryProcess,
  reserveDirectoryProcess,
} from "../proc/directory.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import {
  claimOutcome,
  readOutcome,
  serializeOutcome,
  markStarted,
  startStatus,
} from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import { ProcessError, ProcessErrno } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}
function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("cell clone test timed out")), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Actual browser launchWorker postMessage, bootstrap, filesystem and consuming wait. */
export async function browserBrokerCellClone(): Promise<void> {
  const filesystem = new SharedFilesystem({ workerURL: "/cell-fs-worker.js", mode: "memory" });
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  const descriptors = new DescriptorTable(),
    notices: WorkerProcessMessage[] = [],
    diagnostics: unknown[] = [];
  // Original tiny command: a memory and empty _start, run by the injected executor.
  const module = new WebAssembly.Module(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
      101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
    ]),
  );
  registry.register("clone-fixture", { adapter: "fixture", module });
  const broker = new BrowserProcessBroker({
    filesystem,
    identities,
    table,
    registry,
    onError: (error) => diagnostics.push(error),
    launch: (context) =>
      broker.launchWorker(context, {
        workerUrl: "/cell-worker.js",
        request: { module: context.module, args: context.request.argv, env: context.request.env },
      }),
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
    capacity: 2,
  });
  root.data = { filesystem: filesystem.createIdentity() };
  const unused = (): never => {
    throw new Error("fixture must not transfer descriptors");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: filesystem.createIdentity() } }),
  });
  const flush = async () => {
    while (notices.length) await broker.runtimeMessage(notices.shift()!, root.pid);
  };
  try {
    await broker.adoptRuntimeRoot(root);
    const supervisor = await broker.ready();
    let previousSlot: number | undefined;
    for (let iteration = 0; iteration < 2; iteration++) {
      const pid = client.spawn(root.pid, {
        executable: "clone-fixture",
        argv: ["clone-fixture"],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      await flush();
      const transport = broker.transportFor(pid)!;
      assert(transport, "broker must admit the child");
      const state = workerProcessState(transport);
      if (previousSlot !== undefined)
        equal(transport.slot, previousSlot, "second real Worker must reuse the collected slot");
      previousSlot = transport.slot;
      await supervisor.start(pid);
      equal(
        await bounded(supervisor.waitForExit(root.pid, pid)),
        { kind: "exited", code: 23, status: 23 },
        "real Worker exit",
      );
      equal(
        client.wait(root.pid, pid),
        { kind: "exited", code: 23, status: 23 },
        "consuming child wait",
      );
      await flush();
      equal(
        client.waitJob(root.pid, state.job),
        { kind: "exited", code: 23, status: 23 },
        "consuming job wait",
      );
      await flush();
    }
    equal(diagnostics.map(String), [], "browser broker diagnostics");
  } finally {
    try {
      descriptors.dispose();
      await broker.dispose();
    } finally {
      filesystem.dispose();
    }
  }
}

/** Keep a real Worker alive beyond collection and reuse of both process and job rows. */
export async function browserStaleCellClone(job: boolean): Promise<void> {
  const root = createWorkerProcessTransport({ pid: 11, job: 31, capacity: 2 });
  const child = reserveDirectoryProcess(root, 71, root.pid, 901, root.pid),
    state = workerProcessState(child);
  const outcome = job ? state.jobOutcome : state.signals.outcome;
  const controls = (
    job
      ? [state.jobPending, state.jobControlParent]
      : [state.signals.interrupt, state.signals.requestedSignal, state.signals.signalState]
  ) as TaggedCells[];
  let worker: Worker | undefined;
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const request = (data: unknown) =>
    bounded(
      new Promise<unknown>((resolve, reject) => {
        pending = { resolve, reject };
        worker!.postMessage(data);
      }),
    );
  try {
    worker = new Worker("/cell-worker.js", { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.failure) pending?.reject(new Error(data.failure));
      else pending?.resolve(data);
      pending = undefined;
    };
    worker.onerror = (event) => {
      event.preventDefault();
      pending?.reject(new Error(event.message));
    };
    worker.onmessageerror = () =>
      pending?.reject(new Error("cell Worker message could not be decoded"));
    assert(markStarted(outcome), "commit entry before cloning the started-running cell");
    equal(
      await request({
        operation: "capture",
        outcome: serializeOutcome(outcome),
        controls: controls.map(serializeTaggedCells),
      }),
      { phase: "captured" },
      "capture live cells",
    );
    const exited = { kind: "exited", code: 23, status: 23 } as const;
    equal(readOutcome(outcome), null, "cloned entry remains invisible to outcome readers");
    equal(startStatus(outcome), 0, "cloned entry remains visible to startup readers");
    equal(claimOutcome(outcome, exited), exited, "claim after entry");
    equal(claimOutcome(outcome, { kind: "exited", code: 99 }), exited, "only one terminal winner");
    equal(
      await request({ operation: "terminal" }),
      { phase: "terminal" },
      "Worker retains startup after terminal claim",
    );
    claimOutcome(state.signals.outcome, exited);
    confirmDirectoryProcess(child);
    collectDirectoryProcess(child);
    collectDirectoryJob(root.directory, state.jobSlot, state.job);
    for (const phase of ["collected", "recycled"]) {
      if (phase === "recycled") {
        const replacement = reserveDirectoryProcess(root, 72, root.pid, 902, root.pid);
        equal(replacement.slot, child.slot, "same process slot");
        equal(workerProcessState(replacement).jobSlot, state.jobSlot, "same job slot");
      }
      const before = Array.from(new BigInt64Array(root.directory), String);
      equal(
        await request({ operation: "stale" }),
        { phase: "stale", rejected: 4 + controls.length * 2 },
        `${phase}: Worker rejects old cells`,
      );
      try {
        readOutcome(outcome);
        throw new Error("parent read of stale outcome succeeded");
      } catch (error) {
        assert(
          error instanceof ProcessError && error.errno === ProcessErrno.SRCH,
          "parent stale read must reject SRCH",
        );
      }
      equal(
        Array.from(new BigInt64Array(root.directory), String),
        before,
        "stale operations must not mutate replacement",
      );
    }
  } finally {
    worker?.terminate();
  }
}
