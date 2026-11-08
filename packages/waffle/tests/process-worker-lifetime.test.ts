import { expect, test } from "bun:test";
import { createRuntime } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import { WorkerProcessClient, createWorkerProcessTransport } from "../proc/worker-client.js";

// A one-page, no-import Preview 1 module with an empty _start function.
const source = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109, 101,
  109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
]);

const workerUrl = new URL("../browser/preview1-worker.ts", import.meta.url).href;

async function runChild(runtime: ReturnType<typeof createRuntime>): Promise<void> {
  const descriptors = new DescriptorTable();
  try {
    await runtime.filesystem.mkdirp("/bin");
    await runtime.filesystem.writeFile("/bin/fixture", "fixture");
    runtime.registerAdapter("fixture", (context, service) =>
      service.launchWorker(context, {
        workerUrl,
        request: { module: context.module, args: [], env: {} },
      }),
    );
    runtime.registerProgram("/bin/fixture", {
      adapter: "fixture",
      module: new WebAssembly.Module(source),
      cooperative: true,
    });
    const service = await runtime.processes();
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
    });
    transport.data = { filesystem: runtime.filesystem.createIdentity() };
    await service.adoptRuntimeRoot(transport, { memory: [] });
    const admissions: Promise<void>[] = [];
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      codec: {
        export() {
          throw new Error("No descriptors exported by this fixture");
        },
        import() {
          throw new Error("No descriptors imported by this fixture");
        },
        discard() {},
      },
      postMessage: (message) => admissions.push(service.runtimeMessage(message, client.pid)),
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    });
    const pid = client.spawn(client.pid, {
      executable: "/bin/fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    await Promise.all(admissions);
    const supervisor = await service.ready();
    expect(await supervisor.waitForExit(client.pid, pid)).toEqual({
      kind: "exited",
      code: 0,
      status: 0,
    });
  } finally {
    descriptors.dispose();
  }
}

for (const delayed of [false, true])
  test(`stopped process Worker releases launch closures after physical stop, delayed=${delayed}`, async () => {
    const NativeWorker = globalThis.Worker;
    const workers: Worker[] = [];
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    globalThis.Worker = class extends NativeWorker {
      private readonly processWorker: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.processWorker = String(url) === workerUrl;
        if (this.processWorker) workers.push(this);
      }
      override async terminate(): Promise<void> {
        if (this.processWorker && delayed) {
          stopping.resolve();
          await release.promise;
        }
        await super.terminate();
      }
    };
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      runtime = createRuntime({
        filesystem: {
          mode: "memory",
          workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
        },
      });
      await runChild(runtime);
      const disposal = runtime.dispose();
      if (delayed) {
        await stopping.promise;
        expect(workers[0]!.onmessage).not.toBeNull();
        expect(workers[0]!.onerror).not.toBeNull();
      }
      release.resolve();
      await disposal;
      // Retain the real native wrapper, independently of the engine's destruction timing.
      expect(workers).toHaveLength(1);
      expect(workers[0]!.onmessage).toBeNull();
      expect(workers[0]!.onerror).toBeNull();
    } finally {
      globalThis.Worker = NativeWorker;
      release.resolve();
      try {
        await runtime?.dispose();
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
      }
    }
  });
