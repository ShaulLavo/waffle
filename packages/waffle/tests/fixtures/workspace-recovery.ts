import { createRuntime, deleteWorkspace, VfsError } from "../../index.js";
import { withVfsImplementation, type VfsImplementation } from "../../fs/vfs-internal.js";
import { encodeRecord, type ChecksummedRecord } from "../../fs/storage.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

type OldNode = Record<string, unknown> & { mtime?: unknown };
/** A stored record as Waffle wrote it before nanosecond file times: millisecond `mtime`, no
 * `atime` or `ctime`. Snapshots list `nodes`, journals `upserts`. */
export async function oldFormatRecord(record: ChecksummedRecord): Promise<ChecksummedRecord> {
  const value = JSON.parse(record.json) as { nodes?: OldNode[]; upserts?: OldNode[] };
  for (const node of (value.nodes ?? []).concat(value.upserts ?? [])) {
    node.mtime = Number(BigInt(String(node.mtime)) / 1_000_000n);
    delete node.atime;
    delete node.ctime;
  }
  return encodeRecord(value);
}
export function isChecksummedRecord(value: unknown): value is ChecksummedRecord {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ChecksummedRecord).json === "string" &&
    typeof (value as ChecksummedRecord).checksum === "string"
  );
}

/** Names the step a browser failure came from; browser errors here often carry no stack. */
async function step<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${label}: ${String(error)}`, { cause: error });
  }
}

function runtime(name: string, vfs: VfsImplementation, workerURL: string | URL) {
  return createRuntime({
    filesystem: withVfsImplementation(vfs, {
      name,
      mode: "fast",
      workerURL: new URL(workerURL, location.href),
    }),
  });
}

/** A returning browser whose workspace was saved in the old record format: opening fails with
 * INVALID_VFS_FORMAT, deleteWorkspace removes it without reading it, and a fresh workspace with
 * the same name opens empty. A live owner's workspace is never deleted. */
export async function startFreshCase(
  name: string,
  vfs: VfsImplementation,
  workerURL: string | URL,
  ageStore: (name: string) => Promise<void>,
): Promise<void> {
  await step("save", async () => {
    const saved = runtime(name, vfs, workerURL);
    try {
      await saved.filesystem.writeFile("/old.txt", "saved before the format change");
      await saved.filesystem.flush();
    } finally {
      await saved.dispose();
    }
  });
  await step("age", () => ageStore(name));

  const error = await step("reopen", async () => {
    const failed = runtime(name, vfs, workerURL);
    const failure = await failed.filesystem.listFiles().catch((value: unknown) => value);
    await failed.dispose().catch(() => {});
    return failure;
  });
  assert(
    error instanceof VfsError && error.code === "INVALID_VFS_FORMAT",
    `an old-format workspace reports INVALID_VFS_FORMAT, got ${String(error)}`,
  );

  const deleted = await step("delete", () => deleteWorkspace({ mode: "fast", name }));
  assert(deleted === "deleted", `old workspace deleted, got ${deleted}`);

  await step("fresh", async () => {
    const fresh = runtime(name, vfs, workerURL);
    try {
      assert((await fresh.filesystem.listFiles()).length === 0, "the fresh workspace is empty");
      await fresh.filesystem.writeFile("/new.txt", "fresh");
      const busy = await deleteWorkspace({ mode: "fast", name });
      assert(busy === "busy", `a live runtime's workspace is busy, not deleted, got ${busy}`);
      const bytes = await fresh.filesystem.readFile("/new.txt");
      assert(new TextDecoder().decode(bytes) === "fresh", "the live workspace keeps its files");
    } finally {
      await fresh.dispose();
    }
  });
  const missing = await step("missing", () =>
    deleteWorkspace({ mode: "fast", name: `${name}-never-stored` }),
  );
  assert(missing === "missing", `an unknown name is missing, got ${missing}`);
}
