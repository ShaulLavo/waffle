import { PersistentBackend } from "../../fs/persistent.js";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../../fs/index.js";
import type { StorageBackend } from "../../fs/storage.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function session(storage: StorageBackend) {
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  return {
    backend,
    service,
    client,
    async close() {
      client.dispose();
      service.dispose();
      await backend.close();
    },
  };
}
/** The same real backend/service/client contract runs in units and all browser storage engines. */
export async function permissionStorageCase(open: () => Promise<StorageBackend>): Promise<void> {
  const first = await session(await open());
  try {
    const fs = first.client;
    await fs.asyncCall("writeFile", ["/file"], new TextEncoder().encode("old"));
    await fs.asyncCall("writeFile", ["/target"], new TextEncoder().encode("target"));
    await fs.asyncCall("mkdirp", ["/sticky"]);
    const root = await fs.asyncCall("preopen", ["/"]);
    const file = await fs.asyncCall("resolve", [root, "file"]);
    const target = await fs.asyncCall("resolve", [root, "target"]);
    const sticky = await fs.asyncCall("resolve", [root, "sticky"]);
    assert((await fs.asyncCall("setMode", [file.node, 0o200])) === 0, "set write-only mode");
    assert((await fs.asyncCall("setMode", [target.node, 0o400])) === 0, "set replaced inode mode");
    assert(
      (await fs.asyncCall("setMode", [sticky.node, 0o1700])) === 0,
      "set real directory sticky mode",
    );
    await fs.asyncCall("writeFile", ["/file"], new TextEncoder().encode("replacement"));
    assert(
      (await fs.asyncCall("permissions", [file.node])).mode === 0o200,
      "overwrite retains inode mode",
    );
    await fs.asyncCall("retain", [target.node]);
    assert((await fs.asyncCall("rename", [file, target])) === 0, "rename replacement");
    assert(
      (await fs.asyncCall("permissions", [target.node])).mode === 0o400,
      "unlinked replaced inode retains its mode",
    );
    const renamed = await fs.asyncCall("resolve", [root, "target"]);
    assert(
      (await fs.asyncCall("permissions", [renamed.node])).mode === 0o200,
      "renamed inode keeps its mode",
    );
    await fs.asyncCall("release", [target.node]);
    await fs.asyncCall("flush");
  } finally {
    await first.close();
  }
  let reads = 0;
  const storage = await open();
  const read = storage.read.bind(storage);
  storage.read = async (key) => {
    reads++;
    return read(key);
  };
  const reopened = await session(storage);
  try {
    const fs = reopened.client;
    const root = await fs.asyncCall("preopen", ["/"]);
    const file = await fs.asyncCall("resolve", [root, "target"]);
    const sticky = await fs.asyncCall("resolve", [root, "sticky"]);
    assert(
      (await fs.asyncCall("permissions", [file.node])).mode === 0o200,
      "file mode survives reopen",
    );
    assert(
      (await fs.asyncCall("permissions", [sticky.node])).mode === 0o1700,
      "directory sticky mode survives reopen",
    );
    assert(reads === 0, "permission lookup must not read payloads");
    let denied = false;
    try {
      await fs.asyncCall("readFile", ["/target"]);
    } catch (error) {
      denied = String(error).includes("errno 2");
    }
    assert(denied && reads === 0, "denied cold read must not fetch payload");
  } finally {
    await reopened.close();
  }
}
