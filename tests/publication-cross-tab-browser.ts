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
  type ResidentGrantClient,
  text,
} from "../fs/publication-attachment";
import { revokeFilesystem, type FilesystemConnection } from "../fs/protocol";
import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";

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
  ) {
    this.url = new URL(`${path}?worker=${crypto.randomUUID()}`, location.href).href;
    this.worker = new Worker(this.url, { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<unknown>) => this.receive(record(data));
    this.worker.onerror = (event) => this.fail(new Error(event.message));
    this.worker.onmessageerror = () => this.fail(new Error("invalid worker clone"));
  }
  private receive(data: Record<string, unknown>): void {
    if (typeof data.event === "string") {
      this.events.set(data.event, data);
      this.waiting.get(data.event)?.resolve(data);
    }
    if (
      data.type === "cleanup-error" ||
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
    { workspace, instance: "not-opened", epoch: 1, description: "not-issued", handle: 1 },
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

/** @browserEntry Invoked by the registered browser runner through its bundled URL. */
export async function control(operation: string, value?: unknown): Promise<unknown> {
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
