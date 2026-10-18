import { BrowserProcessBroker } from "../browser/process-broker.js";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals.js";
import { DescriptorTable } from "../core/descriptors.js";
import { connectFilesystemIdentity, createFilesystemIdentity } from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { PipeController } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { fixtureSpawnRequest } from "./fixtures/spawn-request.js";
import type { QuietFailureRequest } from "./fixtures/start-failure-quiet-worker.js";

export type QuietFailureStage =
  | "lazy-loader"
  | "invalid-module"
  | "missing-start"
  | "adapter-entry"
  | "nested";
export type QuietFailureSink = "pipe" | "terminal";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function executableModule(start = true, parent = false): WebAssembly.Module {
  const name = (text: string) => [text.length].concat(Array.from(new TextEncoder().encode(text)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  return new WebAssembly.Module(
    new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [2, 96, 0, 0, 96, 2, 127, 127, 1, 127]),
        parent
          ? section(
              2,
              [2].concat(
                name("runtime_proc"),
                name("spawn"),
                [0, 1],
                name("runtime_proc"),
                name("wait"),
                [0, 1],
              ),
            )
          : [],
        section(3, [1, 0]),
        section(5, [1, 0, 1]),
        section(
          7,
          [parent ? 4 : start ? 2 : 1].concat(
            name("memory"),
            [2, 0],
            start ? name("_start").concat([0, parent ? 2 : 0]) : [],
            parent ? name("spawn").concat([0, 0], name("wait"), [0, 1]) : [],
          ),
        ),
        section(10, [1, 2, 0, 11]),
      ),
    ),
  );
}

async function disposeFixture(
  broker: BrowserProcessBroker,
  pipe: PipeController,
  ports: MessagePort[],
): Promise<void> {
  try {
    await broker.dispose();
  } finally {
    pipe.dispose();
    for (const port of ports) port.close();
  }
}

