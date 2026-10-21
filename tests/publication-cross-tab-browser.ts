import { SharedFilesystem } from "../browser/shared-fs";
import { decodeRecord } from "../fs/storage";
import { FilesystemClient } from "../fs/client";
import {
  acquirePublicationGuard,
  attachResidentPublication,
  createResidentConnection,
  encodeResidentOutcome,
  record,
  residentDescriptor,
  residentGrant,
  residentRequest,
  residentSession,
  ResidentAttachment,
  ResidentChannel,
  stopWorkspaceBridge,
  type ResidentGrantClient,
  text,
} from "../fs/publication-attachment";
import {
  revokeFilesystem,
  releaseFilesystemReservation,
  type FilesystemConnection,
} from "../fs/protocol";
import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";

function nativeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function inspectPersistentWorkspace(name: string): Promise<unknown> {
  const database = await nativeRequest(indexedDB.open(name, 1));
  try {
    const transaction = database.transaction(["metadata", "journal"], "readonly");
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const metadata = transaction.objectStore("metadata");
    const [epoch, format, first, second, journal] = await Promise.all([
      nativeRequest(metadata.get("epoch")),
      nativeRequest(metadata.get("format")),
      nativeRequest(metadata.get(0)),
      nativeRequest(metadata.get(1)),
      nativeRequest(transaction.objectStore("journal").getAll()),
    ]);
    await completed;
    const records = await Promise.all([first, second].concat(journal).map(decodeRecord));
    const generations = records
      .filter((value) => value !== undefined)
      .map((value) => {
        const generation = record(value).generation;
        if (typeof generation !== "number") throw new Error("missing saved generation");
        return generation;
      });
    if (!generations.length) throw new Error("saved generations missing");
    return {
      inspection: "readonly-native-no-owner-claim",
      name,
      epoch,
      format,
      generation: Math.max(...generations),
    };
  } finally {
    database.close();
  }
}
async function stopOrdinaryOwner(owner: SharedFilesystem, url: string): Promise<void> {
  const observe = Reflect.get(globalThis, "__publicationWaitForClose");
  if (typeof observe !== "function") throw new Error("native worker observer missing");
  const closed: Promise<unknown> = observe(url);
  try {
    await owner.dispose();
  } finally {
    await closed;
  }
}
async function ordinaryPersistentWorkspace(name: string, seed: boolean): Promise<unknown> {
  const url = new URL(`/fs-worker.js?attempt=${crypto.randomUUID()}`, location.href).href;
  const owner = new SharedFilesystem({ name, mode: "fast", whenBusy: "wait", workerURL: url });
  try {
    if (seed) {
      await owner.mkdirp("/nested/deeper");
      await owner.writeFile("/nested/deeper/a", new Uint8Array([11, 22, 33, 44]));
      await owner.writeFile("/nested/second", new Uint8Array([91, 82, 73]));
    }
    const root: number = await owner.client.asyncCall("preopen", ["/"]);
    const entry = record(await owner.client.asyncCall("resolve", [root, "nested/deeper/a"]));
    if (seed) await owner.client.asyncCall("setMode", [entry.node, 0o400]);
    const stat = record(await owner.client.asyncCall("stat", [entry.node]));
    const first = await owner.readFile("/nested/deeper/a");
    const second = await owner.readFile("/nested/second");
    if (!first || !second) throw new Error("seeded workspace bytes missing");
    if (seed) await owner.flush();
    return {
      name,
      implementation: owner.vfs.implementation,
      format: owner.vfs.format?.id,
      first: Array.from(first),
      second: Array.from(second),
      mode: stat.mode,
      size: stat.size,
      nested: await owner.listFiles("/nested"),
      worker: url,
    };
  } finally {
    await stopOrdinaryOwner(owner, url);
  }
}
async function deletePersistentWorkspace(name: string): Promise<void> {
  const deletion = indexedDB.deleteDatabase(name);
  await new Promise<void>((resolve, reject) => {
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error);
    deletion.onblocked = () => reject(new Error(`owned database deletion blocked: ${name}`));
  });
}
async function persistentBaseline(): Promise<unknown> {
  const name = `waffle-u1-baseline-${crypto.randomUUID()}`;
  try {
    const seeded = await ordinaryPersistentWorkspace(name, true);
    const before = await inspectPersistentWorkspace(name);
    const reopened = await ordinaryPersistentWorkspace(name, false);
    const after = await inspectPersistentWorkspace(name);
    return { seeded, before, reopened, after };
  } finally {
    await deletePersistentWorkspace(name);
  }
}

