import { PersistentBackend } from "../fs/persistent.js";
import { CHUNK_SIZE } from "../fs/indexeddb-chunks.js";
import type { StorageBackend } from "../fs/storage.js";

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const empty = new Uint8Array();
function payload(generation: number) {
  return new Uint8Array(CHUNK_SIZE * 2 + 17).fill(generation);
}
function writeFile(backend: PersistentBackend, path: string, bytes: Uint8Array): void {
  equal(backend.execute("writeFile", [path], bytes), undefined, `writeFile ${path} succeeds`);
}
export function seedChange(backend: PersistentBackend, generation: number): void {
  writeFile(backend, "/source", payload(generation));
  if (generation === 1) writeFile(backend, "/target", new Uint8Array([91, 92]));
}
export function replaceAndRename(backend: PersistentBackend): void {
  writeFile(backend, "/source", payload(99));
  writeFile(backend, "/added", new Uint8Array([17]));
  const root = backend.fs.handleForNode(backend.fs.root);
  const source = backend.fs.resolve(root, "source");
  const target = backend.fs.resolve(root, "target");
  invariant(typeof source !== "number" && typeof target !== "number", "rename resolves both paths");
  equal(backend.execute("rename", [source, target], empty), 0, "rename succeeds without errno");
  const node = backend.fs.lookup("/target");
  invariant(node, "renamed file exists");
  equal(
    backend.execute("setMode", [backend.fs.handleForNode(node), 0o400], empty),
    0,
    "supported setMode succeeds without errno",
  );
}
function logicalState(backend: PersistentBackend) {
  return ["/source", "/target", "/added"].map((path) => {
    const node = backend.fs.lookup(path);
    if (!node) return { path, absent: true };
    const identity = backend.identity(backend.fs.handleForNode(node));
    return {
      path,
      ino: node.ino,
      mode: node.mode,
      id: identity.id.toString(),
      version: identity.version.toString(),
      workspace: backend.workspaceId,
    };
  });
}
export async function recoveredState(backend: PersistentBackend) {
  const metadata = logicalState(backend);
  const files = [];
  for (const entry of metadata) {
    if (entry.absent) continue;
    await backend.prepare("readFile", [entry.path]);
    const bytes = backend.execute("readFile", [entry.path], empty);
    invariant(bytes instanceof Uint8Array, "recovered file bytes exist");
    files.push({ path: entry.path, bytes: Array.from(bytes) });
  }
  return { namespace: Array.from(backend.fs.root.children.keys()).sort(), metadata, files };
}
export async function opened(storage: StorageBackend) {
  return PersistentBackend.open(storage, { intervalMs: 0 });
}
export function equal(actual: unknown, expected: unknown, label: string): void {
  invariant(JSON.stringify(actual) === JSON.stringify(expected), label);
}
export async function checkReopen(
  backend: PersistentBackend,
  expected: Awaited<ReturnType<typeof recoveredState>>,
  discardedIds: readonly string[],
) {
  const actual = await recoveredState(backend);
  equal(
    actual,
    expected,
    "reopen selects one complete namespace, mode, identity and payload state",
  );
  writeFile(backend, "/after-reopen", new Uint8Array([7]));
  const node = backend.fs.lookup("/after-reopen");
  invariant(node, "new file exists");
  const identity = backend.identity(backend.fs.handleForNode(node));
  invariant(
    !discardedIds.includes(identity.id.toString()),
    "reopen allocation never reuses old or abandoned FileId",
  );
  return {
    namespace: actual.namespace,
    metadata: actual.metadata,
    files: await Promise.all(actual.files.map(fileProof)),
    freshId: identity.id.toString(),
  };
}

async function fileProof(file: Awaited<ReturnType<typeof recoveredState>>["files"][number]) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(file.bytes)));
  return {
    path: file.path,
    length: file.bytes.length,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

export function modeDelta(
  before: Awaited<ReturnType<typeof recoveredState>>,
  after: Awaited<ReturnType<typeof recoveredState>>,
) {
  const from = before.metadata.find((entry) => entry.path === "/target")?.mode;
  const to = after.metadata.find((entry) => entry.path === "/target")?.mode;
  equal(from, 0o600, "target starts with the seeded writable mode");
  equal(to, 0o400, "mutation changes target mode to supported read-only mode");
  invariant(from !== to, "checkpoint states have a nontrivial target mode delta");
  return { from, to };
}

export async function closeCells(
  backends: readonly Pick<PersistentBackend, "dispose">[],
  owners: readonly Pick<StorageBackend, "close">[],
  remove: () => Promise<unknown> = async () => undefined,
): Promise<void> {
  const disposed = await Promise.allSettled(
    backends.map((backend) => Promise.resolve().then(() => backend.dispose())),
  );
  const closed = await Promise.allSettled(
    owners.map((storage) => Promise.resolve().then(() => storage.close())),
  );
  const removed = await Promise.allSettled([Promise.resolve().then(remove)]);
  const failures = disposed
    .concat(closed, removed)
    .flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, "Storage cell cleanup failed");
}
