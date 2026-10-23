import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { createFilesystemConnection } from "../fs/protocol";
import { FilesystemService } from "../fs/service";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
type ResultShape = "normalized" | "cross-realm" | "thenable";
type Outcome<T> = { kind: "fulfilled"; value: T } | { kind: "rejected"; reason: unknown };
function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then<Outcome<T>, Outcome<T>>(
    (value) => ({ kind: "fulfilled", value }),
    (reason: unknown) => ({ kind: "rejected", reason }),
  );
}

class DeferredExecution extends MemoryBackend {
  readonly entered = Promise.withResolvers<void>();
  readonly pending: PromiseWithResolvers<unknown>;
  observedThen = false;
  executions = 0;
  constructor(readonly shape: ResultShape) {
    super();
    const OtherPromise: PromiseConstructor = runInNewContext("Promise");
    this.pending = OtherPromise.withResolvers<unknown>();
  }
  override execute(operation: string, args: unknown[], input: Uint8Array): unknown {
    if (operation !== "writeFile") return super.execute(operation, args, input);
    this.entered.resolve();
    this.executions++;
    if (this.shape === "normalized") return Promise.resolve(this.pending.promise);
    if (this.shape === "cross-realm") return this.pending.promise;
    return {
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
        this.observedThen = true;
        expect(this.shared.ownsServiceMutation).toBe(false);
        return this.pending.promise.then(resolve, reject);
      },
    };
  }
}

function fixture(backend: MemoryBackend) {
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  return {
    service,
    client,
    gate: backend.shared.writeAdmission,
    close() {
      client.dispose();
      service.dispose();
      pair.server.port.close();
    },
  };
}

const shapes: readonly ResultShape[] = ["normalized", "cross-realm", "thenable"];
for (const shape of shapes) {
  test(`received ${shape} execution retains admission until its real result settles`, async () => {
    const backend = new DeferredExecution(shape);
    const value = fixture(backend);
    const completion = value.client.submit("writeFile", ["/deferred"], new Uint8Array([1]));
    const writing = observe(completion.value());
    let settled = false;
    void writing.then(() => { settled = true; });
    const abort = new AbortController();
    let lease: Awaited<ReturnType<FilesystemService["pauseFilesystemWrites"]>> | undefined;
    let acquired = false;
    const acquiring = backend.entered.promise.then(() =>
      value.service.pauseFilesystemWrites({ signal: abort.signal }),
    );
    void acquiring.then((held) => { lease = held; acquired = true; }, () => {});
    try {
      await backend.entered.promise;
      await turn();
      expect(backend.pending.promise instanceof Promise).toBe(false);
      expect({ settled, acquired, active: value.gate.active }).toEqual({
        settled: false, acquired: false, active: 1,
      });
      expect(value.gate.inputBytes).toBe(1);
      expect(value.gate.metadataBytes).toBeGreaterThan(0);
      expect(backend.shared.ownsServiceMutation).toBe(false);
      if (shape === "thenable") expect(backend.observedThen).toBe(true);
      backend.pending.resolve(17);
      expect(await writing).toEqual({ kind: "fulfilled", value: 17 });
      lease = await acquiring;
      expect(value.gate.active).toBe(0);
      expect(value.gate.inputBytes).toBe(0);
      expect(value.gate.metadataBytes).toBe(0);
    } finally {
      backend.pending.resolve(undefined);
      abort.abort();
      await writing;
      await acquiring.catch(() => {});
      await lease?.release();
      completion.release();
      value.close();
    }
  });
}

for (const shape of shapes.slice(1)) {
  for (const reason of [undefined, null, false, 0, "", new Error("backend settlement failed")]) {
    test(`received ${shape} rejection ${String(reason)} stays owned and retains shutdown identity`, async () => {
      const backend = new DeferredExecution(shape);
      const value = fixture(backend);
      const completion = value.client.submit("writeFile", ["/rejected"], new Uint8Array([1]));
      const writing = observe(completion.value());
      let settled = false;
      void writing.then(() => { settled = true; });
      try {
        await backend.entered.promise;
        await turn();
        expect(settled).toBe(false);
        expect(value.gate.active).toBe(1);
        expect(backend.shared.ownsServiceMutation).toBe(false);
        backend.pending.reject(reason);
        expect(await writing).toMatchObject({ kind: "rejected", reason: { errno: 29 } });
        expect(value.gate.active).toBe(0);
        expect(await observe(value.service.shutdown())).toEqual({ kind: "rejected", reason });
        expect(value.gate.inputBytes).toBe(0);
        expect(value.gate.metadataBytes).toBe(0);
      } finally {
        backend.pending.resolve(undefined);
        await writing;
        completion.release();
        value.close();
      }
    });
  }
}

