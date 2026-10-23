import { createRuntime, type Runtime } from "../index.js";
import {
  FilesystemClient,
  createWorkspaceVfs,
  revokeFilesystem,
  type NamespaceCut,
  type NamespaceEntry,
  type WorkspaceVfs,
} from "../fs/index.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function complete(
  workspace: WorkspaceVfs,
): Promise<{ cut: NamespaceCut; file: NamespaceEntry | undefined }> {
  let file: NamespaceEntry | undefined;
  const cursor = workspace.snapshot();
  try {
    for (;;) {
      const page = await cursor.next();
      if (page.kind === "complete") return { cut: page.cut, file };
      check(page.kind === "entries", `Snapshot returned ${page.kind}`);
      check(page.entries.length <= 128, "Unbounded page");
      file ??= page.entries.find((entry) => entry.path === "/file");
    }
  } finally {
    await cursor.close();
  }
}
function workerCall(
  worker: Worker,
  request: unknown,
  transfer: Transferable[] = [],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
    };
    const receive = (event: MessageEvent<unknown>) => {
      cleanup();
      const data = event.data;
      if (data && typeof data === "object" && "failure" in data)
        reject(new Error(String(data.failure)));
      else resolve(data);
    };
    const fail = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message));
    };
    worker.addEventListener("message", receive);
    worker.addEventListener("error", fail);
    worker.postMessage(request, transfer);
  });
}
async function death(url: string): Promise<void> {
  const observe: unknown = Reflect.get(globalThis, "__publicationWaitForClose");
  check(typeof observe === "function", "Missing native worker-close observer");
  await observe(new URL(url, location.href).href);
}
type WriteObservation =
  | { kind: "returned"; stage: string; value: unknown }
  | { kind: "threw"; stage: string; error: unknown; state: ReturnType<typeof writeState> };

