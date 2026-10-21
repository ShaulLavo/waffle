import { acquirePublicationGuard, createResidentConnection, record, residentDescriptor, residentRequest, ResidentAttachment, text } from "../fs/publication-attachment";
import { revokeFilesystem, type FilesystemConnection } from "../fs/protocol";
import type { ResidentDescriptor } from "../fs/publication-grant";

class FixtureWorker {
  readonly worker: Worker;
  readonly url: string;
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  private events = new Map<string, unknown>();
  private failure: Error | undefined;
  private waiting = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  constructor(path: string, private expectedStartupFailure = false) {
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
    if (data.type === "cleanup-error" || data.event === "failure" || (data.type === "error" && !this.expectedStartupFailure)) this.fail(new Error(JSON.stringify(data)));
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
  async request(operation: string, body?: unknown, transfer: Transferable[] = []): Promise<unknown> {
    const id = crypto.randomUUID(), answer = Promise.withResolvers<unknown>();
    this.pending.set(id, answer);
    const timer = setTimeout(() => answer.reject(new Error(`fixture ${operation} timed out`)), 10000);
    try {
      this.worker.postMessage({ id, operation, body }, transfer);
      return await answer.promise;
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async until(event: string): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.events.has(event)) return this.events.get(event);
    const answer = Promise.withResolvers<unknown>();
    this.waiting.set(event, answer);
    const timer = setTimeout(() => answer.reject(new Error(`fixture event ${event} timed out`)), 10000);
    try { return await answer.promise; } finally { clearTimeout(timer); this.waiting.delete(event); }
  }
  async terminate(): Promise<void> {
    const observed = Reflect.get(globalThis, "__publicationWaitForClose");
    if (typeof observed !== "function") throw new Error("native worker death observer unavailable");
    const joined: Promise<unknown> = observed(this.url);
    this.worker.terminate();
    await joined;
  }
}
let authority: FixtureWorker | undefined, attachment: ResidentAttachment | undefined;
let descriptor: ResidentDescriptor | undefined;
const guests = new Map<string, { worker: FixtureWorker; connection: FilesystemConnection }>();
let claimGate: Int32Array | undefined;
async function startGuest(mode: string): Promise<unknown> {
  if (!descriptor) throw new Error("descriptor missing");
  const worker = new FixtureWorker("/resident-guest.js"), connection = createResidentConnection(descriptor);
  guests.set(mode, { worker, connection });
  await worker.request("start", { mode, connection }, [connection.port]);
  return worker.until("ready");
}
async function queuedAttachmentControl(): Promise<unknown> {
  const workspace = `queued-${crypto.randomUUID()}`;
  const exclusive = await acquirePublicationGuard(workspace, "exclusive", new AbortController().signal);
  const candidate = new ResidentAttachment({ workspace, instance: "not-opened", epoch: 1, description: "not-issued", handle: 1 }, () => false);
  let accepted = false;
  const pending = candidate.attach().then(() => { accepted = true; }, () => {});
  candidate.invalidate();
  await candidate.stop();
  await pending;
  await exclusive.release();
  const proof = await acquirePublicationGuard(workspace, "exclusive", new AbortController().signal, true);
  await proof.release();
  return { accepted, joined: true };
}
async function cancelledStartupControl(): Promise<unknown> {
  const workspace = `startup-${crypto.randomUUID()}`;
  const exclusive = await acquirePublicationGuard(workspace, "exclusive", new AbortController().signal);
  const connection = createResidentConnection({ workspace, instance: "cancelled", epoch: 1, description: "never-opened", handle: 1 });
  const worker = new FixtureWorker("/resident-guest.js", true);
  try {
    await worker.request("start", { mode: "wasi", connection }, [connection.port]);
    revokeFilesystem(connection);
    return await worker.until("finished");
  } finally { await worker.terminate(); await exclusive.release(); }
}
export async function control(operation: string, value?: unknown): Promise<unknown> {
  if (operation === "authority") {
    authority = new FixtureWorker("/resident-authority.js");
    descriptor = residentDescriptor(await authority.request("start", text(value)));
    attachment = new ResidentAttachment(descriptor, () => false);
    await attachment.attach();
    return descriptor;
  }
  if (operation === "peer") {
    descriptor = residentDescriptor(value);
    attachment = new ResidentAttachment(descriptor, () => false);
    await attachment.attach();
    return { attached: true, authorityRootReceived: false };
  }
  if (operation === "queuedAttachment") return queuedAttachmentControl();
  if (operation === "cancelledStartup") return cancelledStartupControl();
  if (operation === "startGuest") return startGuest(text(value));
  if (operation === "authorityInspect" || operation === "authorityBypass") return authority?.request(operation === "authorityInspect" ? "inspect" : "bypass");
  if (operation === "changes") return authority?.request("changes", value);
  if (operation === "pageStop") { await attachment?.stop(); return null; }
  if (operation === "authorityDeath") { await authority?.terminate(); authority = undefined; return { observedNativeDeath: true }; }
  if (operation === "exclusive") {
    if (!descriptor) throw new Error("descriptor missing");
    try {
      const guard = await acquirePublicationGuard(descriptor.workspace, "exclusive", new AbortController().signal, true);
      await guard.release(); return true;
    } catch { return false; }
  }
  const body = record(value), mode = text(body.mode), guest = guests.get(mode);
  if (!guest) throw new Error(`missing guest ${mode}`);
  if (operation === "prepare") return guest.worker.request("prepare", residentRequest(body.request));
  if (operation === "call") return guest.worker.request("call", body.request);
  if (operation === "settle") return guest.worker.request("settle");
  if (operation === "stopGuest") { await guest.worker.request("stop"); await guest.worker.until("finished"); return null; }
  if (operation === "guestDeath") { await guest.worker.terminate(); return { observedNativeDeath: true }; }
  if (operation === "cancelStartup") { revokeFilesystem(guest.connection); return guest.worker.until("finished"); }
  if (operation === "armClaim") {
    claimGate = new Int32Array(new SharedArrayBuffer(4));
    await guest.worker.request("armClaim", claimGate.buffer);
    void guest.worker.request("call", body.request).catch(() => {});
    await guest.worker.until("claimed");
    return { claimed: true };
  }
  if (operation === "releaseClaim") { if (claimGate) { Atomics.store(claimGate, 0, 1); Atomics.notify(claimGate, 0); } return null; }
  throw new Error(`unknown page control ${operation}`);
}