class FixtureWorker {
  readonly worker: Worker;
  readonly url: string;
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  private events = new Map<string, unknown>();
  private failure: Error | undefined;
  private waiting = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  constructor(
    path: string,
    private expectedStartupFailure = false,
    private expectedCleanupFailure = false,
  ) {
    this.url = new URL(`${path}?worker=${crypto.randomUUID()}`, location.href).href;
    this.worker = new Worker(this.url, { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<unknown>) => this.receive(record(data));
    this.worker.onerror = (event) => this.fail(new Error(event.message));
    this.worker.onmessageerror = () => this.fail(new Error("invalid worker clone"));
  }
  private receive(data: Record<string, unknown>): void {
    if (data.type === "exit" || data.type === "cleanup-error" || data.type === "error") {
      this.events.set(data.type, data);
      this.waiting.get(data.type)?.resolve(data);
    }
    if (typeof data.event === "string") {
      this.events.set(data.event, data);
      this.waiting.get(data.event)?.resolve(data);
    }
    if (
      (data.type === "cleanup-error" && !this.expectedCleanupFailure) ||
      data.event === "failure" ||
      (data.type === "error" && !this.expectedStartupFailure)
    )
      this.fail(new Error(JSON.stringify(data)));
    if (typeof data.id !== "string") return;
    const pending = this.pending.get(data.id);
    this.pending.delete(data.id);
    if (data.failure) pending?.reject(new Error(String(data.failure)));
    else pending?.resolve(data.value);
  }
  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    for (const pending of this.waiting.values()) pending.reject(error);
  }
  async request(
    operation: string,
    body?: unknown,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    const id = crypto.randomUUID(),
      answer = Promise.withResolvers<unknown>();
    this.pending.set(id, answer);
    const timer = setTimeout(
      () => answer.reject(new Error(`fixture ${operation} timed out`)),
      10000,
    );
    try {
      this.worker.postMessage({ id, operation, body }, transfer);
      return await answer.promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  async until(event: string): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.events.has(event)) return this.events.get(event);
    const answer = Promise.withResolvers<unknown>();
    this.waiting.set(event, answer);
    const timer = setTimeout(
      () => answer.reject(new Error(`fixture event ${event} timed out`)),
      10000,
    );
    try {
      return await answer.promise;
    } finally {
      clearTimeout(timer);
      this.waiting.delete(event);
    }
  }
  observed(event: string): boolean {
    return this.events.has(event);
  }
  async terminate(): Promise<void> {
    const observed = Reflect.get(globalThis, "__publicationWaitForClose");
    if (typeof observed !== "function") throw new Error("native worker death observer unavailable");
    const joined: Promise<unknown> = observed(this.url);
    this.worker.terminate();
    await joined;
  }
}
let authority: FixtureWorker | undefined,
  attachment: ResidentAttachment | ResidentGrantClient | undefined;
