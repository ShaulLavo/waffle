import { afterEach, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { ProcessHandle } from "../proc/types.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createFilesystemIdentity, revokeFilesystem } from "../fs/protocol.js";
import type { ProcessAdmissionEvent } from "../proc/admission.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { PipeEndpoint, PipeErrno } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { requestSignal } from "../proc/signals.js";
import { claimOutcome, readOutcome } from "../proc/outcome.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessDirectoryId,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

async function fixture(
  options: {
    observerFailure?: "throw" | "reject";
    failModule?: boolean;
    failActivation?: boolean;
    launchResult?: Promise<ProcessHandle>;
  } = {},
) {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module: options.failModule
      ? () => {
          throw new Error("source refused");
        }
      : module,
  });
  const events: ProcessAdmissionEvent[] = [],
    errors: unknown[] = [];
  let launches = 0,
    enteredLaunch!: () => void;
  const launchEntered = new Promise<void>((resolve) => {
    enteredLaunch = resolve;
  });
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      async quiesce() {},
    },
    activate: options.failActivation
      ? async () => {
          throw new Error("activation refused");
        }
      : undefined,
    launch() {
      launches++;
      enteredLaunch();
      return options.launchResult ?? { terminate() {} };
    },
    onError(error) {
      errors.push(error);
    },
    onProcessAdmission(event) {
      events.push(event);
      if (options.observerFailure === "throw") throw new Error("observer refused");
      if (options.observerFailure === "reject")
        return Promise.reject(new Error("async observer refused"));
    },
  });
  cleanups.push(() => broker.dispose());
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  await broker.adoptRuntimeRoot(root);
  const messages: WorkerProcessMessage[] = [],
    descriptors = new DescriptorTable();
  cleanups.push(() => {
    descriptors.dispose();
  });
  const host = new WorkerPipeHost({
    transport: root,
    registry: (
      root.data as { pipeRegistry: ConstructorParameters<typeof WorkerPipeHost>[0]["registry"] }
    ).pipeRegistry,
    postMessage() {},
    pipe: { capacity: 8, maxReaders: 8, maxWriters: 8 },
  });
  const [reader, writer] = host.createPipe(),
    fd = descriptors.open(writer, 1n, 1n);
  cleanups.push(() => {
    reader.close();
  });
  function spawn(transport = root) {
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      codec: host.codec(),
      postMessage(message) {
        messages.push(message);
      },
      prepareSpawn: (pid) => {
        host.registry.registerProcess(pid);
        return {
          data: { filesystem: createFilesystemIdentity(), pipeRegistry: host.registry.handle() },
          cancel: () => host.registry.collectProcess(pid),
        };
      },
    });
    const pid = client.spawn(client.pid, {
      executable: "fixture",
      argv: ["private argument"],
      env: { SECRET: "private environment" },
      cwd: "/",
      job: -1,
      fds: [{ child: 1, parent: fd }],
    });
    descriptors.close(fd);
    const message = messages.shift()!;
    if (message.operation !== "spawn") throw new Error("expected spawn");
    return {
      pid,
      message,
      lifetime: new Int32Array(
        (message.transport.resources[0] as { endpoint: { lifetime: SharedArrayBuffer } }).endpoint
          .lifetime,
      ),
    };
  }
  return {
    broker,
    root,
    identities,
    table,
    events,
    errors,
    reader,
    spawn,
    host,
    launchEntered,
    get launches() {
      return launches;
    },
  };
}

for (const observerFailure of [undefined, "throw", "reject"] as const)
  test(`admission events describe launch without leaking payloads or failing on observer ${observerFailure ?? "success"}`, async () => {
    const f = await fixture({ observerFailure }),
      child = f.spawn();
    await f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid);
    const supervisor = await f.broker.ready();
    await supervisor.start(child.pid);
    expect(f.events.map((event) => event.stage)).toEqual([
      "received",
      "queued",
      "reserved",
      "bound",
      "starting",
      "launching",
      "launched",
    ]);
    expect(f.launches).toBe(1);
    expect(f.errors).toEqual([]);
    for (const event of f.events) {
      expect(Object.isFrozen(event)).toBe(true);
      expect(event).toEqual({
        pid: child.pid,
        parentPid: workerProcessState(f.root).pid,
        job: workerProcessState(child.message.transport).job,
        stage: event.stage,
        directory: workerProcessDirectoryId(child.message.transport),
      });
      expect(Object.keys(event).sort()).toEqual(["directory", "job", "parentPid", "pid", "stage"]);
    }
    expect(Atomics.load(child.lifetime, 0)).toBe(0);
    expect(f.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    supervisor.exit(child.pid, 0);
    await supervisor.waitForExit(workerProcessState(f.root).pid, child.pid);
    expect(Atomics.load(child.lifetime, 0)).toBe(1);
    expect(f.reader.tryRead([new Uint8Array(1)])).toBe(0);
  });

