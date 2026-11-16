import { groupLinkProgram } from "./fixtures/group-link-program.js";
import { expect, test } from "bun:test";
import {
  BrowserProcessBroker,
  type ProcessController,
  type RuntimeRootOptions,
} from "../browser/process-broker.ts";
import { ProcessIdentityAllocator } from "../proc/identity.ts";
import { ProcessTable } from "../proc/table.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { createWorkerProcessTransport } from "../proc/worker-client.ts";
import { captureProcessObserver } from "../proc/observation.ts";
import { createFilesystemIdentity } from "../fs/protocol.ts";
import { testReservations } from "./fixtures/shared-memory-platform.ts";
import { WAIT_ADDR, WAIT_WIDTH, WAIT_EPOCH, WAIT_CLOSED } from "../group/protocol.ts";
import { beginDirectoryAdmission } from "../proc/directory.ts";

function pendingRoot(group: ReturnType<BrowserProcessBroker["admitRootMemoryGroup"]>) {
  const cells = new Int32Array(group.request.reply);
  Atomics.store(cells, WAIT_ADDR, 64);
  Atomics.store(cells, WAIT_WIDTH, 4);
  Atomics.store(cells, WAIT_EPOCH, 1);
  const words = new Int32Array(group.request.memory.buffer);
  return { cells, words };
}

test("adopted root native attempt closes its exact wait before awaiting the native promise", async () => {
  const invoked = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const f = await rootFixture(
    {
      stop() {
        invoked.resolve();
        return native.promise;
      },
    },
    "group",
  );
  const group = f.broker.admitRootMemoryGroup(f.transport.pid, await groupLinkProgram());
  const pending = pendingRoot(group);
  const wake = Atomics.waitAsync(pending.words, 16, 0);
  const disposing = f.broker.dispose();
  try {
    await invoked.promise;
    expect(Atomics.load(pending.cells, WAIT_CLOSED)).toBe(1);
    expect(await wake.value).toBe("ok");
    expect(f.broker.memoryGroups()[0]?.members).toBe(1);
    native.resolve();
    await disposing;
    expect(f.broker.memoryGroups()).toEqual([]);
  } finally {
    native.resolve();
    group.request.port.close();
    await disposing.catch(() => {});
  }
});

test("independent helper stop cannot authorize root group cancellation", async () => {
  const f = await rootFixture({}, "group");
  const group = f.broker.admitRootMemoryGroup(f.transport.pid, await groupLinkProgram());
  const pending = pendingRoot(group);
  const helper = f.broker.captureRootStop(f.transport.pid, () => {});
  try {
    await helper();
    expect(Atomics.load(pending.cells, WAIT_CLOSED)).toBe(0);
    group.terminating();
    expect(Atomics.load(pending.cells, WAIT_CLOSED)).toBe(1);
  } finally {
    group.stopped();
    group.request.port.close();
    await f.broker.dispose();
  }
});

test("a retained old root membership cannot terminate or acknowledge the new incarnation", async () => {
  const f = await rootFixture({ stop() {} }, "group");
  const program = await groupLinkProgram();
  const old = f.broker.admitRootMemoryGroup(f.transport.pid, program);
  const handles: unknown = Reflect.get(f.broker, "controllerNativeStops");
  if (!(handles instanceof Map)) throw new Error("missing native controller captures");
  const oldHandle: unknown = handles.get(f.transport.pid);
  if (
    !oldHandle ||
    typeof oldHandle !== "object" ||
    !("terminate" in oldHandle) ||
    typeof oldHandle.terminate !== "function"
  )
    throw new Error("missing captured old native consumer");
  old.stopped();
  const next = f.broker.admitRootMemoryGroup(f.transport.pid, program);
  try {
    old.terminating();
    old.stopped();
    await Reflect.apply(oldHandle.terminate, oldHandle, []);
    expect(Atomics.load(new Int32Array(next.request.reply), WAIT_CLOSED)).toBe(0);
    expect(f.broker.memoryGroupOf(f.transport.pid)).toBe(next.group);
  } finally {
    next.stopped();
    old.request.port.close();
    next.request.port.close();
    await f.broker.dispose();
  }
});

