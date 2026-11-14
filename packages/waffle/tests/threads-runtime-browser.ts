import { runtimeSurvivorModule, generatedRuntimeThreadModule } from "./threads-runtime-modules.js";
import { DescriptorTable } from "../core/descriptors.js";
import { RIGHTS_ALL } from "../core/rights.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { createThreadRuntime } from "./threads-runtime-host.js";
import { cleanupThreadRuntime, releaseThreadBarriers } from "./threads-runtime-cleanup.js";
import type { SharedGuestSnapshot } from "../memory/reservations.js";
import { stockThreadCase, type RuntimeThreadCase } from "./threads-runtime-cases.js";
export type { RuntimeThreadCase } from "./threads-runtime-cases.js";

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

function checkStockBackings(
  observations: readonly (readonly SharedGuestSnapshot[])[],
  retired: readonly SharedGuestSnapshot[],
): void {
  check(
    observations
      .concat([retired])
      .every(
        (items) =>
          items.length === 1 &&
          items[0]?.id === retired[0]?.id &&
          items[0]?.initialPages === 17 &&
          items[0]?.sourceMaximumPages === 16384 &&
          items[0]?.actualMaximumPages === 512 &&
          items[0]?.chargedBytes === 33554432,
      ),
    "stock aliases did not share one source-qualified 32 MiB backing",
  );
  check(peakAliases(observations) >= 3, "stock case did not observe concurrent backing aliases");
}

function peakAliases(observations: readonly (readonly SharedGuestSnapshot[])[]): number {
  return observations.reduce(
    (peak, items) =>
      items.reduce(
        (peak, item) =>
          Math.max(peak, item.aliases.reserved + item.aliases.transferred + item.aliases.retained),
        peak,
      ),
    0,
  );
}
export async function runThreadsRuntime(
  selected: RuntimeThreadCase = "pair",
  local = false,
  expectedFixtureSha256?: string,
) {
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
  const drainMarker = Promise.withResolvers<void>();
  let barrierReleased = false;
  const barrierRelease = Promise.withResolvers<void>();
  let fixtureProbeReceived = false;
  const fixtureProbe = Promise.withResolvers<void>();
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
  Object.assign(globalThis, { __waffleRuntimeSafariCausalEvents: causalEvents });
  const workerTargets = new WeakMap<Worker, string>();
  let observeBacking = (_memory: WebAssembly.Memory) => {};
  // Hold the native object through the retirement snapshot, without copying its bytes.
  let backingMemory: WebAssembly.Memory | undefined;
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
          drainMarker.resolve();
        }
        if (data?.kind === "fixture-released") {
          barrierReleased = true;
          barrierRelease.resolve();
        }
        if (data?.kind === "fixture-probe-received") {
          fixtureProbeReceived = true;
          fixtureProbe.resolve();
        }
      });
    }
    override postMessage(
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ): void {
      if (
        message &&
        typeof message === "object" &&
        "memory" in message &&
        message.memory instanceof WebAssembly.Memory
      )
        observeBacking(message.memory);
      const target = workerTargets.get(this) ?? "unknown";
      recordCausal("worker-post", {
        worker: target,
        messageKind:
          message && typeof message === "object" && "kind" in message
            ? message.kind
            : typeof message,
      });
      if (
        barriers.has(this) &&
        message &&
        typeof message === "object" &&
        "kind" in message &&
        message.kind === "thread-service" &&
        !("__waffleCausal" in message)
      ) {
        message = { ...message, __waffleCausal: causalCounter };
      }
      if (transfer === undefined) return super.postMessage(message);
      if (Array.isArray(transfer)) return super.postMessage(message, transfer);
      return super.postMessage(message, transfer);
    }
    override terminate() {
      if (barriers.has(this) && heldSections && Atomics.load(heldSections, 0) !== 0)
        throw new Error("service terminated with a live filesystem section");
      stopped++;
      return super.terminate();
    }
  };
  const runtime = createThreadRuntime(local, errors);
  const descriptors = new DescriptorTable();
  const backingObservations: ReturnType<typeof runtime.sharedMemory.snapshot>["sharedGuests"][] =
    [];
  observeBacking = (memory) => {
    check(
      !backingMemory || backingMemory === memory,
      "Worker aliases used different native memories",
    );
    backingMemory = memory;
    const backings = runtime.sharedMemory.snapshot().sharedGuests;
    if (backings.length) backingObservations.push(backings);
  };
  const input = new PipeController({ relay: "manual" });
  const pipe = new PipeController({ relay: "manual" });
  let output = "";
  let drainingOutput: ReturnType<typeof setInterval> | undefined;
  try {
    recordCausal("runtime-start", { selected });
    const stock = stockThreadCase(selected);
    const killed = ["kill-start", "cpu", "wait32", "wait64"].includes(selected);
    const source = stock
      ? new Uint8Array(await (await fetch("/threads.wasm")).arrayBuffer())
      : generatedRuntimeThreadModule(selected);
    const fixtureSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    check(
      !stock || fixtureSha256 === expectedFixtureSha256,
      "stock artifact does not match the verified producer receipt",
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
      await deadline(drainMarker.promise, "fixture drain marker deadline");
      check(drainRevoked, "fixture drain started without real filesystem revocation");
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
      await deadline(fixtureProbe.promise, "fixture probe deadline");
      check(fixtureProbeReceived, "same-process fixture probe did not return");
      recordCausal("fixture-release-post-before", { barriers: barriers.size });
      for (const worker of barriers) worker.postMessage({ kind: "fixture-release" });
      recordCausal("fixture-release-post-after", { barriers: barriers.size });
      await deadline(barrierRelease.promise, "fixture release deadline");
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
      backingMemory && backingMemory.buffer instanceof SharedArrayBuffer,
      "missing native shared backing observation",
    );
    check(
      snapshot.sharedGuests.length === 1,
      "expected one process backing at aggregate retirement",
    );
    check(
      snapshot.sharedGuests.every(
        (item) =>
          item.phase === "awaiting-collection" &&
          item.fence === "passed" &&
          item.aliases.reserved === 0 &&
          item.aliases.transferred === 0 &&
          item.aliases.retained === 0 &&
          item.continuations.active === 0 &&
          item.continuations.retained === 0,
      ),
      "aggregate did not retire",
    );
    if (stock) checkStockBackings(backingObservations, snapshot.sharedGuests);
    const controlDebts = snapshot.holders.filter((holder) => holder.state === "debt");
    check(
      controlDebts.every((holder) => holder.label === "guest-control") &&
        controlDebts.reduce((sum, holder) => sum + holder.declaredBytes, 0) === snapshot.debtBytes,
      "cleanup retained debt outside consumed controls",
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
      backingObservation: {
        samples: backingObservations.length,
        peakAliases: peakAliases(backingObservations),
      },
      debtBytes: snapshot.debtBytes,
      controlDebts: snapshot.holders
        .filter((holder) => holder.label === "guest-control" && holder.state === "debt")
        .map((holder) => holder.declaredBytes),
      causalEvents,
    };
  } finally {
    await cleanupThreadRuntime({
      release: [
        () => releaseThreadBarriers(barriers, barrierReleased),
        () => clearInterval(drainingOutput),
        () => descriptors.dispose(),
        () => pipe.dispose(),
        () => input.dispose(),
      ],
      dispose: () => runtime.dispose(),
      workers: created,
      restore: () => {
        backingMemory = undefined;
        globalThis.Worker = NativeWorker;
      },
    });
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
