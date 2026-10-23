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
    check(peer.tryWrite(resolved.node, [new Uint8Array([89])], 1) === 1, "Direct write failed");
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