let descriptor: ResidentDescriptor | undefined;
const guests = new Map<string, { worker: FixtureWorker; connection: FilesystemConnection }>();
let claimGate: Int32Array | undefined;
let workspaceClient: FilesystemClient | undefined;
async function ordinarySurvivorControl(): Promise<unknown> {
  const owner = new FixtureWorker("/resident-authority.js");
  const worker = new FixtureWorker("/resident-guest.js");
  const descendantWorker = new FixtureWorker("/resident-guest.js");
  try {
    const result = record(await owner.request("ordinaryRoot"));
    const connection = result.connection as FilesystemConnection;
    await worker.request("start", { mode: "proc", connection, handle: result.handle }, [
      connection.port,
    ]);
    await worker.until("ready");
    const request = { kind: "write", bytes: [2] };
    const before = record(await worker.request("call", request)).result;
    const issued = residentDescriptor(
      await owner.request("enable", `ordinary-${crypto.randomUUID()}`),
    );
    const activated = record(await worker.request("call", request)).result;
    const descendantConnection = (await worker.request("descendant")) as FilesystemConnection;
    await descendantWorker.request(
      "start",
      { mode: "proc", connection: descendantConnection, handle: result.handle },
      [descendantConnection.port],
    );
    await descendantWorker.until("ready");
    const descendant = record(await descendantWorker.request("call", request)).result;
    await owner.terminate();
    const guard = await acquirePublicationGuard(
      issued.workspace,
      "exclusive",
      new AbortController().signal,
      true,
    );
    await guard.release();
    const survivor = record(await worker.request("call", request)).result;
    return {
      before,
      activated,
      survivor,
      observedNativeAuthorityDeath: true,
      exclusive: true,
      descendant,
    };
  } finally {
    await descendantWorker.terminate();
    await worker.terminate();
    await owner.terminate();
  }
}
async function guardLifecycleControl(): Promise<unknown> {
  const pendingOwner = new FixtureWorker("/resident-authority.js");
  const idleOwner = new FixtureWorker("/resident-authority.js");
  try {
    await pendingOwner.request("beginGuard", `pending-${crypto.randomUUID()}`);
    await pendingOwner.until("guardPending");
    const pending = await pendingOwner.request("serviceWork");
    const failed = await pendingOwner.request("failGuard");
    await idleOwner.request("start", `idle-${crypto.randomUUID()}`);
    const idle = record(await idleOwner.request("idleStop"));
    return {
      pending,
      failed,
      idleStopped: idle.idleStopped,
      queued: idle.queued,
      stopped: idle.stopped,
    };
  } finally {
    await pendingOwner.terminate();
    await idleOwner.terminate();
  }
}
async function startGuest(mode: string): Promise<unknown> {
  if (!descriptor) throw new Error("descriptor missing");
  const worker = new FixtureWorker("/resident-guest.js"),
    connection = createResidentConnection(descriptor);
  guests.set(mode, { worker, connection });
  await worker.request("start", { mode, connection }, [connection.port]);
  return worker.until("ready");
}
async function queuedAttachmentControl(): Promise<unknown> {
  const workspace = `queued-${crypto.randomUUID()}`;
  const exclusive = await acquirePublicationGuard(
    workspace,
    "exclusive",
    new AbortController().signal,
  );
  const candidate = new ResidentAttachment(
    {
      kind: "file",
      workspace,
      instance: "not-opened",
      epoch: 1,
      description: "not-issued",
      handle: 1,
    },
    () => false,
  );
  let accepted = false;
  const pending = candidate.attach().then(
    () => {
      accepted = true;
    },
    () => {},
  );
  candidate.invalidate();
  await candidate.stop();
  await pending;
  await exclusive.release();
  const proof = await acquirePublicationGuard(
    workspace,
    "exclusive",
    new AbortController().signal,
    true,
  );
  await proof.release();
  return { accepted, joined: true };
}
async function cancelledStartupControl(): Promise<unknown> {
  const workspace = `startup-${crypto.randomUUID()}`;
  const exclusive = await acquirePublicationGuard(
    workspace,
    "exclusive",
    new AbortController().signal,
  );
  const connection = createResidentConnection({
    kind: "file",
    workspace,
    instance: "cancelled",
    epoch: 1,
    description: "never-opened",
    handle: 1,
  });
  const worker = new FixtureWorker("/resident-guest.js", true);
  try {
    await worker.request("start", { mode: "wasi", connection }, [connection.port]);
    revokeFilesystem(connection);
    return await worker.until("finished");
  } finally {
    await worker.terminate();
    await exclusive.release();
  }
}
async function cancelledWorkspaceStartup(): Promise<unknown> {
  const workspace = `workspace-startup-${crypto.randomUUID()}`;
  const guard = await acquirePublicationGuard(workspace, "exclusive", new AbortController().signal);
  const connection = createResidentConnection({
    kind: "workspace",
    workspace,
    instance: "cancelled",
    epoch: 1,
    description: "never-opened",
    handle: 1,
  });
  const worker = new FixtureWorker("/resident-guest.js", true);
  try {
    await worker.request("start", { mode: "wasi", connection }, [connection.port]);
    revokeFilesystem(connection);
    const finished = await worker.until("finished");
    return {
      finished,
      exit: worker.observed("exit"),
      cleanupError: worker.observed("cleanup-error"),
    };
  } finally {
    await worker.terminate();
    await guard.release();
  }
}
async function oldSettlementControl(): Promise<unknown> {
  if (!descriptor) throw new Error("descriptor missing");
  const guard = await acquirePublicationGuard(
    descriptor.workspace,
    "shared",
    new AbortController().signal,
  );
  const channel = new ResidentChannel(descriptor.workspace);
  const session = residentSession(await channel.call("open", descriptor));
  let active: ResidentGrantCell | undefined,
    queries = 0;
  channel.status = () => {
    queries++;
    return active?.snapshot();
  };
  try {
    const request = { kind: "write", offset: 0, maxBytes: 1 };
    active = new ResidentGrantCell(
      residentGrant(await channel.call("prepare", { token: session.token, request })),
    );
    active.cancel();
    const previous = encodeResidentOutcome(active.snapshot());
    await channel.call("settle", { token: session.token, outcome: previous });
    active = new ResidentGrantCell(
      residentGrant(await channel.call("prepare", { token: session.token, request })),
    );
    await channel.call("settle", { token: session.token, outcome: previous });
    let denied = false;
    try {
      await channel.call("prepare", { token: session.token, request });
    } catch {
      denied = true;
    }
    const result = { denied, queries, current: active.snapshot().kind };
    active.cancel();
    await channel.call("settle", {
      token: session.token,
      outcome: encodeResidentOutcome(active.snapshot()),
    });
    return result;
  } finally {
    await channel.call("close", { token: session.token });
    channel.close();
    await guard.release();
  }
}
async function lateAttachmentControl(): Promise<unknown> {
  if (!descriptor || !authority) throw new Error("authority missing");
  await authority.request("holdOpen");
  const candidate = new ResidentAttachment(descriptor, () => false),
    abort = new AbortController();
  let accepted = false;
  const prospective = candidate.attach(abort.signal).then(
    () => {
      accepted = true;
    },
    () => {},
  );
  await authority.until("openHeld");
  abort.abort();
  candidate.invalidate();
  const joined = candidate.stop();
  const successor = new ResidentAttachment(descriptor, () => false);
  await successor.attach();
  try {
    await authority.request("releaseOpen");
    await prospective;
    await joined;
    const client = successor.client;
    if (!client) throw new Error("successor detached by stale completion");
    await client.prepare({ kind: "read", offset: 0, maxBytes: 1 });
    const output = new Uint8Array([80]),
      count = client.tryRead(descriptor.handle, [output], 0);
    await client.settle();
    return { accepted, count, bytes: Array.from(output) };
  } finally {
    await successor.stop();
    await candidate.stop();
  }
}
async function latePreparationControl(): Promise<unknown> {
  if (!descriptor || !authority) throw new Error("authority missing");
  const client = await attachResidentPublication(descriptor, new AbortController().signal);
  await authority.request("holdPrepare");
  let denied = false;
  const preparing = client.prepare({ kind: "write", offset: 0, maxBytes: 1 }).catch(() => {
    denied = true;
  });
  await authority.until("prepareHeld");
  client.invalidate();
  const joined = client.stop();
  try {
    await authority.request("releasePrepare");
    await preparing;
    await joined;
    const inspection = record(await authority.request("inspect"));
    return {
      denied,
      count: inspection.count,
      generation: record(inspection.cut).generation,
      bytes: inspection.bytes,
    };
  } finally {
    await client.stop();
  }
}

