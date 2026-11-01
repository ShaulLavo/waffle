import { BrowserProcessBroker } from "../browser/process-broker.js";
import { runtimeSurvivorModule, generatedRuntimeThreadModule } from "./threads-runtime-modules.js";
import { createRuntime } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import { RIGHTS_ALL } from "../core/rights.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { bytes, declareSharedMemoryPlatform } from "../memory/index.js";

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
}
export type RuntimeThreadCase =
  | "pair"
  | "repeat"
  | "nested"
  | "kill-start"
  | "join"
  | "child-exit"
  | "cpu"
  | "wait32"
  | "wait64";
export async function runThreadsRuntime(selected: RuntimeThreadCase = "pair", local = false) {
  const errors: string[] = [];
  const created: Worker[] = [];
  const urls: string[] = [];
  let registered = 0;
  let constructionKilled = false;
  let killAtConstruction: (() => void) | undefined;
  let guestReady = 0;
  let stopped = 0;
  const barriers = new Set<Worker>();
  let heldSections: Int32Array | undefined;
  let drainRevoked = false;
  let resolveDrainMarker!: () => void;
  const drainMarker = new Promise<void>((resolve) => (resolveDrainMarker = resolve));
  let barrierReleased = false;
  let resolveBarrierReleased!: () => void;
  const barrierRelease = new Promise<void>((resolve) => (resolveBarrierReleased = resolve));
  let fixtureProbeReceived = false;
  let resolveFixtureProbe!: () => void;
  const fixtureProbe = new Promise<void>((resolve) => (resolveFixtureProbe = resolve));
  let fenceBlocked = false;
  const causalCounter = new SharedArrayBuffer(4);
  const causalEvents: Record<string, unknown>[] = [];
  const recordCausal = (kind: string, fields: Record<string, unknown> = {}) => {
    causalEvents.push({
      sequence: Atomics.add(new Int32Array(causalCounter), 0, 1) + 1,
      actor: "page",
      kind,
      at: performance.now(),
      ...fields,
    });
  };
  (globalThis as Record<string, unknown>).__waffleRuntimeSafariCausalEvents = causalEvents;
  const workerTargets = new WeakMap<Worker, string>();
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const target = String(url);
      workerTargets.set(this, target);
      created.push(this);
      urls.push(target);
      if (
        selected === "kill-start" &&
        (String(url).includes("thread-guest") || String(url).includes("guest-bootstrap"))
      )
        killAtConstruction?.();
      if (target.includes("thread-barrier") || target.includes("service-barrier"))
        barriers.add(this);
      this.addEventListener("message", ({ data }) => {
        const kind = data?.kind ?? typeof data;
        recordCausal("worker-message", {
          worker: target,
          messageKind: kind,
          workerSequence: data?.causalSequence,
        });
        if (data?.kind === "wait-registered") registered++;
        if (data?.kind === "ready") guestReady++;
        if (data?.kind === "fixture-held") heldSections = new Int32Array(data.sections);
        if (data?.kind === "fixture-draining") {
          drainRevoked = data.revoked;
          resolveDrainMarker();
        }
        if (data?.kind === "fixture-released") {
          barrierReleased = true;
          resolveBarrierReleased();
        }
        if (data?.kind === "fixture-probe-received") {
          fixtureProbeReceived = true;
          resolveFixtureProbe();
        }
      });
    }
    override postMessage(
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ): void {
      const target = workerTargets.get(this) ?? "unknown";
      recordCausal("worker-post", {
        worker: target,
        messageKind:
          message && typeof message === "object" && "kind" in message
            ? (message as { kind?: unknown }).kind
            : typeof message,
      });
      if (
        target.includes("thread-barrier") &&
        message &&
        typeof message === "object" &&
        (message as { kind?: unknown }).kind === "thread-service" &&
        !("__waffleCausal" in message)
      ) {
        message = { ...(message as Record<string, unknown>), __waffleCausal: causalCounter };
      }
      if (transfer === undefined) return super.postMessage(message);
      return super.postMessage(message, transfer);
    }
    override terminate() {
      if (barriers.has(this) && heldSections && Atomics.load(heldSections, 0) !== 0)
        throw new Error("service terminated with a live filesystem section");
      stopped++;
      return super.terminate();
    }
  };
  const runtime = createRuntime({
    sharedMemory: declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
    filesystem: {
      mode: "memory",
      workerURL: local ? new URL("../browser/fs-worker.ts", import.meta.url) : "/fs-worker.js",
    },
    processHost: (options) =>
      new BrowserProcessBroker({ ...options, onError: (error) => errors.push(String(error)) }),
  });
  const descriptors = new DescriptorTable();
  const input = new PipeController({ relay: "manual" });
  const pipe = new PipeController({ relay: "manual" });
  let output = "";
  let drainingOutput: ReturnType<typeof setInterval> | undefined;
  try {
    recordCausal("runtime-start", { selected });
    const stock = selected === "pair" || selected === "repeat" || selected === "nested";
    const killed = ["kill-start", "cpu", "wait32", "wait64"].includes(selected);
    const source = stock
      ? new Uint8Array(await (await fetch("/threads.wasm")).arrayBuffer())
      : generatedRuntimeThreadModule(selected);
    const fixtureSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    check(
      !stock ||
        fixtureSha256 === "410f9f16ee994fd58a9e3e3382fbf0c092d5231518e9d6a21360582ca402fa40",
      "stock artifact changed",
    );
    runtime.registerAdapter("thread-proof", (context, service) =>
      service.launchWorker(context, {
        workerUrl: local
          ? new URL("../browser/preview1-worker.ts", import.meta.url).href
          : "/preview1-worker.js",
        threaded: {
          serviceWorkerUrl: !killed
            ? local
              ? new URL("../thread/service-worker.ts", import.meta.url).href
              : "/thread-service.js"
            : local
              ? new URL("./threads-runtime-service-barrier.ts", import.meta.url).href
              : "/thread-barrier.js",
          guestWorkerUrl: local
            ? new URL("../thread/guest-bootstrap.ts", import.meta.url).href
            : "/thread-guest.js",
        },
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      }),
    );
    runtime.registerProgram("/bin/threads", { adapter: "thread-proof", source });
    await runtime.filesystem.writeFile("/bin/threads", "registered");
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const root = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
      capacity: 8,
    });
    root.data = { filesystem: runtime.filesystem.createIdentity() };
    const reader = pipe.retain(root.pid, "read");
    const writer = pipe.retain(root.pid, "write");
    descriptors.openAt(1, writer, RIGHTS_ALL, RIGHTS_ALL);
    const notices: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: createWorkerPipeCodec(),
      postMessage: (message) => notices.push(message),
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    });
    await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
    await runtime.filesystem.writeFile("/survivor", "original");
    await runtime.filesystem.writeFile("/bin/survivor", "registered");
    runtime.registerProgram("/bin/survivor", {
      adapter: "thread-proof",
      source: runtimeSurvivorModule(),
    });
    const inputReader = input.retain(root.pid, "read");
    const inputWriter = input.retain(root.pid, "write");
    descriptors.openAt(0, inputReader, RIGHTS_ALL, RIGHTS_ALL);
    const sibling = client.spawn(root.pid, {
      executable: "/bin/survivor",
      argv: ["survivor"],
      env: {},
      cwd: "/",
      job: -1,
      fds: [{ parent: 0, child: 0 }],
    });
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
    await supervisor.start(sibling);
    await until(() => client.startStatus(root.pid, sibling) === 0);
    check(
      urls.every(
        (url) =>
          !url.includes("thread-service") &&
          !url.includes("thread-guest") &&
          !url.includes("service-worker") &&
          !url.includes("guest-bootstrap"),
      ) && runtime.sharedMemory.snapshot().sharedGuests.length === 0,
      "ordinary launch eagerly created thread resources",
    );
    const pid = client.spawn(root.pid, {
      executable: "/bin/threads",
      argv: ["threads", selected],
      env: {},
      cwd: "/",
      job: -1,
      fds: [
        { parent: 1, child: 1 },
        { parent: 1, child: 2 },
      ],
    });
    killAtConstruction = () => {
      constructionKilled = true;
      void service.kill(pid, 9);
    };
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
    await supervisor.start(pid);
    const draining = (drainingOutput = setInterval(() => {
      const buffer = new Uint8Array(4096);
      const n = reader.tryRead([buffer]);
      if (n > 0) output += new TextDecoder().decode(buffer.subarray(0, n));
    }, 5));
    if (killed) {
      if (selected === "kill-start") await until(() => constructionKilled);
      if (selected !== "kill-start")
        await until(
          () =>
            client.startStatus(root.pid, pid) === 0 &&
            (selected === "cpu" ? guestReady > 0 : registered > 0),
        );
      const before = runtime.sharedMemory.snapshot().sharedGuests;
      check(
        before.length === 1 && before[0]?.chargedBytes === 33554432,
        "one admitted ceiling before kill",
      );
      await until(() => !!heldSections);
      recordCausal("kill-request", { pid });
      await service.kill(pid, 9);
      await deadline(drainMarker, "fixture drain marker deadline");
      recordCausal("drain-marker-observed", { pid, revoked: drainRevoked });
      check(
        heldSections && Atomics.load(heldSections, 0) === 1,
        "real section disappeared before release",
      );
      check(!client.childExited(root.pid, pid), "process collected before filesystem safety");
      fenceBlocked = true;
      recordCausal("fixture-probe-post-before", { barriers: barriers.size });
      for (const worker of barriers) worker.postMessage({ kind: "fixture-probe" });
      recordCausal("fixture-probe-post-after", { barriers: barriers.size });
      recordCausal("fixture-release-post-before", { barriers: barriers.size });
      for (const worker of barriers) worker.postMessage({ kind: "fixture-release" });
      recordCausal("fixture-release-post-after", { barriers: barriers.size });
      await deadline(barrierRelease, "fixture release deadline");
      await deadline(fixtureProbe, "fixture probe deadline");
      check(fixtureProbeReceived, "same-process fixture probe did not return");
    }
    let exit;
    try {
      exit = await deadline(supervisor.waitForExit(root.pid, pid), "Runtime pair deadline");
    } finally {
      clearInterval(draining);
    }
    const buffer = new Uint8Array(4096);
    const n = reader.tryRead([buffer]);
    if (n > 0) output += new TextDecoder().decode(buffer.subarray(0, n));
    check(
      !killed
        ? exit.kind === "exited" && exit.code === 0
        : exit.kind === "signaled" && exit.code === 9,
      `Runtime pair outcome ${JSON.stringify(exit)}, output ${output}, errors ${errors}`,
    );
    check(
      output ===
        (stock
          ? `threads-ok mode=${selected} main-static=1369948382 main-tls=901\n`
          : selected === "join"
            ? "c"
            : ""),
      `Runtime pair stdout ${output}`,
    );
    check(
      inputWriter.tryWrite([new Uint8Array([1])]) === 1,
      "could not release ordinary sibling stdin",
    );
    const siblingExit = await deadline(
      supervisor.waitForExit(root.pid, sibling),
      "ordinary sibling filesystem deadline",
    );
    check(
      siblingExit.kind === "exited" && siblingExit.code === 0,
      `ordinary sibling failed ${JSON.stringify(siblingExit)}`,
    );
    check(
      new TextDecoder().decode(await runtime.filesystem.readFile("/survivor")) === "Xriginal",
      "ordinary sibling did not write and read the real filesystem",
    );
    await runtime.filesystem.writeFile("/after-thread", "filesystem survives");
    check(
      new TextDecoder().decode(await runtime.filesystem.readFile("/after-thread")) ===
        "filesystem survives",
      "filesystem continued after thread terminal",
    );
    await deadline(runtime.dispose(), "Runtime disposal deadline");
    check(errors.length === 0, errors.join("\n"));
    const snapshot = runtime.sharedMemory.snapshot();
    check(
      snapshot.sharedGuests.every(
        (item) =>
          item.phase === "awaiting-collection" &&
          item.fence === "passed" &&
          item.aliases.retained === 0 &&
          item.continuations.active === 0,
      ),
      "aggregate did not retire",
    );
    check(stopped === created.length, `Worker stop mismatch ${stopped}/${created.length}`);
    return {
      selected,
      ...hostInfo(),
      siblingExit,
      fenceBlocked,
      registered,
      guestReady,
      stopped,
      fixtureSha256,
      exit,
      output,
      workers: created.length,
      sharedGuests: snapshot.sharedGuests,
      debtBytes: snapshot.debtBytes,
      controlDebts: snapshot.holders
        .filter((holder) => holder.label === "guest-control" && holder.state === "debt")
        .map((holder) => holder.declaredBytes),
      causalEvents,
    };
  } finally {
    if (!barrierReleased)
      for (const worker of barriers) worker.postMessage({ kind: "fixture-release" });
    clearInterval(drainingOutput);
    descriptors.dispose();
    pipe.dispose();
    input.dispose();
    try {
      await runtime.dispose();
    } finally {
      for (const worker of created) worker.terminate();
      globalThis.Worker = NativeWorker;
    }
  }
}

async function until(predicate: () => boolean): Promise<void> {
  let timer: ReturnType<typeof setInterval>;
  await deadline(
    new Promise<void>((resolve) => {
      timer = setInterval(() => {
        if (predicate()) resolve();
      }, 5);
    }),
    "thread entry observation deadline",
  ).finally(() => clearInterval(timer));
}

function hostInfo() {
  return {
    userAgent: globalThis.navigator?.userAgent ?? "Bun",
    isolated: globalThis.crossOriginIsolated ?? false,
  };
}
