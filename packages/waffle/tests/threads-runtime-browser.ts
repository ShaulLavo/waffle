import { runtimeSurvivorModule, generatedRuntimeThreadModule } from "./threads-runtime-modules.js";
import { DescriptorTable } from "../core/descriptors.js";
import { RIGHTS_ALL } from "../core/rights.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { PipeController, type PipeEndpoint } from "../proc/pipes.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { createThreadRuntime } from "./threads-runtime-host.js";
import { cleanupThreadRuntime, releaseThreadBarriers } from "./threads-runtime-cleanup.js";
import type { SharedGuestSnapshot } from "../memory/reservations.js";
import type { ProcessExit } from "../proc/types.js";
import {
  isRuntimeThreadRegression,
  stockThreadCase,
  type BrowserRuntimeThreadCase,
} from "./threads-runtime-cases.js";
import {
  check,
  checkFatalRetirement,
  deadline,
  observeThreadOwner,
  releaseFatalThread,
  runOverlappingWaits,
  runReceivingGrowth,
  runThreadAdmission,
  runThreadIds,
  ThreadRegressionObservations,
  until,
} from "./threads-runtime-regression-controls.js";
import { RuntimeDescriptorCase } from "./threads-runtime-fd-browser.js";
export type { RuntimeThreadCase } from "./threads-runtime-cases.js";

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
function expectedOutput(selected: BrowserRuntimeThreadCase): string {
  if (stockThreadCase(selected))
    return `threads-ok mode=${selected} main-static=1369948382 main-tls=901\n`;
  switch (selected) {
    case "join":
      return "c";
    case "fd-read":
    case "fd-write":
      return "PRM";
    case "admission":
      return "A";
    case "growth":
      return "AB";
    case "overlapping-waits":
      return "W";
    default:
      return "";
  }
}

function checkExit(
  selected: BrowserRuntimeThreadCase,
  exit: ProcessExit,
  output: string,
  errors: readonly string[],
): void {
  const signaled = ["kill-start", "cpu", "wait32", "wait64"].includes(selected);
  const code = signaled ? 9 : selected === "fatal-exit" ? 23 : 0;
  check(
    exit.kind === (signaled ? "signaled" : "exited") && exit.code === code,
    `Runtime ${selected} outcome ${JSON.stringify(exit)}, output ${output}, errors ${errors}`,
  );
  check(output === expectedOutput(selected), `Runtime ${selected} stdout ${output}`);
}

function threadServiceUrl(
  local: boolean,
  fence: boolean,
  descriptor: RuntimeDescriptorCase | undefined,
) {
  if (descriptor)
    return local
      ? new URL("./threads-runtime-fd-service.ts", import.meta.url).href
      : "/thread-fd-service.js";
  if (fence)
    return local
      ? new URL("./threads-runtime-service-barrier.ts", import.meta.url).href
      : "/thread-barrier.js";
  return local
    ? new URL("../thread/service-worker.ts", import.meta.url).href
    : "/thread-service.js";
}