/** Shared by Bun host tests and the three real-browser process suites. */
export async function browserQuietStartFailure(
  stage: QuietFailureStage,
  sink: QuietFailureSink,
  workerUrl = "/start-failure-quiet-worker.js",
  controllerHook = false,
): Promise<void> {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  const failure = new Error("quiet lazy loader rejected"),
    module = executableModule(stage !== "missing-start", stage === "nested");
  registry.register("lazy-loader", {
    adapter: "fixture",
    module() {
      throw failure;
    },
  });
  registry.register("invalid-module", {
    adapter: "fixture",
    module: () => new WebAssembly.Module(new Uint8Array([0])),
  });
  registry.register("missing-start", { adapter: "fixture", module });
  registry.register("adapter-entry", { adapter: "fixture", module });
  registry.register("nested", { adapter: "fixture", module });
  const errors: unknown[] = [],
    output: Uint8Array[] = [],
    ports: MessagePort[] = [],
    notices: WorkerProcessMessage[] = [];
  const pipe = new PipeController({ capacity: 64, maxReaders: 4, maxWriters: 8, relay: "manual" });
  const descriptors = new DescriptorTable();
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const terminalWrite = (chunks: readonly Uint8Array[]) => {
    output.push(...chunks.map((chunk) => chunk.slice()));
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  };
  descriptors.openAt(
    1,
    {
      kind: "terminal",
      read: () => 0,
      write: terminalWrite,
      tryWrite: terminalWrite,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    },
    64n,
    0n,
  );
  if (sink === "pipe") descriptors.openAt(2, pipe.retain(root.pid, "write"), 64n, 0n);
  else descriptors.inherit(2, descriptors.get(1)!);
  const codec = createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() });
  const parent = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec,
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
  });
  const reader = pipe.retain(root.pid, "read");
  let launched = 0,
    hooks = 0,
    grandchild = 0;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect(identity) {
        const pair = connectFilesystemIdentity(identity);
        ports.push(pair.client.port, pair.server.port);
        return pair.client;
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch(context) {
      launched++;
      if (controllerHook)
        broker.registerController(context.pid, {
          startFailed() {
            hooks++;
          },
        });
      return broker.launchWorker<QuietFailureRequest>(context, {
        workerUrl,
        request: {
          module: context.module,
          args: [],
          env: {},
          stage:
            stage === "nested"
              ? "parent"
              : stage === "missing-start"
                ? "missing-start"
                : "adapter-entry",
        },
        onMessage(message) {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "quiet-grandchild-result"
          )
            grandchild++;
        },
      });
    },
  });
  try {
    await broker.adoptRuntimeRoot(root, { output: (_fd, bytes) => output.push(bytes.slice()) });
    const pid = parent.spawn(
      parent.pid,
      fixtureSpawnRequest({
        executable: stage,
        job: -1,
        fds: [
          { parent: 1, child: 1 },
          { parent: 2, child: 2 },
        ],
      }),
    );
    descriptors.dispose();
    for (const notice of notices) await broker.runtimeMessage(notice, parent.pid);
    const supervisor = await broker.ready();
    await supervisor.start(pid);
    const result = await supervisor.waitForExit(parent.pid, pid);
    if (stage === "nested") {
      assert(
        result.kind === "exited" && result.code === 0 && grandchild === 1,
        `shell-like parent did not collect failing grandchild: ${JSON.stringify(result)}, notices=${grandchild}, host=${errors.map(String).join("; ")}, output=${output.map((bytes) => new TextDecoder().decode(bytes)).join("")}`,
      );
    } else {
      const error = stage === "invalid-module" || stage === "missing-start" ? "ENOEXEC" : "EIO";
      assert(
        result.kind === "start-failed" &&
          result.error === error &&
          result.code === (error === "ENOEXEC" ? 8 : 5) &&
          result.status === null,
        `wrong START_FAILED: ${JSON.stringify(result)}`,
      );
      assert(
        supervisor.startStatus(parent.pid, pid) === (error === "ENOEXEC" ? 45 : 29),
        "wrong runtime_proc startup errno",
      );
    }
    assert(
      launched === (stage === "lazy-loader" || stage === "invalid-module" ? 0 : 1),
      "failure stage did not reach expected launch boundary",
    );
    assert(hooks === (controllerHook ? 1 : 0), "registered startup hook did not run exactly once");
    assert(output.length === 0, `Waffle wrote to terminal: ${output.map(String).join()}`);
    assert(reader.tryRead([new Uint8Array(1)]) === 0, "Waffle wrote to child/grandchild pipe");
    assert(
      errors.length === 1 && errors[0] instanceof Error && !!errors[0].stack,
      `expected exactly one full host diagnostic: ${errors.map(String).join("; ")}`,
    );
    if (stage === "lazy-loader" || stage === "nested")
      assert(errors[0] === failure, "host lost original loader error and stack");
    if (stage === "missing-start")
      assert(String(errors[0]).includes("_start"), "missing entry diagnostic lost on host");
    if (stage === "adapter-entry")
      assert(
        String(errors[0]).includes("quiet adapter entry rejected"),
        "adapter error lost on host",
      );
    parent.wait(parent.pid, pid);
  } finally {
    reader.close();
    descriptors.dispose();
    await disposeFixture(broker, pipe, ports);
  }
}

/** An embedder spawn has a bookkeeping parent, but no admitted runtime_proc transport. */
export async function hostRootStartFailure(): Promise<void> {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  const failure = new Error("root loader rejected"),
    output: string[] = [],
    errors: unknown[] = [];
  registry.register("fixture", {
    adapter: "fixture",
    module() {
      throw failure;
    },
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("root must fail before launch");
    },
  });
  const descriptors = new DescriptorTable();
  const write = (chunks: readonly Uint8Array[]) => {
    output.push(...chunks.map((chunk) => new TextDecoder().decode(chunk)));
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  };
  descriptors.openAt(
    2,
    {
      kind: "terminal",
      read: () => 0,
      write,
      tryWrite: write,
      readiness: () => ({ readable: true, writable: true, hangup: false }),
    },
    64n,
    0n,
  );
  try {
    const root = await broker.adoptRoot({ descriptors }),
      supervisor = await broker.ready();
    const pid = supervisor.spawn(root, fixtureSpawnRequest({ fds: [{ parent: 2, child: 2 }] }));
    const result = await supervisor.waitForExit(root, pid);
    assert(
      table.get(pid)!.parentPid !== 0 && broker.transportFor(pid) === undefined,
      "root control does not exercise host bookkeeping parent",
    );
    assert(result.kind === "start-failed" && result.error === "EIO", "root outcome changed");
    assert(
      output.join("") === `runtime: process start failed: ${String(failure)}\n`,
      "embedder root lost generic stderr diagnostic",
    );
    assert(errors.length === 0, "root should not duplicate stderr into host diagnostic");
  } finally {
    await broker.dispose();
    descriptors.dispose();
  }
}