const reservedWorkspaceChildren = new Map<string, FilesystemConnection>();
async function cancelWorkspaceChild(connection: FilesystemConnection): Promise<void> {
  revokeFilesystem(connection);
  for (const reservation of connection.reservations) releaseFilesystemReservation(reservation);
  Reflect.set(globalThis, "__workspaceChildCancelled", {
    revoked: Atomics.load(new Int32Array(connection.revocations[0]!), 0),
    reservations: connection.reservations.map((reservation) =>
      Array.from(new Int32Array(reservation.state)),
    ),
  });
  try {
    await stopWorkspaceBridge(connection);
  } finally {
    connection.port.close();
  }
}
async function workspacePageControl(
  operation: string,
  body: ReturnType<typeof record>,
): Promise<unknown> {
  if (!workspaceClient || !Array.isArray(body.args)) throw new Error("missing page workspace");
  const bytes = Array.isArray(body.bytes) ? Uint8Array.from(body.bytes) : undefined;
  try {
    return await workspaceClient.asyncCall(text(body.operation), body.args, bytes);
  } catch (error) {
    if (operation !== "workspacePageDenied") throw error;
    return Number(Reflect.get(Object(error), "errno"));
  }
}
async function workspaceGuestControl(
  operation: string,
  body: ReturnType<typeof record>,
): Promise<unknown> {
  const guest = guests.get(text(body.key));
  if (!guest) throw new Error("missing workspace guest");
  if (operation === "workspaceGuestStatus")
    return {
      exit: guest.worker.observed("exit"),
      finished: guest.worker.observed("finished"),
      cleanupError: guest.worker.observed("cleanup-error"),
    };
  if (operation === "workspaceGuestTerminal") {
    const terminal = await guest.worker.until(text(body.event));
    await guest.worker.until("finished");
    return terminal;
  }
  if (operation === "workspaceGuestReady") return guest.worker.until("ready");
  if (operation === "workspaceGuestSignalStop") return guest.worker.request("stop");
  if (operation === "workspaceGuestRevoke") {
    revokeFilesystem(guest.connection);
    return null;
  }
  if (operation === "workspaceGuestCleanupError") return guest.worker.until("cleanup-error");
  if (operation === "workspaceGuestDeath") {
    await guest.worker.terminate();
    guests.delete(text(body.key));
    return null;
  }
  if (operation === "workspaceGuestStop") {
    await guest.worker.request("stop");
    const exit = await guest.worker.until("exit");
    await guest.worker.until("finished");
    await guest.worker.terminate();
    guests.delete(text(body.key));
    return { exit };
  }
  return guest.worker.request(text(body.operation), body.request);
}
async function workspaceControl(operation: string, value: unknown): Promise<unknown> {
  if (operation === "workspaceCancelledStartup") return cancelledWorkspaceStartup();
  if (operation === "workspaceAuthority") {
    authority = new FixtureWorker("/resident-authority.js");
    return residentDescriptor(await authority.request("workspaceStart", text(value)));
  }
  if (operation === "workspacePeer") {
    descriptor = residentDescriptor(value);
    workspaceClient = new FilesystemClient(createResidentConnection(descriptor));
    await workspaceClient.attachResidentPublication();
    return { authorityRootReceived: false };
  }
  if (operation === "workspaceCut") return authority?.request("workspaceCut");
  if (operation === "workspaceChanges") return authority?.request("changes", value);
  if (operation === "workspaceStop") {
    await workspaceClient?.stopResidentPublication();
    workspaceClient?.dispose();
    return null;
  }
  if (operation === "workspaceAuthorityStop") {
    await authority?.request("workspaceStop");
    await authority?.terminate();
    return null;
  }
  const body = record(value);
  if (operation === "workspacePage" || operation === "workspacePageDenied") {
    return workspacePageControl(operation, body);
  }
  if (operation === "workspaceGuest") {
    if (!descriptor) throw new Error("missing workspace descriptor");
    const worker = new FixtureWorker(
        "/resident-guest.js",
        body.failSetup === true,
        body.cleanupFailure === true,
      ),
      connection = createResidentConnection(descriptor);
    guests.set(text(body.key), { worker, connection });
    await worker.request(
      "start",
      { mode: text(body.mode), connection, failSetup: body.failSetup },
      [connection.port],
    );
    return worker.until(body.failSetup === true ? "finished" : "ready");
  }
  if (operation === "workspaceDescendantCancelReserved") {
    const key = text(body.key),
      connection = reservedWorkspaceChildren.get(key);
    if (!connection) throw new Error("missing reserved workspace child");
    reservedWorkspaceChildren.delete(key);
    await cancelWorkspaceChild(connection);
    return null;
  }
  if (operation === "workspaceDescendantCancel" || operation === "workspaceDescendantReserve") {
    const parent = guests.get(text(body.parent));
    if (!parent) throw new Error("missing source guest");
    const inherited = record(await parent.worker.request("descendantCodec"));
    const connection = inherited.connection as FilesystemConnection;
    if (operation === "workspaceDescendantReserve") {
      reservedWorkspaceChildren.set(text(body.key), connection);
      return null;
    }
    await cancelWorkspaceChild(connection);
    return null;
  }
  if (operation === "workspaceDescendant" || operation === "workspaceDescendantQueue") {
    const parent = guests.get(text(body.parent));
    if (!parent) throw new Error("missing source guest");
    const inherited = record(await parent.worker.request("descendantCodec"));
    const connection = inherited.connection as FilesystemConnection;
    const worker = new FixtureWorker("/resident-guest.js");
    guests.set(text(body.key), { worker, connection });
    await worker.request("start", { mode: text(body.mode), connection, token: inherited.token }, [
      connection.port,
    ]);
    if (operation === "workspaceDescendantQueue") return null;
    return worker.until("ready");
  }
  return workspaceGuestControl(operation, body);
}

