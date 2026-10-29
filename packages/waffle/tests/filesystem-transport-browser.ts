import {
  FilesystemClient, createFilesystemConnection, connectFilesystemIdentity,
  createProcessFilesystemIdentity,
} from "../fs/index.js";

// Historical negative-control build only; production has no protocol-version branch.
declare const LEGACY_SOURCE: boolean;
interface Result {
  ok: number; lost: number; messageerrors: number; sharedPayloads: number;
  crossOriginIsolated: boolean; retainedBytes: number; namespaceRequests: number;
}
declare global {
  interface Window { run(rounds: number, concurrency: number, prestart: boolean): Promise<Result> }
}
function bounded<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const failure = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error("transport browser test deadline")), milliseconds);
  });
  return Promise.race([pending, failure]).finally(() => clearTimeout(timer));
}
interface State {
  fs: Worker; root: ReturnType<typeof createFilesystemConnection>; workers: Set<Worker>;
  inflight: Map<number, (value: boolean) => void>; ok: number; lost: number; next: number; growth: number;
}
function prestartedWorker(workers: Set<Worker>): Promise<Worker> {
  const worker = new Worker("/child.js", { type: "module" });
  workers.add(worker);
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => { if (data.type === "ready") resolve(worker); };
    worker.onerror = event => reject(Error(event.message));
  });
}
window.run = async (rounds, concurrency, prestart) => {
  if (!prestart) throw Error("this gate requires prestarted Workers");
  const fs = new Worker("/fs.js", { type: "module" });
  const root = createFilesystemConnection();
  const client = new FilesystemClient(root.client);
  const workers = new Set<Worker>();
  const inflight = new Map<number, (value: boolean) => void>();
  const disposed = Promise.withResolvers<void>();
  let messageerrors = 0, sharedPayloads = 0;
  const state: State = { fs, root, workers, inflight, ok: 0, lost: 0, next: 0, growth: 0 };
  fs.onmessage = ({ data }) => {
    if (data.type === "messageerror") { messageerrors++; inflight.get(data.owner)?.(false); }
    if (data.type === "shared-payload") sharedPayloads++;
    if (data.type === "disposed") disposed.resolve();
    if (data.type === "error") disposed.reject(Error(data.message));
  };
  try {
    fs.postMessage({ connect: root.server }, [root.server.port]);
    await client.asyncCall("preopen", ["/"]);
    for (let round = 0; round < rounds; round++) {
      const prepared = await bounded(Promise.all(Array.from({ length: concurrency }, () => prestartedWorker(workers))), 10000);

      await Promise.all(prepared.map(worker => runChild(state, worker)));
    }
    if (!LEGACY_SOURCE) {
      state.growth = 17 * 1024 * 1024;
      await client.asyncCall("writeFile", ["/growth.bin"], new Uint8Array(state.growth).fill(90));
      const worker = await bounded(prestartedWorker(workers), 10000);
      await runChild(state, worker);
    }
    client.dispose();
    fs.postMessage({ dispose: true });
    await bounded(disposed.promise, 10000);
    const retainedBytes = LEGACY_SOURCE ? 0 : Number(Atomics.load(new BigInt64Array(root.client.requestBudget), 0));
    const namespaceRequests = LEGACY_SOURCE ? 0 : Atomics.load(new Int32Array(root.client.requestBudget), 7);
    const result = { ok: state.ok, lost: state.lost, messageerrors, sharedPayloads, crossOriginIsolated, retainedBytes, namespaceRequests };
    if (LEGACY_SOURCE && !state.lost) throw Error(`negative control did not reproduce: ${JSON.stringify(result)}`);
    if (!LEGACY_SOURCE && (state.lost || messageerrors || sharedPayloads || namespaceRequests))
      throw Error(`plain transport regression: ${JSON.stringify(result)}`);
    return result;
  } finally {
    for (const worker of workers) worker.terminate();
    client.dispose();
    root.server.port.close();
    fs.terminate();
  }
};
function runChild(state: State, worker: Worker): Promise<void> {
    const identity = createProcessFilesystemIdentity(state.root.client);
    const pair = connectFilesystemIdentity(identity, state.root.pool);
    const id = ++state.next;
    const done = Promise.withResolvers<void>();
      let finished = false;
      const timer = setTimeout(() => finish(false), 3000);
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        state.inflight.delete(identity.owner);
        worker.terminate();
        state.workers.delete(worker);
        pair.client.port.close(); pair.server.port.close();
        if (success) state.ok++; else state.lost++;
        done.resolve();
      };
      state.inflight.set(identity.owner, finish);
      worker.onmessage = ({ data }) => { if (data.type === "done") finish(data.ok === true); };
      worker.onerror = () => finish(false);
      if (LEGACY_SOURCE) state.root.client.port.postMessage({ connect: pair.server }, [pair.server.port]);
      else state.fs.postMessage({ connect: pair.server }, [pair.server.port]);
      worker.postMessage({ connection: pair.client, id, growth: state.growth }, [pair.client.port]);
    return done.promise;
  }
