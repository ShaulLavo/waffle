import { createRuntime, type NamespaceCut, type NamespaceEntry, type WorkspaceVfs } from "waffle";
import { FilesystemClient, createWorkspaceVfs, revokeFilesystem } from "waffle/fs";

import type { WorkspaceSafariGuestRequest } from "./workspace-safari-guest.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function snapshot(workspace: WorkspaceVfs) {
  const cursor = workspace.snapshot();
  const entries: NamespaceEntry[] = [];
  let pages = 0;
  try {
    for (;;) {
      const page = await cursor.next();
      if (page.kind === "complete") return { cut: page.cut, entries, pages };
      check(page.kind === "entries", `Snapshot returned ${page.kind}`);
      check(page.entries.length <= 128, "Snapshot page exceeded the public bound");
      entries.push(...page.entries);
      pages++;
    }
  } finally {
    await cursor.close();
  }
}
function call(
  worker: Worker,
  request: WorkspaceSafariGuestRequest,
  transfer: Transferable[] = [],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
    };
    const receive = ({ data }: MessageEvent<unknown>) => {
      if (data && typeof data === "object" && "hint" in data) return;
      cleanup();
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
async function cancellation(workspace: WorkspaceVfs): Promise<void> {
  const abort = new AbortController();
  const first = workspace.snapshot(undefined, abort.signal);
  const second = workspace.snapshot();
  try {
    check((await first.next()).kind === "entries", "First cursor did not stream");
    check((await second.next()).kind === "entries", "Second cursor did not stream");
    check((await workspace.snapshot().next()).kind === "pressure", "Cursor limit was not active");
    abort.abort();
    check((await first.next()).kind === "cancelled", "Cancelled cursor remained active");
  } finally {
    await first.close();
    await second.close();
  }
  const replacement = workspace.snapshot();
  const other = workspace.snapshot();
  try {
    check((await replacement.next()).kind === "entries", "Cancelled cursor leaked its slot");
    check((await other.next()).kind === "entries", "Closed cursor leaked its slot");
  } finally {
    await replacement.close();
    await other.close();
  }
}
async function orderedChanges(
  workspace: WorkspaceVfs,
  cut: NamespaceCut,
  seed: NamespaceEntry,
): Promise<void> {
  const page = await workspace.changes(cut.watermark);
  check(page.kind === "changes", `Handoff returned ${page.kind}`);
  check(page.batches.length === 5, `Expected five mutations, got ${page.batches.length}`);
  for (const [index, batch] of page.batches.entries()) {
    check(batch.seq === cut.watermark.seq + BigInt(index + 1), "Handoff sequence has a hole");
    check(batch.generation === cut.generation + BigInt(index + 1), "Generation has a hole");
  }
  const effects = page.batches.flatMap((batch) => batch.changes);
  const entryPaths = effects
    .filter((effect) => effect.kind === "entry")
    .map((effect) => [effect.beforePath, effect.afterPath]);
  check(
    JSON.stringify(entryPaths) ===
      JSON.stringify([
        [null, "/host"],
        [null, "/guest"],
        ["/guest", null],
        [null, "/guest-renamed"],
        ["/guest-renamed", null],
      ]),
    `Incorrect namespace history: ${JSON.stringify(entryPaths)}`,
  );
  const write = effects
    .filter((effect) => effect.kind === "write")
    .find((effect) => effect.paths[0] === "/seed");
  check(
    write && write.id === seed.id && write.version > seed.version,
    "Direct write lost identity",
  );
  const guestActors = page.batches.slice(1, 4).map((batch) => batch.actor);
  check(new Set(guestActors).size === 1, "One guest unexpectedly changed actor");
  check(page.batches[0]?.actor !== guestActors[0], "Host and guest shared an actor");
  const empty = await workspace.changes(page.next);
  check(empty.kind === "changes" && empty.batches.length === 0, "Empty pull repeated changes");
}
async function overflow(workspace: WorkspaceVfs, write: () => Promise<void>): Promise<number> {
  const before = await snapshot(workspace);
  for (let index = 0; index < 40; index++) await write();
  const gap = await workspace.changes(before.cut.watermark);
  check(gap.kind === "gap" && gap.resync === "snapshot", "Overflow did not demand resnapshot");
  check(gap.oldestAvailable.seq > before.cut.watermark.seq + 1n, "Gap did not lose history");
  check(
    (await workspace.changes(gap.current.watermark)).kind === "gap",
    "Gap watermark incorrectly replaced a resnapshot",
  );
  const rebuilt = await snapshot(workspace);
  const empty = await workspace.changes(rebuilt.cut.watermark);
  check(empty.kind === "changes" && empty.batches.length === 0, "Resnapshot did not recover feed");
  await write();
  const resumed = await workspace.changes(empty.next);
  check(resumed.kind === "changes" && resumed.batches.length === 1, "Feed did not resume");
  return Number(gap.current.watermark.seq - gap.oldestAvailable.seq + 1n);
}
/** @browserEntry Bundled by the dedicated runner through the public package exports. */
export async function runWorkspaceSafari() {
  check(
    crossOriginIsolated && typeof SharedArrayBuffer === "function",
    "COOP/COEP isolation missing",
  );
  const runtime = createRuntime({
    filesystem: { mode: "memory", workspace: true, workerURL: "/fs-worker.js" },
  });
  const fs = runtime.filesystem;
  const workspace = fs.workspace;
  let guest: Worker | undefined;
  let direct: FilesystemClient | undefined;
  let droppedHints = 0;
  try {
    check(workspace, "Runtime did not expose the workspace capability");
    await fs.writeFile("/seed", "seed");
    for (let index = 0; index < 130; index++) await fs.writeFile(`/f${index}`, "fixture");
    direct = new FilesystemClient(fs.fork());
    const root = await direct.asyncCall("preopen", ["/"]);
    const resolved = await direct.asyncCall("resolve", [root, "seed"]);
    direct.retain(resolved.node);
    let denied = false;
    try {
      createWorkspaceVfs(direct);
    } catch {
      denied = true;
    }
    check(denied, "Fork inherited the root-only observer grant");
    const connection = fs.fork();
    guest = new Worker("/guest.js", { type: "module" });
    const retainedGuest = guest;
    runtime.retainConsumer({
      filesystem: connection,
      revoke: () => revokeFilesystem(connection),
      stop: () => retainedGuest.terminate(),
    });
    guest.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (data && typeof data === "object" && "hint" in data) droppedHints++;
    });
    await call(guest, { connection }, [connection.port]);
    const initial = await snapshot(workspace);
    check(
      initial.pages >= 2 && initial.entries.length === 132,
      "Fixture did not cross page boundary",
    );
    const seed = initial.entries.find((entry) => entry.path === "/seed");
    check(seed, "Snapshot omitted seed");
    await fs.writeFile("/host", "host");
    await call(guest, { operation: "namespace" });
    check(droppedHints === 3, "Fixture did not discard all three application hints");
    check(
      direct.tryWrite(resolved.node, [new Uint8Array([88])], 0) === 1,
      "Direct host write failed",
    );
    await orderedChanges(workspace, initial.cut, seed);
    const after = await snapshot(workspace);
    check(
      after.entries.some((entry) => entry.path === "/host"),
      "Host creation missing",
    );
    check(!after.entries.some((entry) => entry.path.startsWith("/guest")), "Guest unlink missing");
    check((await fs.readFile("/seed"))?.[0] === 88, "Direct host data did not reach runtime");
    const retainedBatches = await overflow(workspace, () => fs.writeFile("/overflow", "fixture"));
    await cancellation(workspace);
    await workspace.close();
    await fs.writeFile("/after-projection-close", "still writable");
    check(
      (await workspace.snapshot().next()).kind === "stopped",
      "Projection close left cursor alive",
    );
    check(
      (await workspace.changes(initial.cut.watermark)).kind === "stopped",
      "Projection close left feed alive",
    );
    direct.dispose();
    direct = undefined;
    await runtime.dispose();
    check(runtime.disposed, "Runtime disposal did not settle");
    return {
      passed: [
        "public package runtime, paged snapshot and denied guest observer",
        "snapshot-to-first-pull closure across host and guest namespace mutations",
        "three dropped application hints do not lose ordered changes",
        "direct shared-memory host write retains file identity",
        "real default history overflow, explicit gap and mandatory resnapshot",
        "cancelled and closed cursors release both slots",
        "projection close preserves filesystem and runtime disposal settles",
      ],
      droppedHints,
      retainedBatches,
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      cleanup: { runtimeDisposed: runtime.disposed, guestTerminationRequested: true },
    };
  } finally {
    direct?.dispose();
    await runtime.dispose();
    guest?.terminate();
  }
}