for (const shape of shapes.slice(1)) {
  test(`shutdown joins cancelled received ${shape} execution before retirement`, async () => {
    const backend = new DeferredExecution(shape);
    const value = fixture(backend);
    const completion = value.client.submit("writeFile", ["/cancelled"], new Uint8Array([1]));
    const writing = observe(completion.value());
    try {
      await backend.entered.promise;
      completion.cancel();
      expect(await writing).toMatchObject({ kind: "rejected", reason: { errno: 11 } });
      completion.release();
      let stopped = false;
      const stopping = value.service.shutdown();
      void stopping.then(() => { stopped = true; });
      await turn();
      expect({ stopped, active: value.gate.active, input: value.gate.inputBytes }).toEqual({
        stopped: false, active: 1, input: 1,
      });
      backend.pending.resolve(undefined);
      await stopping;
      expect(value.gate.active).toBe(0);
      expect(value.gate.inputBytes).toBe(0);
      expect(value.gate.metadataBytes).toBe(0);
    } finally {
      backend.pending.resolve(undefined);
      await writing;
      completion.release();
      value.close();
    }
  });
}

class ColdPreparation extends MemoryBackend {
  readonly entered = Promise.withResolvers<void>();
  readonly pending = Promise.withResolvers<void>();
  prepared = false;
  executions = 0;
  prepare(operation: string): Promise<void> | undefined {
    if (operation !== "writeFile" || this.prepared) return;
    this.prepared = true;
    this.entered.resolve();
    return this.pending.promise;
  }
  override execute(operation: string, args: unknown[], input: Uint8Array): unknown {
    if (operation === "writeFile") this.executions++;
    return super.execute(operation, args, input);
  }
}

for (const stopping of [false, true]) {
  test(`received cold preparation retires only after settlement, shutdown=${stopping}`, async () => {
    const backend = new ColdPreparation();
    const value = fixture(backend);
    const completion = value.client.submit("writeFile", ["/cold"], new Uint8Array([1]));
    const writing = observe(completion.value());
    try {
      await backend.entered.promise;
      const before = value.gate.metadataBytes;
      const done = stopping ? value.service.shutdown() : Promise.resolve(value.client.dispose());
      await turn();
      expect(value.gate.active).toBe(1);
      expect(value.gate.inputBytes).toBe(1);
      expect(before).toBeGreaterThan(0);
      expect(value.gate.metadataBytes).toBe(before);
      expect(backend.executions).toBe(0);
      backend.pending.resolve();
      await done;
      await writing;
      await turn();
      expect(backend.executions).toBe(0);
      expect(backend.fs.readFile("/cold")).toBeUndefined();
      expect(value.gate.active).toBe(0);
      expect(value.gate.inputBytes).toBe(0);
      expect(value.gate.metadataBytes).toBe(0);
    } finally {
      backend.pending.resolve();
      await writing;
      completion.release();
      value.close();
    }
  });
}

for (const reason of [undefined, new Error("cold preparation failed")]) {
  test(`shutdown retires rejected cold preparation and preserves ${String(reason)}`, async () => {
    const backend = new ColdPreparation();
    const value = fixture(backend);
    const completion = value.client.submit("writeFile", ["/cold"], new Uint8Array([1]));
    const writing = observe(completion.value());
    try {
      await backend.entered.promise;
      const stopping = observe(value.service.shutdown());
      await turn();
      expect(value.gate.active).toBe(1);
      backend.pending.reject(reason);
      expect(await stopping).toEqual({ kind: "rejected", reason });
      await writing;
      expect(backend.executions).toBe(0);
      expect(value.gate.active).toBe(0);
      expect(value.gate.inputBytes).toBe(0);
      expect(value.gate.metadataBytes).toBe(0);
    } finally {
      backend.pending.resolve();
      await writing;
      completion.release();
      value.close();
    }
  });
}


test("shutdown retires a received request queued behind unsettled execution without executing it", async () => {
  const backend = new DeferredExecution("normalized");
  const value = fixture(backend);
  const first = value.client.submit("writeFile", ["/first"], new Uint8Array([1]));
  const writing = observe(first.value());
  let second: ReturnType<FilesystemClient["submit"]> | undefined;
  try {
    await backend.entered.promise;
    second = value.client.submit("writeFile", ["/queued"], new Uint8Array([2]));
    await turn();
    expect(Atomics.load(second.cells, 7)).toBe(1);
    expect(value.gate.active).toBe(2);
    const stopping = value.service.shutdown();
    await turn();
    expect(backend.executions).toBe(1);
    expect(value.gate.active).toBe(2);
    backend.pending.resolve(undefined);
    await stopping;
    await writing;
    expect(backend.executions).toBe(1);
    expect(value.gate.active).toBe(0);
    expect(value.gate.inputBytes).toBe(0);
    expect(value.gate.metadataBytes).toBe(0);
  } finally {
    backend.pending.resolve(undefined);
    await writing;
    first.release();
    second?.release();
    value.close();
  }
});