/** @browserEntry Invoked by the registered browser runner through its bundled URL. */
async function inspectFactoryWorkspace(name: string): Promise<unknown> {
  const metadata = record(await inspectPersistentWorkspace(name));
  const database = await nativeRequest(indexedDB.open(name, 1));
  try {
    const transaction = database.transaction("data", "readonly");
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const store = transaction.objectStore("data");
    const [keys, values]: [IDBValidKey[], unknown[]] = await Promise.all([
      nativeRequest(store.getAllKeys()),
      nativeRequest(store.getAll()),
    ]);
    await completed;
    const payloads = values.map((value, index) => {
      if (!(value instanceof Uint8Array))
        throw new Error("unexpected native payload representation");
      return { key: keys[index], bytes: Array.from(value) };
    });
    return { ...metadata, payloads };
  } finally {
    database.close();
  }
}
let persistentHolder: Awaited<ReturnType<typeof acquirePublicationGuard>> | undefined;
async function persistentControl(operation: string, value: unknown): Promise<unknown> {
  if (operation === "persistentSeed") return ordinaryPersistentWorkspace(text(value), true);
  if (operation === "persistentInspect") return inspectFactoryWorkspace(text(value));
  if (operation === "persistentDelete") {
    await deletePersistentWorkspace(text(value));
    return null;
  }
  if (operation === "persistentHold") {
    const workspace = JSON.stringify([location.origin, "indexeddb", text(value)]);
    persistentHolder = await acquirePublicationGuard(
      workspace,
      "shared",
      new AbortController().signal,
    );
    return workspace;
  }
  if (operation === "persistentProbe") {
    const workspace = JSON.stringify([location.origin, "indexeddb", text(value)]);
    try {
      const guard = await acquirePublicationGuard(
        workspace,
        "exclusive",
        new AbortController().signal,
        true,
      );
      await guard.release();
      return true;
    } catch {
      return false;
    }
  }
  if (operation === "persistentRelease") {
    await persistentHolder?.release();
    persistentHolder = undefined;
    return null;
  }
  if (operation === "persistentStart" || operation === "persistentAbortLateOpen") {
    if (authority) throw new Error("previous authority realm still retained");
    authority = new FixtureWorker("/resident-authority.js");
    const result = await authority.request(operation, value);
    if (operation === "persistentAbortLateOpen") {
      await authority.terminate();
      authority = undefined;
    }
    return result;
  }
  if (operation === "persistentStop") {
    const result = record(await authority!.request("persistentStop"));
    if (result.stopped === true) {
      await authority!.terminate();
      authority = undefined;
    }
    return result;
  }
  if (operation === "persistentFailClose") return authority!.request(operation);
  if (operation === "persistentDeath") {
    await authority!.terminate();
    authority = undefined;
    return null;
  }
  if (operation === "persistentRead") {
    const descriptor = residentDescriptor(value);
    const client = new FilesystemClient(createResidentConnection(descriptor));
    await client.attachResidentPublication();
    try {
      const root: number = await client.asyncCall("preopen", ["/"]);
      const first = record(await client.asyncCall("resolve", [root, "nested/deeper/a"]));
      const second = record(await client.asyncCall("resolve", [root, "nested/second"]));
      const stat = record(await client.asyncCall("stat", [first.node]));
      const a: Uint8Array = await client.asyncCall("read", [first.node, 4, 0]);
      const b: Uint8Array = await client.asyncCall("read", [second.node, 3, 0]);
      return { first: Array.from(a), second: Array.from(b), mode: stat.mode, size: stat.size };
    } finally {
      await client.stopResidentPublication();
      client.dispose();
    }
  }
  throw new Error(`unknown persistent page operation ${operation}`);
}
export async function control(operation: string, value?: unknown): Promise<unknown> {
  if (operation !== "persistentBaseline" && operation.startsWith("persistent"))
    return persistentControl(operation, value);
  if (operation === "persistentBaseline") return persistentBaseline();
  if (operation.startsWith("workspace")) return workspaceControl(operation, value);
  if (operation === "guardLifecycle") return guardLifecycleControl();
  if (operation === "ordinarySurvivor") return ordinarySurvivorControl();
  if (operation === "authority") {
    authority = new FixtureWorker("/resident-authority.js");
    descriptor = residentDescriptor(await authority.request("start", text(value)));
    attachment = new ResidentAttachment(descriptor, () => false);
    await attachment.attach();
    return descriptor;
  }
  if (operation === "peer") {
    if (Object.values(record(value)).some((part) => part instanceof SharedArrayBuffer))
      throw new Error("authority SAB crossed page boundary");
    descriptor = residentDescriptor(value);
    attachment = await attachResidentPublication(descriptor, new AbortController().signal);
    return { attached: true, authorityRootReceived: false };
  }
  if (operation === "lateAttachment") return lateAttachmentControl();
  if (operation === "latePreparation") return latePreparationControl();
  if (operation === "oldSettlement") return oldSettlementControl();
  if (operation === "queuedAttachment") return queuedAttachmentControl();
  if (operation === "cancelledStartup") return cancelledStartupControl();
  if (operation === "startGuest") return startGuest(text(value));
  if (operation === "authorityInspect" || operation === "authorityBypass")
    return authority?.request(operation === "authorityInspect" ? "inspect" : "bypass");
  if (operation === "changes") return authority?.request("changes", value);
  if (operation === "pageStop") {
    await attachment?.stop();
    return null;
  }
  if (operation === "authorityDeath") {
    await authority?.terminate();
    authority = undefined;
    return { observedNativeDeath: true };
  }
  if (operation === "exclusive") {
    if (!descriptor) throw new Error("descriptor missing");
    try {
      const guard = await acquirePublicationGuard(
        descriptor.workspace,
        "exclusive",
        new AbortController().signal,
        true,
      );
      await guard.release();
      return true;
    } catch {
      return false;
    }
  }
  return guestControl(operation, value);
}

