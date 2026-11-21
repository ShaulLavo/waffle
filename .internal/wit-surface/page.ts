import {
  createGpuFixtureRuntime,
  gpuFixturePipes,
} from "../../packages/waffle/tests/fixtures/gpu/fixture-runtime.js";
import { DescriptorTable } from "../../packages/waffle/core/descriptors.js";
import type { GraphicsGrant } from "../../packages/waffle/browser/display/protocol.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../packages/waffle/proc/worker-client.js";
import { createWorkerPipeCodec } from "../../packages/waffle/proc/worker-pipes.js";

export async function open() {
  const original = globalThis.Worker;
  const guests: { worker: Worker; stopped: boolean; events: unknown[] }[] = [];
  const endpoints = new Set<ReturnType<typeof gpuFixturePipes>>();
  const urls: string[] = [];
  const errors: string[] = [];
  globalThis.Worker = class extends original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      urls.push(String(url));
      if (url !== "/gpu-guest.js") return;
      const entry = { worker: this, stopped: false, events: new Array<unknown>() };
      guests.push(entry);
      this.addEventListener("message", ({ data }) => {
        if (data?.surfaceExperiment !== undefined) entry.events.push(data.surfaceExperiment);
      });
    }

    override terminate() {
      const entry = guests.find(({ worker }) => worker === this);
      if (entry) entry.stopped = true;
      super.terminate();
    }
  };

  let grant: GraphicsGrant | undefined;
  const runtime = createGpuFixtureRuntime(
    () => grant,
    (error) => errors.push(String(error)),
  );
  const descriptors = new DescriptorTable();
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  document.body.append(canvas);
  const display = await runtime.display();
  const surface = display.createSurface(canvas);

  const programs = ["generated", "handwritten", "peer", "startup", "stale", "double-drop"];
  for (const name of programs) {
    runtime.registerProgram(`/bin/${name}`, {
      adapter: "gpu",
      async source() {
        const response = await fetch(`/${name}.wasm`);
        if (!response.ok) throw new Error(`Missing surface fixture ${name}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    await runtime.filesystem.writeFile(`/bin/${name}`, "registered");
  }
  await runtime.filesystem.writeFile("/probe.txt", "surface fixture");

  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
    capacity: 32,
  });
  const rootPid = transport.pid;
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: createWorkerPipeCodec(),
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  const service = await runtime.processes();
  await service.adoptRuntimeRoot(transport, { memory: [], stop: () => descriptors.dispose() });
  const supervisor = await service.ready();

  async function launch(name: string, mode = "resize") {
    const pipes = gpuFixturePipes(descriptors, rootPid);
    endpoints.add(pipes);
    const { input, output } = pipes;
    const ownedGrant =
      name === "peer" ? undefined : display.grant({ surfaces: [surface], gpu: false });
    grant = ownedGrant;
    const pid = client.spawn(rootPid, {
      executable: `/bin/${name}`,
      argv: [name, String(surface.id), mode],
      env: {},
      cwd: "/",
      job: -1,
      fds: [
        { parent: 0, child: 0 },
        { parent: 1, child: 1 },
        { parent: 2, child: 2 },
      ],
    });
    while (notices.length) await service.runtimeMessage(notices.shift()!, rootPid);
    const index = guests.length;
    await supervisor.start(pid);
    if (guests.length !== index + 1) throw new Error(`Missing fixture worker for ${name}`);
    const worker = guests[index]!;
    let text = "";
    function drain() {
      const bytes = new Uint8Array(4096);
      for (;;) {
        const count = output.tryRead([bytes]);
        if (count <= 0) return text;
        text += new TextDecoder().decode(bytes.subarray(0, count));
      }
    }
    return {
      drain,
      feed() {
        if (input.tryWrite([new Uint8Array([10])]) !== 1) throw new Error("Could not wake guest");
      },
      revoke: () => ownedGrant!.dispose(),
      kill: () => service.kill(pid, 9),
      live: () => !worker.stopped,
      async finish() {
        try {
          const exit = await supervisor.waitForExit(rootPid, pid);
          await ownedGrant?.retired();
          await until(() => worker.stopped, `worker ${pid} retirement`);
          supervisor.reap(rootPid, pid);
          return { exit, text: drain(), events: worker.events };
        } finally {
          endpoints.delete(pipes);
          input.close();
          output.close();
        }
      },
    };
  }

  return {
    launch,
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      globalThis.dispatchEvent(new Event("resize"));
    },
    expected() {
      const scale = Math.round(globalThis.devicePixelRatio * 1000) || 1000;
      const flags =
        Number(document.visibilityState === "visible") | (Number(document.hasFocus()) << 1);
      return `info ${canvas.width} ${canvas.height} ${scale} ${flags}`;
    },
    urls,
    errors,
    async close() {
      try {
        for (const { input, output } of endpoints) {
          input.close();
          output.close();
        }
        await runtime.dispose();
      } finally {
        canvas.remove();
        globalThis.Worker = original;
      }
    },
  };
}

export async function until(pass: () => boolean, name: string) {
  const deadline = performance.now() + 15_000;
  while (!pass()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
