import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

// Program-tools CI runs before Node export preparation; bind the real source modules.
const { mock } = await import("bun:test");
const sourceRuntime = await import("../packages/waffle/index.ts");
const sharedMemory = sourceRuntime.declareSharedMemoryPlatform({ kind: "unbounded" });
const sourceDescriptors = await import("../packages/waffle/core/descriptors.ts");
const sourceTerminals = await import("../packages/waffle/browser/runtime-terminals.ts");
const sourceFilesystem = await import("../packages/waffle/browser/shared-fs.ts");
const sourcePipes = await import("../packages/waffle/proc/pipes.ts");
const sourceClient = await import("../packages/waffle/proc/worker-client.ts");
const sourceWorkerPipes = await import("../packages/waffle/proc/worker-pipes.ts");
mock.module("waffle", () => sourceRuntime);
mock.module("waffle/core/descriptors", () => sourceDescriptors);
mock.module("waffle/browser/runtime-terminals", () => sourceTerminals);
mock.module("waffle/browser/shared-fs", () => sourceFilesystem);
mock.module("waffle/proc/pipes", () => sourcePipes);
mock.module("waffle/proc/worker-client", () => sourceClient);
mock.module("waffle/proc/worker-pipes", () => sourceWorkerPipes);

const fixtures = [
  {
    path: "packages/coreutils/fixtures/cut-tr.json",
    sha256: "570bc21ba9b602cff273a164b6077521da0418d81703a2c74a404e1de3da4129",
  },
  {
    path: "packages/findutils/provenance/bash/tests/helpers/find-cases.ts",
    sha256: "787803c753613f3f4cef8a4aae8af76162144757a4327defbec343aa61003a50",
  },
  {
    path: "packages/grep/tests/fixtures/grep-usage-cases.json",
    sha256: "95c18028d52a067a263e1a716568f8e1c5be3243f4c3da2120be9157a20d36a8",
  },
  {
    path: "packages/ripgrep/tests/helpers/rg-fixtures.ts",
    sha256: "925892683d735764e9aaf27df44ac4eada77db130ebf8e183ac44f2502aef419",
  },
  {
    path: "packages/sed/provenance/bash/tests/sed-installed-app.ts",
    sha256: "2b4add220ea037db030ecd02154efdc2f5b3909aa7df1433926ee8fd2fe4b0ba",
  },
  {
    path: "packages/findutils/provenance/bash/scripts/test-own-shell-find.ts",
    sha256: "31c65497e238453ee16b4d18d5915648ac86c15e1c9225a04e47471577cef1c9",
  },
  {
    path: "packages/findutils/provenance/bash/tests/helpers/find-browser-api.ts",
    sha256: "41f0cbd4311be15d301389d262c9db135f9196d8e5b368589daeb65c3cc085d0",
  },
] as const;