for (const mode of ["throw", "reject"] as const) {
  test(`root native ${mode} records the attempt, authorizes cancellation and retains debt`, async () => {
    const error = new Error("root native failure");
    const f = await rootFixture(
      {
        stop() {
          if (mode === "throw") throw error;
          return Promise.reject(error);
        },
      },
      "group",
    );
    const group = f.broker.admitRootMemoryGroup(f.transport.pid, await groupLinkProgram());
    const pending = pendingRoot(group);
    try {
      await expect(f.broker.dispose()).rejects.toBeInstanceOf(AggregateError);
      expect(Atomics.load(pending.cells, WAIT_CLOSED)).toBe(1);
      expect(f.broker.memoryGroups()[0]?.retained).toBe(1);
    } finally {
      group.request.port.close();
      await f.broker.dispose().catch(() => {});
    }
  });
}

test("failed exact-consumer binding releases a bootstrap that never escaped", async () => {
  const f = await rootFixture({ stop() {} }, "group");
  const captures: unknown = Reflect.get(f.broker, "controllerNativeStops");
  if (!(captures instanceof Map)) throw new Error("missing native consumer captures");
  const handle: unknown = captures.get(f.transport.pid);
  if (!handle || typeof handle !== "object") throw new Error("missing native consumer");
  const bind = Reflect.get(handle, "bindGroup");
  Reflect.set(handle, "bindGroup", () => {
    throw new Error("binding refused");
  });
  try {
    const program = await groupLinkProgram();
    expect(() => f.broker.admitRootMemoryGroup(f.transport.pid, program)).toThrow(
      "binding refused",
    );
    expect(f.broker.memoryGroups()).toEqual([]);
  } finally {
    Reflect.set(handle, "bindGroup", bind);
    await f.broker.dispose();
  }
});

test("an earlier directory stamp defers root cancellation and settlement retries without polling", async () => {
  const invoked = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const f = await rootFixture(
    {
      stop() {
        invoked.resolve();
        return native.promise;
      },
    },
    "group",
  );
  const group = f.broker.admitRootMemoryGroup(f.transport.pid, await groupLinkProgram());
  const pending = pendingRoot(group);
  const release = beginDirectoryAdmission(f.transport.directory);
  const wake = Atomics.waitAsync(pending.words, 16, 0);
  const disposing = f.broker.dispose();
  try {
    await invoked.promise;
    expect(Atomics.load(pending.cells, WAIT_CLOSED)).toBe(0);
    release();
    expect(await wake.value).toBe("ok");
    expect(Atomics.load(pending.cells, WAIT_CLOSED)).toBe(1);
    native.resolve();
    await disposing;
  } finally {
    release();
    native.resolve();
    group.request.port.close();
    await disposing.catch(() => {});
  }
});

async function rootFixture(
  controller: ProcessController = {},
  memory: RuntimeRootOptions["memory"] = [],
) {
  const identities = new ProcessIdentityAllocator();
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table: new ProcessTable(identities),
    registry: new ExecutableRegistry(),
    filesystem: {
      connect() {
        throw new Error("No connection is needed by a metadata root");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("No child is launched by a metadata root");
    },
    onError() {},
  });
  const transport = createWorkerProcessTransport({ identity: identities.buffer });
  transport.data = { filesystem: createFilesystemIdentity() };
  try {
    await broker.adoptRuntimeRoot(transport, { memory, ...controller });
    return { broker, transport, observer: captureProcessObserver(transport) };
  } catch (error) {
    await broker.dispose();
    throw error;
  }
}

test("a captured external root stop survives map retirement and is idempotent", async () => {
  const { broker, transport, observer } = await rootFixture();
  let calls = 0;
  const stop = broker.captureRootStop(transport.pid, () => {
    calls++;
  });
  try {
    await broker.rootExit(transport.pid, 137);
    expect(broker.transportFor(transport.pid)).toBeUndefined();
    expect(observer.read()).toEqual({
      kind: "selected",
      result: { kind: "exited", code: 137, status: 137 },
    });
    expect(stop()).toBeUndefined();
    expect(observer.read()).toEqual({ kind: "terminated" });
    await stop();
    expect(calls).toBe(1);
  } finally {
    await broker.dispose();
  }
});

