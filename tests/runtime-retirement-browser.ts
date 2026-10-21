import { createRuntime } from "../runtime.js";
import { withVfsImplementation } from "../fs/vfs-internal.js";
import { isRevoked, FilesystemSection, type FilesystemConnection } from "../fs/protocol.js";

function consumerRequests(worker: Worker) {
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  worker.onmessage = (event: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
    const reply = pending.get(event.data.id);
    if (!reply) return;
    pending.delete(event.data.id);
    if (event.data.error) reply.reject(new Error(event.data.error));
    else reply.resolve(event.data.value);
  };
  return (kind: string, connection?: FilesystemConnection) => {
    const id = ++next;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, kind, connection }, connection ? [connection.port] : []);
    });
  };
}

/** @browserEntry */
export async function runtimeRetirementControl(options: { attempt: string; fail: boolean }) {
  const runtime = createRuntime({
    filesystem: withVfsImplementation("indexeddb", {
      name: options.attempt,
      mode: "fast",
      whenBusy: "wait",
      workerURL: `/fs-worker.js?attempt=${options.attempt}&role=filesystem`,
    }),
  });
  const token = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner"));
  await runtime.filesystem.mkdirp("/nested");
  await runtime.filesystem.writeFile("/nested/data", new Uint8Array([17, 83, 0, 211]));
  await runtime.filesystem.writeFile("/other", "another namespace entry");
  await runtime.filesystem.flush();
  const identity = runtime.filesystem.createIdentity();
  const worker = new Worker(`/retirement-consumer.js?attempt=${options.attempt}&role=consumer`, {
    type: "module",
  });
  const request = consumerRequests(worker);
  const originalFailure = new Error("original native retained consumer stop failure");
  let stops = 0;
  let stoppedInsideSection = false;
  let active = false;
  let release = () => {};
  release = runtime.retainConsumer({
    filesystem: identity,
    revoke() {
      release();
    },
    async stop() {
      stops++;
      release();
      stoppedInsideSection ||= active;
      if (!isRevoked(identity)) throw new Error("Physical stop preceded revocation");
      if (options.fail) throw originalFailure;
      if ((await request("stop")) !== "stopped") throw new Error("Original consumer did not stop");
      worker.terminate();
    },
  });
  const connection = runtime.filesystem.connect(identity);
  const seeded = await request("start", connection);
  const section = new FilesystemSection(identity);
  section.enter();
  active = true;
  const disposal = runtime.dispose();
  const sameDisposal = runtime.dispose() === disposal;
  const synchronousDisposed = runtime.disposed;
  await Promise.resolve();
  const stopsBeforeFence = stops;
  active = false;
  section.exit();
  let failure: unknown;
  try {
    await disposal;
  } catch (error) {
    failure = error;
  }
  let methodsClosed = false;
  try {
    runtime.filesystem.createIdentity();
  } catch {
    methodsClosed = true;
  }
  const ping = options.fail ? await request("ping") : "stopped";
  const revoked = options.fail ? await request("revoked") : true;
  return {
    fail: options.fail,
    seeded,
    stops,
    stopsBeforeFence,
    stoppedInsideSection,
    sameDisposal,
    synchronousDisposed,
    methodsClosed,
    ping,
    revoked,
    originalFailure: options.fail ? failure === originalFailure : failure === undefined,
    guardHeld: Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === token,
    filesystemStatus: runtime.filesystem.state.status,
  };
}