async function guestControl(operation: string, value?: unknown): Promise<unknown> {
  const body = record(value),
    mode = text(body.mode),
    guest = guests.get(mode);
  if (!guest) throw new Error(`missing guest ${mode}`);
  if (operation === "armDefensiveHooks" || operation === "defensiveResult")
    return guest.worker.request(operation);
  if (operation === "prepare")
    return guest.worker.request("prepare", residentRequest(body.request));
  if (operation === "call") return guest.worker.request("call", body.request);
  if (operation === "settle") return guest.worker.request("settle");
  if (operation === "stopGuest") {
    await guest.worker.request("stop");
    await guest.worker.until("finished");
    return null;
  }
  if (operation === "guestDeath") {
    await guest.worker.terminate();
    return { observedNativeDeath: true };
  }
  if (operation === "cancelStartup") {
    revokeFilesystem(guest.connection);
    return guest.worker.until("finished");
  }
  if (operation === "armClaim") {
    claimGate = new Int32Array(new SharedArrayBuffer(4));
    await guest.worker.request("armClaim", claimGate.buffer);
    void guest.worker.request("call", body.request).catch(() => {});
    await guest.worker.until("claimed");
    return { claimed: true };
  }
  if (operation === "releaseClaim") {
    if (claimGate) {
      Atomics.store(claimGate, 0, 1);
      Atomics.notify(claimGate, 0);
    }
    return null;
  }
  throw new Error(`unknown page control ${operation}`);
}