test("root disposal joins captured native returns after logical retirement", async () => {
  const { broker, transport, observer } = await rootFixture();
  const native = Promise.withResolvers<void>();
  let calls = 0;
  broker.captureRootStop(transport.pid, () => {
    calls++;
    return native.promise;
  });
  try {
    await broker.rootExit(transport.pid, 0);
    const disposing = broker.dispose();
    await Promise.resolve();
    expect(observer.read().kind).toBe("selected");
    native.resolve();
    await disposing;
    expect(observer.read()).toEqual({ kind: "terminated" });
    expect(calls).toBe(1);
  } finally {
    native.resolve();
    await broker.dispose();
  }
});

test("failed root native return retains selected observation and disposal failure", async () => {
  const { broker, transport, observer } = await rootFixture();
  const failure = new Error("native stop rejected");
  let calls = 0;
  const stop = broker.captureRootStop(transport.pid, () => {
    calls++;
    return Promise.reject(failure);
  });
  try {
    await broker.rootExit(transport.pid, 0);
    expect(
      await Promise.resolve()
        .then(stop)
        .catch((error) => error),
    ).toBe(failure);
    expect(observer.read().kind).toBe("selected");
    await expect(broker.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(observer.read().kind).toBe("selected");
    expect(calls).toBe(1);
  } finally {
    await broker.dispose().catch(() => {});
  }
});

test("a metadata-only root keeps its selected result without inventing a native event", async () => {
  const { broker, transport, observer } = await rootFixture();
  try {
    await broker.rootExit(transport.pid, 0);
    expect(observer.read()).toEqual({
      kind: "selected",
      result: { kind: "exited", code: 0, status: 0 },
    });
  } finally {
    await broker.dispose();
  }
});

test("a native stop hook reentering its captured owner never invokes the consumer twice", async () => {
  const { broker, transport, observer } = await rootFixture();
  let calls = 0;
  let reentrant: void | Promise<void> = undefined;
  const stop = broker.captureRootStop(transport.pid, () => {
    calls++;
    if (calls === 1) reentrant = stop();
  });
  try {
    await broker.rootExit(transport.pid, 0);
    expect(stop()).toBeUndefined();
    await reentrant;
    expect(calls).toBe(1);
    expect(observer.read()).toEqual({ kind: "terminated" });
  } finally {
    await broker.dispose();
  }
});

for (const nativeFirst of [false, true]) {
  test(`direct root native acknowledgement retires only its controller consumer, native first=${nativeFirst}`, async () => {
    let calls = 0;
    const { broker, transport, observer } = await rootFixture({
      stop() {
        calls++;
      },
    });
    const pid = transport.pid;
    const helperReturn = Promise.withResolvers<void>();
    const helper = broker.captureRootStop(pid, () => helperReturn.promise);
    try {
      if (!nativeFirst) await broker.rootExit(pid, 0);
      broker.rootStopped(pid);
      broker.rootStopped(pid);
      if (nativeFirst) await broker.rootExit(pid, 0);
      expect(observer.read().kind).toBe("selected");
      const stopping = helper();
      expect(observer.read().kind).toBe("selected");
      helperReturn.resolve();
      await stopping;
      expect(observer.read()).toEqual({ kind: "terminated" });
      await broker.dispose();
      expect(calls).toBe(0);
    } finally {
      helperReturn.resolve();
      await broker.dispose();
    }
  });
}

for (const mode of ["void", "promise", "throw", "reject"] as const) {
  test(`controller stop keeps its own return authoritative through reentrant acknowledgement: ${mode}`, async () => {
    const native = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("root controller failed");
    let calls = 0;
    const f = await rootFixture({
      stop() {
        calls++;
        f.broker.rootStopped(f.transport.pid);
        expect(f.observer.read().kind).toBe("selected");
        entered.resolve();
        if (mode === "throw") throw failure;
        if (mode === "reject") return Promise.reject(failure);
        if (mode === "promise") return native.promise;
      },
    });
    try {
      await f.broker.rootExit(f.transport.pid, 0);
      const disposal = f.broker.dispose();
      void disposal.catch(() => {});
      await entered.promise;
      if (mode === "promise") {
        expect(f.observer.read().kind).toBe("selected");
        f.broker.rootStopped(f.transport.pid);
        expect(f.observer.read().kind).toBe("selected");
        native.resolve();
      }
      if (mode === "throw" || mode === "reject") {
        await expect(disposal).rejects.toBeInstanceOf(AggregateError);
        f.broker.rootStopped(f.transport.pid);
        expect(f.observer.read().kind).toBe("selected");
      } else {
        await disposal;
        expect(f.observer.read()).toEqual({ kind: "terminated" });
      }
      expect(calls).toBe(1);
    } finally {
      native.resolve();
      await f.broker.dispose().catch(() => {});
    }
  });
}

for (const activated of [false, true]) {
  test(`group-root return acknowledges its controller without settling another consumer, activated=${activated}`, async () => {
    let calls = 0;
    const f = await rootFixture(
      {
        stop() {
          calls++;
        },
      },
      "group",
    );
    const group = f.broker.admitRootMemoryGroup(f.transport.pid, await groupLinkProgram());
    const helper = f.broker.captureRootStop(f.transport.pid, () => {});
    try {
      if (activated) await f.broker.ready();
      await f.broker.rootExit(f.transport.pid, 0);
      group.stopped();
      group.stopped();
      expect(f.observer.read().kind).toBe("selected");
      helper();
      expect(f.observer.read()).toEqual({ kind: "terminated" });
      await f.broker.dispose();
      expect(calls).toBe(0);
    } finally {
      group.stopped();
      await f.broker.dispose();
    }
  });
}

test("root acknowledgement leaves failed helper debt and accepted admission leases owned", async () => {
  let calls = 0;
  const f = await rootFixture({
    stop() {
      calls++;
    },
  });
  const release = f.broker.retainRoot(f.transport.pid);
  const late = f.broker.captureRootStop(f.transport.pid, () =>
    Promise.reject(new Error("helper stop failed")),
  );
  try {
    await f.broker.rootExit(f.transport.pid, 0);
    f.broker.rootStopped(f.transport.pid);
    expect(f.broker.transportFor(f.transport.pid)).toBeDefined();
    expect(f.observer.read().kind).toBe("selected");
    await expect(late()).rejects.toThrow("helper stop failed");
    release();
    expect(f.broker.transportFor(f.transport.pid)).toBeUndefined();
    expect(f.observer.read().kind).toBe("selected");
    await expect(f.broker.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toBe(0);
    expect(f.observer.read().kind).toBe("selected");
  } finally {
    release();
    await f.broker.dispose().catch(() => {});
  }
});

for (const activated of [false, true]) {
  test(`standalone root native acknowledgement survives lazy adoption, activated=${activated}`, async () => {
    const f = await rootFixture();
    let calls = 0;
    const pid = f.broker.reserveRoot(
      {},
      {
        stop() {
          calls++;
        },
      },
    );
    const observer = captureProcessObserver(f.broker.rootObservation(pid));
    try {
      if (activated) await f.broker.ready();
      await f.broker.rootExit(pid, 0);
      expect(observer.read().kind).toBe("selected");
      f.broker.rootStopped(pid);
      expect(observer.read()).toEqual({ kind: "terminated" });
      await f.broker.dispose();
      expect(calls).toBe(0);
    } finally {
      await f.broker.dispose();
    }
  });
}

test("canonical root termination does not settle its independent memory-group membership", async () => {
  const f = await rootFixture({ stop() {} }, "group");
  const group = f.broker.admitRootMemoryGroup(f.transport.pid, await groupLinkProgram());
  try {
    const before = f.broker.memoryGroups();
    expect(before).toHaveLength(1);
    expect(before[0]!.members).toBe(1);
    await f.broker.rootExit(f.transport.pid, 0);
    f.broker.rootStopped(f.transport.pid);
    expect(f.observer.read()).toEqual({ kind: "terminated" });
    expect(f.broker.memoryGroups()).toEqual(before);
    group.stopped();
    expect(f.broker.memoryGroups()).toEqual([]);
  } finally {
    group.stopped();
    await f.broker.dispose();
  }
});
