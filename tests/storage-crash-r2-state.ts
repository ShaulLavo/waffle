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
export function seedChange(backend: PersistentBackend, generation: number): void {
  backend.execute("writeFile", ["/source"], payload(generation));
  if (generation === 1) backend.execute("writeFile", ["/target"], new Uint8Array([91, 92]));
}
export function replaceAndRename(backend: PersistentBackend): void {
  backend.execute("writeFile", ["/source"], payload(99));
  backend.execute("writeFile", ["/added"], new Uint8Array([17]));
  const root = backend.fs.handleForNode(backend.fs.root);
  const source = backend.fs.resolve(root, "source");
  const target = backend.fs.resolve(root, "target");
  invariant(typeof source !== "number" && typeof target !== "number", "rename resolves both paths");
  backend.execute("rename", [source, target], empty);
  const node = backend.fs.lookup("/target");
  invariant(node, "renamed file exists");
  backend.execute("setMode", [backend.fs.handleForNode(node), 0o640], empty);
}
export function logicalState(backend: PersistentBackend) {
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
): Promise<void> {
  equal(await recoveredState(backend), expected, "reopen selects one complete namespace, mode, identity and payload state");
  backend.execute("writeFile", ["/after-reopen"], new Uint8Array([7]));
  const node = backend.fs.lookup("/after-reopen");
  invariant(node, "new file exists");
  const identity = backend.identity(backend.fs.handleForNode(node));
  invariant(!discardedIds.includes(identity.id.toString()), "reopen allocation never reuses old or abandoned FileId");
}