test("errors after a successful adapter launch are not admission rejections", async () => {
  const f = await fixture(),
    child = f.spawn();
  await f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid);
  const supervisor = await f.broker.ready();
  await supervisor.start(child.pid);
  expect(supervisor.get(child.pid)?.state).toBe("running");
  supervisor.failStart(child.pid, new Error("running worker failed"));
  await supervisor.waitForExit(workerProcessState(f.root).pid, child.pid);
  expect(f.events.filter((event) => event.stage === "rejected")).toEqual([]);
  expect(Atomics.load(child.lifetime, 0)).toBe(1);
});

test("launched waits for adapter promises from another realm", async () => {
  const sandbox = {} as { resolveLaunch(handle: ProcessHandle): void };
  const launchResult = runInNewContext(
    "new Promise(resolve => { globalThis.resolveLaunch = resolve; })",
    sandbox,
  ) as Promise<ProcessHandle>;
  expect(launchResult instanceof Promise).toBe(false);
  const handle = { terminate() {} };
  const f = await fixture({ launchResult });
  cleanups.push(() => {
    sandbox.resolveLaunch(handle);
  });
  const child = f.spawn();
  try {
    await f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid);
    await f.launchEntered;
    expect(f.events.at(-1)?.stage).toBe("launching");
  } finally {
    sandbox.resolveLaunch(handle);
  }
  const supervisor = await f.broker.ready();
  await supervisor.start(child.pid);
  expect(f.events.at(-1)?.stage).toBe("launched");
});

for (const reason of [
  "unknown-sender",
  "sender-revoked",
  "sender-signaled",
  "broker-disposed",
  "external-rejection",
] as const) {
  test(`browser admission reports ${reason} before discarding an unaccepted writer`, async () => {
    const f = await fixture(),
      child = f.spawn(),
      parentPid = workerProcessState(f.root).pid;
    if (reason === "sender-revoked")
      revokeFilesystem(
        (f.root.data as { filesystem: ReturnType<typeof createFilesystemIdentity> }).filesystem,
      );
    if (reason === "sender-signaled") requestSignal(workerProcessState(f.root).signals, 9);
    if (reason === "broker-disposed") f.broker.suspend();
    if (reason === "external-rejection") f.broker.rejectRuntimeMessage(child.message, parentPid);
    else
      await f.broker.runtimeMessage(
        child.message,
        reason === "unknown-sender" ? parentPid + 1000 : parentPid,
      );
    expect(f.events.map((event) => [event.stage, event.reason])).toEqual([
      ["received", undefined],
      ["rejected", reason],
    ]);
    for (const event of f.events)
      expect(event).toMatchObject({
        pid: child.pid,
        directory: workerProcessDirectoryId(child.message.transport),
      });
    expect(f.launches).toBe(0);
    expect(Atomics.load(child.lifetime, 0)).toBe(1);
  });
}

test("duplicate and explicitly rejected registered messages do not close the admitted child's writer", async () => {
  const f = await fixture(),
    child = f.spawn(),
    parentPid = workerProcessState(f.root).pid;
  await f.broker.runtimeMessage(child.message, parentPid);
  const supervisor = await f.broker.ready();
  await supervisor.start(child.pid);
  await expect(f.broker.runtimeMessage(child.message, parentPid)).rejects.toThrow(
    /already registered/,
  );
  expect(f.events.at(-1)).toMatchObject({ stage: "dropped", reason: "duplicate-process" });
  f.broker.rejectRuntimeMessage(child.message, parentPid);
  expect(f.events.at(-1)).toMatchObject({ stage: "dropped", reason: "already-registered" });
  expect(Atomics.load(child.lifetime, 0)).toBe(0);
  const writer = supervisor.get(child.pid)!.descriptors.get(1)!.resource as PipeEndpoint;
  expect(writer.tryWrite([new Uint8Array([68])])).toBe(1);
  const bytes = new Uint8Array(1);
  expect(f.reader.tryRead([bytes])).toBe(1);
  expect(bytes[0]).toBe(68);
});