export async function runThreadsRuntime(
  selected: BrowserRuntimeThreadCase = "pair",
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
  const stopped = new Set<Worker>();
  const observations = new ThreadRegressionObservations(stopped);
  const isRegression = isRuntimeThreadRegression(selected);
  const allocator = selected === "tid-boundaries" ? await observeThreadOwner() : undefined;
  const descriptor =
    selected === "fd-read" || selected === "fd-write"
      ? new RuntimeDescriptorCase(selected === "fd-read" ? "read" : "write", local)
      : undefined;
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
      if (isRegression) observations.attach(this, target);
      descriptor?.observe(this, target);
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
      descriptor?.observePost(message);
      if (
        message &&
        typeof message === "object" &&
        "memory" in message &&
        message.memory instanceof WebAssembly.Memory
      )
        observeBacking(message.memory);
      const target = workerTargets.get(this) ?? "unknown";
      if (isRegression) observations.post(this, message);
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
      check(!stopped.has(this), "Worker received a duplicate native stop");
      stopped.add(this);
      return super.terminate();
    }
  };
  const runtime = createThreadRuntime(local, errors, descriptor?.host);
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
  const threadInput = new PipeController({ relay: "manual" });
  const pipe = new PipeController({ relay: "manual" });
  let output = "";
  let drainingOutput: ReturnType<typeof setInterval> | undefined;
  let failure: unknown;

  async function exerciseFence(pid: number, exited: () => boolean, terminate: () => Promise<void>) {
    await until(() => !!heldSections, "real filesystem section was entered");
    const before = runtime.sharedMemory.snapshot().sharedGuests;
    check(
      before.length === 1 && before[0]?.chargedBytes === 33554432,
      "one admitted ceiling before kill",
    );
    await terminate();
    await deadline(drainMarker.promise, "fixture drain marker deadline");
    check(drainRevoked, "fixture drain started without real filesystem revocation");
    recordCausal("drain-marker-observed", { pid, revoked: drainRevoked });
    check(
      heldSections && Atomics.load(heldSections, 0) === 1,
      "real section disappeared before release",
    );
    check(!exited(), "process collected before filesystem safety");
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

  async function runRegression(
    selected: BrowserRuntimeThreadCase,
    pid: number,
    inputWriter: PipeEndpoint,
  ) {
    if (descriptor) {
      await until(() => !!backingMemory, "descriptor process backing");
      check(backingMemory, "descriptor process backing");
      return descriptor.run({
        runtime,
        memory: backingMemory,
        pid,
        inputWriter,
        observations,
        readOutput: () => output,
      });
    }
    if (selected === "overlapping-waits") return runOverlappingWaits(observations);
    if (selected === "admission") return runThreadAdmission(observations);
    if (selected === "growth") return runReceivingGrowth(observations);
    if (allocator) return runThreadIds(observations, allocator);
  }

  async function prepareThreadDescriptors(rootPid: number) {
    const fds = [
      { parent: 1, child: 1 },
      { parent: 1, child: 2 },
    ];
    const writer = threadInput.retain(rootPid, "write");
    if (descriptor || selected === "fatal-exit") {
      descriptors.openAt(6, threadInput.retain(rootPid, "read"), RIGHTS_ALL, RIGHTS_ALL);
      fds.push({ parent: 6, child: 0 });
    }
    if (descriptor) {
      fds.push({ parent: 4, child: 4 }, { parent: 5, child: 5 });
      await descriptor.arm();
    }
    return { fds, writer };
  }

  try {
    recordCausal("runtime-start", { selected });
    const stock = stockThreadCase(selected);
    const killed = ["kill-start", "cpu", "wait32", "wait64"].includes(selected);
    const fatal = selected === "fatal-exit";
    const needsFence = killed || fatal;
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
          serviceWorkerUrl: threadServiceUrl(local, needsFence, descriptor),
          guestWorkerUrl:
            selected === "growth"
              ? "/thread-growth.js"
              : local
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
    const rootIdentity = runtime.filesystem.createIdentity();
    root.data = { filesystem: rootIdentity };
    await descriptor?.setup(runtime, descriptors, rootIdentity);
    const reader = pipe.retain(root.pid, "read");
    const writer = pipe.retain(root.pid, "write");
    descriptors.openAt(1, writer, RIGHTS_ALL, RIGHTS_ALL);
    const notices: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: createWorkerPipeCodec(),
      postMessage: (message) => notices.push(message),
      prepareSpawn: () => {
        const filesystem = runtime.filesystem.createIdentity();
        const data = { filesystem };
        return descriptor
          ? { data, codec: createWorkerPipeCodec({ fallback: descriptor.codec(filesystem) }) }
          : { data };
      },
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
          !url.includes("thread-fd-service") &&
          !url.includes("thread-growth") &&
          !url.includes("service-worker") &&
          !url.includes("guest-bootstrap"),
      ) && runtime.sharedMemory.snapshot().sharedGuests.length === 0,
      "ordinary launch eagerly created thread resources",
    );
    const threadDescriptors = await prepareThreadDescriptors(root.pid);
    const pid = client.spawn(root.pid, {
      executable: "/bin/threads",
      argv: ["threads", selected],
      env: {},
      cwd: "/",
      job: -1,
      fds: threadDescriptors.fds,
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
    if (needsFence) {
      if (selected === "kill-start") await until(() => constructionKilled);
      if (killed && selected !== "kill-start")
        await until(
          () =>
            client.startStatus(root.pid, pid) === 0 &&
            (selected === "cpu" ? guestReady > 0 : registered > 0),
        );
      await exerciseFence(
        pid,
        () => client.childExited(root.pid, pid),
        async () => {
          if (fatal) return releaseFatalThread(observations, pid);
          recordCausal("kill-request", { pid });
          await service.kill(pid, 9);
        },
      );
    }
    let regression: object | undefined = await runRegression(
      selected,
      pid,
      threadDescriptors.writer,
    );
    let exit;
    try {
      exit = await deadline(supervisor.waitForExit(root.pid, pid), "Runtime pair deadline");
    } finally {
      clearInterval(draining);
    }
    const buffer = new Uint8Array(4096);
    const n = reader.tryRead([buffer]);
    if (n > 0) output += new TextDecoder().decode(buffer.subarray(0, n));
    checkExit(selected, exit, output, errors);
    if (fatal) regression = await checkFatalRetirement(observations, pid);
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
    if (descriptor) regression = { ...regression, ...descriptor.checkDisposal() };
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
    if (descriptor) {
      const sizes = controlDebts.map((holder) => holder.declaredBytes).sort((a, b) => a - b);
      const debtSizes = sizes.join(",");
      check(
        debtSizes === "88,88" || debtSizes === "4,88,88",
        `unexpected descriptor control debt: ${sizes}`,
      );
    }
    check(
      stopped.size === created.length,
      `Worker stop mismatch ${stopped.size}/${created.length}`,
    );
    return {
      selected,
      ...hostInfo(),
      siblingExit,
      fenceBlocked,
      registered,
      guestReady,
      stopped: stopped.size,
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
      regression,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupThreadRuntime({
      release: [
        () => releaseThreadBarriers(barriers, barrierReleased),
        () => descriptor?.release(),
        () => clearInterval(drainingOutput),
        () => descriptors.dispose(),
        () => descriptor?.dispose(),
        () => pipe.dispose(),
        () => input.dispose(),
        () => threadInput.dispose(),
      ],
      dispose: () => runtime.dispose(),
      workers: created.map((worker) => ({
        terminate: () => {
          if (!stopped.has(worker)) NativeWorker.prototype.terminate.call(worker);
        },
      })),
      restore: () => {
        backingMemory = undefined;
        globalThis.Worker = NativeWorker;
        allocator?.restore();
      },
    }).catch((cleanup: unknown) => {
      if (!failure) throw cleanup;
      throw new AggregateError([failure, cleanup], `${String(failure)}\n${String(cleanup)}`);
    });
  }
}

function hostInfo() {
  return {
    userAgent: globalThis.navigator?.userAgent ?? "Bun",
    isolated: globalThis.crossOriginIsolated ?? false,
  };
}