test("frozen family fixture inputs retain their exact bytes at final paths", () => {
  for (const fixture of fixtures) {
    const bytes = readFileSync(resolve(root, fixture.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256, fixture.path);
  }
});

test("runner binds real packages and the generic worker without a product substitute", () => {
  const source = readFileSync(resolve(root, "tools/family-acceptance.ts"), "utf8");
  for (const binding of [
    "installPrograms(runtime, packages, { launcher })",
    "service.launchWorker(context",
    "readonly runtime: Runtime",
    "assets.coreutils",
    "assets.findutils",
    "assets.grep",
    "assets.sed",
    "assets.ripgrep",
    "session.dispose()",
    "installation.dispose()",
  ]) {
    assert.ok(source.includes(binding), `Missing real runner binding: ${binding}`);
  }
  for (const forbidden of [
    "bash-web",
    "createRuntime(",
    "new Worker(",
    "new WebAssembly.Module",
    "registerAdapter(",
    "registerProgram(",
    "runtime_proc.",
  ]) {
    assert.ok(!source.includes(forbidden), `Unexpected runner dependency: ${forbidden}`);
  }
});

test("representative case set covers every family, descriptors and interruption", () => {
  const source = readFileSync(resolve(root, "tools/family-acceptance.ts"), "utf8");
  for (const name of [
    "coreutils cut cwd and shared filesystem",
    "find exact byte size",
    "xargs internal echo",
    "grep numbered inverted bytes",
    "sed unterminated output",
    "ripgrep explicit stdin",
    "env forwards descriptors and unbound fd fails",
    "cat interrupted on an open pipe",
  ]) {
    assert.ok(source.includes(`name: "${name}"`), `Missing acceptance case: ${name}`);
  }
  for (const fixture of fixtures.slice(0, 4)) {
    assert.ok(source.includes(`../${fixture.path}`), `Fixture is not imported: ${fixture.path}`);
  }
});

// These exercise the maintained root, not a parallel process/pipe fixture.
type TestRegistry = import("waffle/proc/pipes").PipePublicationRegistry;
type TestController = import("waffle/proc/pipes").PipeController;

async function rootLifecycleFixture() {
  const { spyOn } = await import("bun:test");
  const { createRuntime } = await import("waffle");
  const { PipePublicationRegistry, PipeController } = await import("waffle/proc/pipes");
  const { WorkerPipeHost } = await import("waffle/proc/worker-pipes");
  const { BrowserProcessBroker } = await import("../packages/waffle/browser/process-broker.ts");
  const { createProgramTestRoot } = await import("./program-test-root.ts");
  const registrations: { registry: InstanceType<typeof PipePublicationRegistry>; pid: number }[] =
    [];
  const cursors: BigInt64Array[] = [];
  const controllers = new Set<InstanceType<typeof PipeController>>();
  const relays = new Set<InstanceType<typeof PipeController>>();
  const disposed = new Set<InstanceType<typeof PipeController>>();
  const register = PipePublicationRegistry.prototype.registerProcess;
  const retain = PipeController.prototype.retain;
  const relay = PipeController.prototype.startRelay;
  const dispose = PipeController.prototype.dispose;
  const spies: Array<{ mockRestore(): void }> = [
    spyOn(PipePublicationRegistry.prototype, "registerProcess").mockImplementation(function (
      this: TestRegistry,
      pid,
    ) {
      register.call(this, pid);
      registrations.push({ registry: this, pid });
      if (pid !== registrations[0]?.pid) cursors.push(this.canonical(this.allocate(pid)));
    }),
    spyOn(PipeController.prototype, "retain").mockImplementation(function (
      this: TestController,
      pid,
      mode,
    ) {
      controllers.add(this);
      return retain.call(this, pid, mode);
    }),
    spyOn(PipeController.prototype, "startRelay").mockImplementation(function (
      this: TestController,
    ) {
      relays.add(this);
      return relay.call(this);
    }),
    spyOn(PipeController.prototype, "dispose").mockImplementation(function (this: TestController) {
      disposed.add(this);
      return dispose.call(this);
    }),
  ];
  const restore = () => {
    for (const spy of spies) spy.mockRestore();
  };
  const pendingQueues = new Set<unknown[]>();
  const processNotices: unknown[] = [];
  let allocating = false;
  const pipeHosts = new Set<InstanceType<typeof WorkerPipeHost>>();
  let deliveredInputs = 0;
  const push = Array.prototype.push;
  const createPipe = WorkerPipeHost.prototype.createPipe;
  const runtimeMessage = BrowserProcessBroker.prototype.runtimeMessage;
  spies.push(
    spyOn(Array.prototype, "push").mockImplementation(function (
      this: unknown[],
      ...items: unknown[]
    ) {
      if (allocating) pendingQueues.add(this);
      if (!allocating && pendingQueues.has(this)) push.apply(processNotices, items);
      return push.apply(this, items);
    }),
    spyOn(WorkerPipeHost.prototype, "createPipe").mockImplementation(function (
      this: InstanceType<typeof WorkerPipeHost>,
    ) {
      pipeHosts.add(this);
      const previous = allocating;
      allocating = true;
      try {
        return createPipe.call(this);
      } finally {
        allocating = previous;
      }
    }),
    spyOn(BrowserProcessBroker.prototype, "runtimeMessage").mockImplementation(function (
      this: InstanceType<typeof BrowserProcessBroker>,
      message,
      sender,
    ) {
      if (message.operation === "pipe") deliveredInputs++;
      return runtimeMessage.call(this, message, sender);
    }),
  );
  const runtime = createRuntime({
    sharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../packages/waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  let owner: Awaited<ReturnType<typeof createProgramTestRoot>> | undefined;
  return {
    runtime,
    processNotices,
    get deliveredInputs() {
      return deliveredInputs;
    },
    pendingQueue() {
      assert.equal(pendingQueues.size, 1, "only the root's input publication queue is observed");
      const queue = pendingQueues.values().next().value;
      assert.ok(queue);
      return queue;
    },
    queuedInput() {
      const host = pipeHosts.values().next().value;
      assert.ok(host);
      const pair = host.createPipe();
      pair[0].close();
      pair[1].close();
    },
    async start() {
      owner = await createProgramTestRoot(runtime);
      return owner;
    },
    duplicate(input: import("waffle/proc/pipes").PipeEndpoint) {
      const controller = controllers.values().next().value;
      assert.ok(controller, "input controller was not observed");
      return controller.duplicate(input);
    },
    async idle() {
      const registry = registrations[0]?.registry;
      assert.ok(registry, "service registry was not observed");
      for (const entry of registrations)
        assert.equal(entry.registry.processCount, 1, "only the adopted root may remain enrolled");
      const buffers = new Set(registrations.map((entry) => entry.registry.handle().buffer));
      assert.equal(buffers.size, 1, "root, host and service must share one registry");
      for (const cursor of cursors)
        assert.equal(Atomics.load(cursor, 0) & (1n << 32n), 1n << 32n, "child cursor not frozen");
      const deadline = Date.now() + 2000;
      while (Array.from(relays).some((controller) => !disposed.has(controller))) {
        assert.ok(Date.now() < deadline, "service retained a pipe controller after child cleanup");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      for (const controller of controllers)
        assert.equal(controller.closed, true, "pipe remains live");
    },
    async dispose() {
      const rootStops = await Promise.allSettled([Promise.resolve().then(() => owner?.dispose())]);
      const runtimeStops = await Promise.allSettled([
        Promise.resolve().then(() => runtime.dispose()),
      ]);
      restore();
      const failed = rootStops.concat(runtimeStops).find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}

const pipeRequest = {
  executable: "/lifecycle",
  argv: ["lifecycle"],
  cwd: "/",
  env: {},
  input: "input ending at EOF ✓",
};

function failedEndpointExport(
  transfer: import("waffle/proc/pipes").PipeEndpoint["forProcess"],
  retained: import("waffle/proc/pipes").PipeEndpoint[],
) {
  return function (this: import("waffle/proc/pipes").PipeEndpoint, pid: number) {
    retained.push(transfer.call(this, pid));
    throw new Error("endpoint export failed after allocation");
  };
}

test("maintained root cancels pipe enrollment after preparation, export and snapshot failures", async () => {
  const { spyOn } = await import("bun:test");
  const { PipeEndpoint, PipeErrno } = await import("waffle/proc/pipes");
  const { SharedFilesystem } = await import("waffle/browser/shared-fs");
  const fixture = await rootLifecycleFixture();
  const restoreMocks: Array<() => void> = [];
  try {
    const owner = await fixture.start();
    const identity = spyOn(SharedFilesystem.prototype, "createIdentity");
    restoreMocks.push(() => identity.mockRestore());
    identity.mockImplementationOnce(() => {
      throw new Error("identity preparation failed");
    });
    await assert.rejects(owner.exec(pipeRequest), /identity preparation failed/);
    identity.mockRestore();
    await fixture.idle();
    const transfer = PipeEndpoint.prototype.forProcess;
    const exporting = spyOn(PipeEndpoint.prototype, "forProcess");
    restoreMocks.push(() => exporting.mockRestore());
    const retained: InstanceType<typeof PipeEndpoint>[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      exporting.mockImplementationOnce(failedEndpointExport(transfer, retained));
      await assert.rejects(owner.exec(pipeRequest), /endpoint export failed/);
      await fixture.idle();
    }
    exporting.mockRestore();
    for (const endpoint of retained)
      assert.equal(
        endpoint.tryRead([new Uint8Array(1)]),
        -PipeErrno.BADF,
        "failed export retained a live endpoint",
      );
    const argv = ["lifecycle"];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("request snapshot failed");
      },
    });
    await assert.rejects(owner.exec({ ...pipeRequest, argv }), /request snapshot failed/);
    await fixture.idle();
  } finally {
    for (const restore of restoreMocks) restore();
    await fixture.dispose();
  }
});

type LifecycleOutcome = "kill" | "start-failure" | "EOF";

async function readLifecycleInput(input: import("waffle/proc/pipes").PipeEndpoint) {
  const { PipeErrno } = await import("waffle/proc/pipes");
  const bytes = new Uint8Array(128),
    decoder = new TextDecoder();
  const deadline = Date.now() + 2000;
  let text = "";
  for (;;) {
    const count = input.tryRead([bytes]);
    if (count === 0) return text + decoder.decode();
    if (count === -PipeErrno.AGAIN) {
      assert.ok(Date.now() < deadline, "input did not reach EOF");
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }
    assert.ok(count > 0, `input read failed: ${count}`);
    text += decoder.decode(bytes.subarray(0, count), { stream: true });
  }
}

function lifecycleLaunch(
  outcome: LifecycleOutcome,
  launched: (pid: number) => void,
  capture: (input: import("waffle/proc/pipes").PipeEndpoint) => void,
): import("waffle").GuestLauncher {
  return async (context) => {
    const { PipeEndpoint } = await import("waffle/proc/pipes");
    const resource = context.descriptors.get(0)?.resource;
    assert.ok(resource instanceof PipeEndpoint);
    capture(resource);
    launched(context.pid);
    if (outcome === "start-failure") throw new Error("controlled launcher failure");
    assert.equal(context.started(), true);
    if (outcome === "EOF") {
      assert.equal(await readLifecycleInput(resource), pipeRequest.input);
      context.exit(0);
    }
    return { terminate() {} };
  };
}

for (const outcome of ["kill", "start-failure", "EOF"] as const) {
  test(`maintained root uses service revocation and retires input pipes on ${outcome}`, async () => {
    const { PipeEndpoint, PipeErrno } = await import("waffle/proc/pipes");
    const fixture = await rootLifecycleFixture();
    let input: InstanceType<typeof PipeEndpoint> | undefined;
    try {
      const owner = await fixture.start();
      const service = await fixture.runtime.processes();
      const entry = Promise.withResolvers<number>();
      fixture.runtime.registerAdapter(
        "lifecycle",
        lifecycleLaunch(
          outcome,
          entry.resolve,
          (resource) => (input = fixture.duplicate(resource)),
        ),
      );
      await fixture.runtime.filesystem.writeFile("/lifecycle", "fixture");
      fixture.runtime.registerProgram("/lifecycle", {
        adapter: "lifecycle",
        module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
        cooperative: true,
      });
      const pending = owner.exec(pipeRequest);
      const pid = await entry.promise;
      if (outcome === "kill") await service.kill(pid, 9);
      const actual = await pending;
      assert.equal(actual.status, outcome === "kill" ? 137 : outcome === "start-failure" ? 127 : 0);
      assert.ok(input);
      assert.equal(
        input.tryRead([new Uint8Array(1)]),
        -PipeErrno.BADF,
        "retired endpoint still usable",
      );
      await fixture.idle();
    } finally {
      input?.close();
      await fixture.dispose();
    }
  });
}

test("failed input reservations release queued buffers before rejection and never deliver them later", async () => {
  const fixture = await rootLifecycleFixture();
  try {
    const owner = await fixture.start();
    const argv = ["missing"];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("canceled snapshot");
      },
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await assert.rejects(owner.exec({ ...pipeRequest, argv }), /canceled snapshot/);
      assert.equal(fixture.pendingQueue().length, 0, "canceled pipe handle remains queued");
      await fixture.idle();
    }
    assert.equal(fixture.deliveredInputs, 0);
    const result = await owner.exec({
      executable: "/missing",
      argv: ["missing"],
      cwd: "/",
      env: {},
    });
    assert.equal(result.status, 127);
    assert.equal(fixture.deliveredInputs, 0, "a later execution published canceled pipe handles");
  } finally {
    await fixture.dispose();
  }
});

test("root disposal releases pending owned input handles and preserves unrelated process notices", async () => {
  const fixture = await rootLifecycleFixture();
  let queue: unknown[] | undefined;
  try {
    const owner = await fixture.start();
    const argv = ["missing"];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("canceled snapshot");
      },
    });
    await assert.rejects(owner.exec({ ...pipeRequest, argv }), /canceled snapshot/);
    const result = await owner.exec({
      executable: "/missing",
      argv: ["missing"],
      cwd: "/",
      env: {},
    });
    assert.equal(result.status, 127);
    const unrelated = fixture.processNotices[0];
    assert.ok(unrelated, "a real process notice was not observed");
    fixture.queuedInput();
    queue = fixture.pendingQueue();
    assert.equal(queue.length, 1);
    queue.unshift(unrelated);
    const delivered = fixture.deliveredInputs;
    await owner.dispose();
    assert.equal(queue.length, 1, "disposal retained an owned handle or removed unrelated notices");
    assert.equal(queue[0], unrelated);
    assert.equal(
      fixture.deliveredInputs,
      delivered,
      "disposal published a closed input announcement",
    );
  } finally {
    if (queue) queue.length = 0;
    await fixture.dispose();
  }
});