function writeState(peer: FilesystemClient) {
  const connection = peer.connection;
  const control = connection.publication?.buffers.control;
  return {
    owner: connection.owner,
    handleSections: Atomics.load(new Int32Array(connection.sections), 0),
    epoch: Atomics.load(new Int32Array(connection.epoch), 0),
    globalLock: Atomics.load(peer.shared.cells, 1),
    publicationControl: control ? Array.from(new Int32Array(control)) : null,
    residentKind: connection.residentPublication?.kind ?? null,
    revocations: connection.revocations.map((buffer) => Atomics.load(new Int32Array(buffer), 0)),
    dirty: peer.shared.dirtyAdmission.diagnostics(Atomics.load(peer.shared.cells, 2) * 65536),
  };
}
function observeWrite<T>(
  events: WriteObservation[],
  peer: FilesystemClient,
  stage: string,
  invoke: () => T,
): T {
  try {
    const value = invoke();
    events.push({ kind: "returned", stage, value });
    return value;
  } catch (error) {
    const detail =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            errno: "errno" in error ? error.errno : null,
          }
        : String(error);
    events.push({ kind: "threw", stage, error: detail, state: writeState(peer) });
    throw error;
  }
}
function diagnosticWrite(
  peer: FilesystemClient,
  handle: number,
  mode: "memory" | "fast",
  operation: { byte: number; offset: number; label: string },
): number {
  const events: WriteObservation[] = [];
  const before = writeState(peer);
  const directWrite = peer.shared.directWrite;
  const domain = peer.shared.publication;
  const admit = domain?.admit;
  const next = domain?.next;
  peer.shared.directWrite = (...args) => {
    check(args[8] === true, "One-shot write changed to blocking I/O");
    return observeWrite(events, peer, "shared.directWrite", () =>
      directWrite.apply(peer.shared, args),
    );
  };
  if (domain && admit && next) {
    domain.admit = (...args) =>
      observeWrite(events, peer, "publication.admit", () => admit.apply(domain, args));
    domain.next = (...args) =>
      observeWrite(events, peer, "publication.next", () => next.apply(domain, args));
  }
  try {
    return observeWrite(events, peer, "tryWrite", () =>
      peer.tryWrite(handle, [new Uint8Array([operation.byte])], operation.offset),
    );
  } finally {
    peer.shared.directWrite = directWrite;
    if (domain && admit && next) {
      domain.admit = admit;
      domain.next = next;
    }
    console.log(
      "WORKSPACE_DIRECT_DIAGNOSTIC=" +
        JSON.stringify(
          {
            mode,
            handle,
            operation,
            before,
            events,
            after: writeState(peer),
          },
          (_, value) => (typeof value === "bigint" ? String(value) : value),
        ),
    );
    check(
      Atomics.load(new Int32Array(peer.connection.sections), 0) === before.handleSections,
      "Direct write leaked its connection section",
    );
    check(
      Atomics.load(peer.shared.cells, 1) === before.globalLock,
      "Direct write changed enclosing global lock ownership",
    );
  }
}
function directWrites(
  peer: FilesystemClient,
  handle: number,
  mode: "memory" | "fast",
  otherOwner: number,
): void {
  const owner = peer.connection.owner;
  const domain = peer.shared.publication;
  check(domain && otherOwner !== owner, "Contention needs a distinct live owner");
  // The fixture admits each synchronous cell before it calls nonblocking I/O.
  // A completed guest RPC does not promise that the filesystem's global lock is idle.
  peer.shared.mutate(
    undefined,
    undefined,
    () => {
      const before = peer.shared.snapshot(handle);
      const cut = domain.cut();
      const state = writeState(peer);
      const slots = peer.shared.slots.slice();
      const publication = domain.diagnostics();
      check(before && state.globalLock === otherOwner, "Fixture did not hold the global lock");
      const result = diagnosticWrite(peer, handle, mode, {
        byte: 90,
        offset: 2,
        label: "other-owner-held",
      });
      const after = peer.shared.snapshot(handle);
      const originalOneShotSuccess = result === 1;
      check(result === -6, `Contended tryWrite returned ${result}, expected -6`);
      check(
        after && JSON.stringify(after) === JSON.stringify(before),
        "Rejected write changed file bytes or metadata",
      );
      check(
        slots.every((value, index) => value === peer.shared.slots[index]),
        "Rejected write changed file slots or their lock owners",
      );
      check(domain.cut().generation === cut.generation, "Rejected write published a change");
      check(
        JSON.stringify(domain.diagnostics()) === JSON.stringify(publication),
        "Rejected write leaked publication admission or a receipt",
      );
      check(
        JSON.stringify(writeState(peer).dirty) === JSON.stringify(state.dirty),
        "Rejected write changed dirty admission",
      );
      check(
        Atomics.load(new Int32Array(peer.connection.epoch), 0) === state.epoch,
        "Rejected write advanced the mutation epoch",
      );
      check(
        Atomics.load(peer.shared.cells, 1) === otherOwner,
        "Rejected write stole the enclosing global lock",
      );
      console.log(
        "WORKSPACE_CAUSAL_RED=" +
          JSON.stringify({
            mode,
            result,
            originalOneShotSuccess,
            owner,
            otherOwner,
            generation: String(cut.generation),
            bytes: Array.from(after.data),
          }),
      );
    },
    otherOwner,
  );
  check(Atomics.load(peer.shared.cells, 1) !== otherOwner, "Fixture retained the other owner lock");
  // This is a new admitted operation with different bytes and offset, not an EAGAIN retry.
  peer.shared.mutate(
    undefined,
    undefined,
    () => {
      check(
        Atomics.load(peer.shared.cells, 1) === owner,
        "Successful cell lacks fixture admission",
      );
      const result = diagnosticWrite(peer, handle, mode, {
        byte: 89,
        offset: 1,
        label: "explicitly-admitted",
      });
      check(result === 1, `Admitted tryWrite returned ${result}, expected 1`);
      const bytes = new Uint8Array(3);
      check(peer.tryRead(handle, [bytes], 0) === 3, "Admitted direct read failed");
      check(
        bytes[0] === 88 && bytes[1] === 89 && bytes[2] === 99,
        "Incorrect direct write/read bytes",
      );
      console.log(
        "WORKSPACE_CAUSAL_GREEN=" + JSON.stringify({ mode, result, bytes: Array.from(bytes) }),
      );
    },
    owner,
  );
  check(Atomics.load(peer.shared.cells, 1) !== owner, "Fixture retained its admitted global lock");
  check(
    Atomics.load(new Int32Array(peer.connection.sections), 0) === 0,
    "Fixture leaked its connection section",
  );
}
async function run(mode: "memory" | "fast"): Promise<void> {
  const name = `workspace-public-${crypto.randomUUID()}`;
  const workerURL = `/fs-worker.js?owner=${name}`;
  const runtime = createRuntime({ filesystem: { mode, workspace: true, name, workerURL } });
  let peer: FilesystemClient | undefined;
  let guest: Worker | undefined;
  const guestURL = `/guest.js?owner=${name}`;
  try {
    const fs = runtime.filesystem;
    const workspace = fs.workspace;
    check(workspace, "Public workspace capability missing");
    check(!("client" in workspace), "Projection leaked its root client");
    await fs.writeFile("/file", "abc");
    for (let index = 0; index < 130; index++) await fs.writeFile(`/src/f${index}`, "x");
    const connection = fs.fork();
    check(connection.publication?.observer === undefined, "Fork inherited root observer");
    peer = new FilesystemClient(connection);
    let denied = false;
    try {
      createWorkspaceVfs(peer);
    } catch {
      denied = true;
    }
    check(denied, "Guest gained workspace observer");
    const root = await peer.asyncCall("preopen", ["/"]);
    const resolved = await peer.asyncCall("resolve", [root, "file"]);
    peer.retain(resolved.node);
    const held = workspace.snapshot();
    check((await held.next()).kind === "entries", "No streamed page");
    await peer.asyncCall("setMtime", [resolved.node, 123]);
    check((await held.next()).kind === "restart", "Metadata change did not restart scan");
    const initial = await complete(workspace);
    guest = new Worker(guestURL, { type: "module" });
    const borrowed = fs.fork();
    runtime.retainConsumer({
      filesystem: borrowed,
      revoke: () => revokeFilesystem(borrowed),
      async stop() {
        guest?.terminate();
        await death(guestURL);
      },
    });
    await workerCall(guest, { connection: borrowed, mode: "wasi" }, [borrowed.port]);
    await workerCall(guest, { operation: "write", byte: 88 });
    directWrites(peer, resolved.node, mode, borrowed.owner);
    const changes = await workspace.changes(initial.cut.watermark);
    check(
      changes.kind === "changes" && changes.batches.length === 2,
      "Missing WASI/direct changes",
    );
    const writes = changes.batches
      .flatMap((batch) => batch.changes)
      .filter((change) => change.kind === "write");
    check(
      writes.length === 2 &&
        writes.every((change) => change.paths[0] === "/file" && typeof change.version === "bigint"),
      "Incorrect historical write projection",
    );
    const abort = new AbortController();
    const cursor = workspace.snapshot(undefined, abort.signal);
    await cursor.next();
    abort.abort();
    check((await cursor.next()).kind === "cancelled", "Cursor did not cancel");
    await cursor.close();
    const saved = await complete(workspace);
    check(saved.file, "Missing saved file identity");
    await fs.flush();
    const live = workspace.snapshot();
    await live.next();
    peer.dispose();
    peer = undefined;
    await runtime.dispose();
    await death(workerURL);
    check((await live.next()).kind === "stopped", "Disposed cursor survived owner");
    check(
      (await workspace.changes(changes.next)).kind === "stopped",
      "Disposed history survived owner",
    );
    if (mode === "fast") await reopen(name, saved);
  } finally {
    peer?.dispose();
    await runtime.dispose();
    guest?.terminate();
    await death(workerURL);
    if (mode === "fast") await deleteDatabase(name);
  }
}
async function reopen(name: string, saved: Awaited<ReturnType<typeof complete>>): Promise<void> {
  const url = `/fs-worker.js?reopen=${name}`;
  const runtime: Runtime = createRuntime({
    filesystem: { mode: "fast", name, workspace: true, workerURL: url },
  });
  try {
    const bytes = await runtime.filesystem.readFile("/file");
    check(bytes?.[0] === 88 && bytes[1] === 89, "Public mode lost flushed data on reopen");
    check(runtime.filesystem.workspace, "Reopened projection missing");
    const recovered = await complete(runtime.filesystem.workspace);
    check(recovered.file?.id === saved.file?.id, "Reopen changed recovered FileId");
    check(recovered.file?.version === saved.file?.version, "Reopen changed recovered FileVersion");
    check(recovered.cut.workspace === saved.cut.workspace, "Reopen changed logical workspace");
    check(
      recovered.cut.watermark.history !== saved.cut.watermark.history,
      "Reopen reused volatile history",
    );
    check(
      (await runtime.filesystem.workspace.changes(saved.cut.watermark)).kind === "gap",
      "Old history resumed after reopen",
    );
  } finally {
    await runtime.dispose();
    await death(url);
  }
}
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Public workspace fixture retained IndexedDB"));
  });
}
/** @browserEntry Executed by the public workspace browser runner through its bundled URL. */
export async function runWorkspaceBrowser(): Promise<string[]> {
  await run("memory");
  await run("fast");
  return [
    "public runtime worker memory",
    "public persistent worker flush/reopen",
    "WASI/direct/metadata all-writer handoff",
    "cursor cancellation and owner death",
  ];
}