test("wrong-sender diagnostics leave an authenticated later delivery's resources untouched", async () => {
  const f = await fixture(),
    child = f.spawn();
  const other = createWorkerProcessTransport({
    pid: f.identities.pid(),
    job: f.identities.job(),
    identity: f.identities.buffer,
  });
  other.data = { filesystem: createFilesystemIdentity() };
  await f.broker.adoptRuntimeRoot(other);
  await expect(
    f.broker.runtimeMessage(child.message, workerProcessState(other).pid),
  ).rejects.toThrow(/wrong sender/);
  expect(f.events.map((event) => [event.stage, event.reason])).toEqual([
    ["received", undefined],
    ["rejected", "wrong-sender"],
  ]);
  expect(Atomics.load(child.lifetime, 0)).toBe(0);
  await f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid);
  const supervisor = await f.broker.ready();
  await supervisor.start(child.pid);
  expect(f.launches).toBe(1);
});

test("a parent identity from a different shared directory has a distinct rejection reason", async () => {
  const f = await fixture();
  const foreign = createWorkerProcessTransport({
    pid: workerProcessState(f.root).pid,
    job: workerProcessState(f.root).job,
    identity: f.identities.buffer,
  });
  const child = f.spawn(foreign);
  await expect(
    f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid),
  ).rejects.toThrow(/unknown process parent/);
  expect(f.events.at(-1)).toMatchObject({
    stage: "rejected",
    reason: "directory-mismatch",
    pid: child.pid,
    directory: workerProcessDirectoryId(child.message.transport),
  });
  expect(f.events.at(-1)?.directory).not.toBe(workerProcessDirectoryId(f.root));
  expect(Atomics.load(child.lifetime, 0)).toBe(1);
});

for (const selected of ["exited", "signaled", "start-failed"] as const)
  test(`preselected child ${selected} is distinguished from a launched worker`, async () => {
    const f = await fixture(),
      child = f.spawn();
    if (selected === "signaled")
      requestSignal(workerProcessState(child.message.transport).signals, 9);
    else if (selected === "start-failed")
      claimOutcome(workerProcessState(child.message.transport).signals.outcome, {
        kind: "start-failed",
        code: 13,
      });
    else {
      const client = new WorkerProcessClient({
        transport: child.message.transport,
        descriptors: new DescriptorTable(),
        codec: f.host.codec(),
        postMessage() {},
      });
      client.exit(0);
    }
    await f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid);
    const supervisor = await f.broker.ready();
    await supervisor.waitForExit(workerProcessState(f.root).pid, child.pid);
    expect(f.events.filter((event) => event.stage === "skipped")).toMatchObject([
      {
        reason:
          selected === "signaled"
            ? "preselected-signal"
            : selected === "start-failed"
              ? "preselected-start-failed"
              : "preselected-exit",
      },
    ]);
    expect(
      f.events.some((event) => event.stage === "launching" || event.stage === "launched"),
    ).toBe(false);
    expect(Atomics.load(child.lifetime, 0)).toBe(1);
  });

for (const failure of ["activation", "binding", "start"] as const)
  test(`a ${failure} failure reports its boundary and closes inherited writers`, async () => {
    const f = await fixture({
        failActivation: failure === "activation",
        failModule: failure === "start",
      }),
      child = f.spawn();
    if (failure === "binding") child.message.transport.bindings[0]!.reference = 99;
    const admission = f.broker.runtimeMessage(child.message, workerProcessState(f.root).pid);
    if (failure === "activation" || failure === "binding")
      await expect(admission).rejects.toThrow();
    else await admission;
    if (failure !== "activation") {
      const supervisor = await f.broker.ready();
      await supervisor.start(child.pid);
      await supervisor.waitForExit(workerProcessState(f.root).pid, child.pid);
    }
    expect(f.events.filter((event) => event.stage === "rejected")).toMatchObject([
      { reason: `${failure}-failed` },
    ]);
    expect(readOutcome(workerProcessState(child.message.transport).signals.outcome)).toEqual({
      kind: "start-failed",
      code: 5,
      error: "EIO",
      status: null,
    });
    expect(f.events.some((event) => event.stage === "launched")).toBe(false);
    expect(Atomics.load(child.lifetime, 0)).toBe(1);
  });
