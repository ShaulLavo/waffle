import { initial, openDatabase, readRegistry, transaction } from "./database.js";

function keepTransaction(store: IDBObjectStore, held: () => boolean): void {
  const request = store.get("head");
  request.onsuccess = () => { if (held()) keepTransaction(store, held); };
}
async function hold(db: IDBDatabase): Promise<() => Promise<void>> {
  const tx = db.transaction("workspace", "readwrite");
  const complete = new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
  let held = true;
  const store = tx.objectStore("workspace");
  await new Promise<void>((resolve) => {
    const first = store.get("head");
    first.onsuccess = () => { keepTransaction(store, () => held); resolve(); };
  });
  return async () => { held = false; await complete; };
}
export async function uncommittedClaim(workspace: string) {
  const db = await openDatabase(workspace);
  const controller = new AbortController();
  let updated = false;
  let release: (() => Promise<void>) | undefined;
  try {
    await transaction(db, "strict", () => ({ state: initial("fenced-safe"), result: undefined }));
    release = await hold(db);
    const work = transaction(db, "strict", (saved) => {
      if (!saved) throw new Error("Missing saved head");
      updated = true;
      saved.epoch++;
      return { state: saved, result: saved.epoch };
    }, controller.signal).then((value) => ({ committed: true, value }), (error: unknown) => ({ committed: false, error: String(error) }));
    controller.abort(new Error("cancel before strict claim admission"));
    const result = await work;
    await release();
    release = undefined;
    const saved = await readRegistry(workspace);
    return { result, updated, savedEpoch: saved?.epoch };
  } finally { await release?.(); db.close(); }
}
export async function committedClaim(workspace: string) {
  const db = await openDatabase(workspace);
  const controller = new AbortController();
  const native = db.transaction.bind(db);
  let installed = false;
  try {
    await transaction(db, "strict", () => ({ state: initial("fenced-safe"), result: undefined }));
    db.transaction = (names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) => {
      const tx = native(names, mode, options);
      tx.addEventListener("complete", () => controller.abort(new Error("cancel after strict commit")), { once: true });
      return tx;
    };
    const result = await transaction(db, "strict", (saved) => {
      if (!saved) throw new Error("Missing saved head");
      saved.epoch++;
      saved.token = "committed-fence";
      saved.closed = false;
      return { state: saved, result: saved.epoch };
    }, controller.signal);
    if (!controller.signal.aborted) installed = true;
    db.transaction = native;
    const saved = await readRegistry(workspace);
    return { result, interrupted: controller.signal.aborted, installed, savedEpoch: saved?.epoch, token: saved?.token, closed: saved?.closed };
  } finally { db.transaction = native; db.close(); }
}
export async function blockedOpen(workspace: string) {
  const blocker = await openDatabase(workspace);
  const upgrade = indexedDB.open(workspace, 2);
  const abortedUpgrade = new Promise<void>((resolve, reject) => {
    upgrade.onupgradeneeded = () => upgrade.transaction?.abort();
    upgrade.onerror = () => resolve();
    upgrade.onsuccess = () => { upgrade.result.close(); reject(new Error("Upgrade was not aborted")); };
  });
  await new Promise<void>((resolve) => { upgrade.onblocked = () => resolve(); });
  const beforeOpens = interruptions.requestedOpens();
  interruptions.startConnect(workspace);
  const started = performance.now();
  while (interruptions.requestedOpens() === beforeOpens || !(await navigator.locks.query()).held?.some((lock) => lock.name === `e5-bootstrap:${workspace}`)) {
    if (performance.now() - started > 1000) throw new Error("Bootstrap was never granted");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  interruptions.client.detach();
  const joined = interruptions.joined();
  if (!joined) throw new Error("Missing connect attempt");
  const bounded = await Promise.race([
    joined.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
  ]);
  const successor = await interruptions.client.connect(`${workspace}-successor`, "volatile-fast");
  if (successor.kind !== "ok") throw new Error(JSON.stringify(successor));
  interruptions.retainWorker();
  const before = await interruptions.snapshot();
  blocker.close();
  await abortedUpgrade;
  const barrier = await openDatabase(workspace);
  barrier.close();
  await interruptions.joined();
  return { bounded, sameWorker: interruptions.sameWorker(), unchanged: before === await interruptions.snapshot(), resources: interruptions.resources() };
}
