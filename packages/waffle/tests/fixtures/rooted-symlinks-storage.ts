import type { StorageBackend } from "../../fs/storage.js";
import { storageSession } from "./permissions-storage.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Absolute link targets persist as written and resolve in the root namespace after reopen, on
 * the real backend, service and client; the same contract runs in units and every browser store. */
export async function rootedSymlinkStorageCase(open: () => Promise<StorageBackend>): Promise<void> {
  const first = await storageSession(await open());
  try {
    const fs = first.client;
    await fs.asyncCall("writeFile", ["/tmp/x/d/a.txt"], new TextEncoder().encode("inside"));
    const root = await fs.asyncCall("preopen", ["/"]);
    const abs = await fs.asyncCall("resolve", [root, "tmp/x/abs"]);
    assert((await fs.asyncCall("symlink", [abs, "/tmp/x/d/a.txt"])) === 0, "create absolute link");
    const dir = await fs.asyncCall("resolve", [root, "tmp/x/dirlink"]);
    assert((await fs.asyncCall("symlink", [dir, "/tmp/x/d"])) === 0, "create directory link");
    await fs.asyncCall("flush");
  } finally {
    await first.close();
  }
  const reopened = await storageSession(await open());
  try {
    const fs = reopened.client;
    const root = await fs.asyncCall("preopen", ["/"]);
    const file = await fs.asyncCall("resolve", [root, "tmp/x/d/a.txt"]);
    const link = await fs.asyncCall("resolve", [root, "tmp/x/abs"]);
    assert((await fs.asyncCall("readlink", [link.node])) === "/tmp/x/d/a.txt", "target as written");
    const followed = await fs.asyncCall("resolve", [root, "tmp/x/abs", true, true]);
    assert(followed.node === file.node, "absolute target restarts at the root");
    assert(
      (await fs.asyncCall("resolve", [root, "tmp/x/abs", true, false])) === 63,
      "an unrooted lookup stays confined",
    );
    const d = await fs.asyncCall("resolve", [root, "tmp/x/dirlink", true, true]);
    const climbed = await fs.asyncCall("resolve", [
      d.node,
      "../../../../../tmp/x/dirlink/a.txt",
      true,
      true,
    ]);
    assert(climbed.node === file.node, "`..` climbs from a directory and stops at the root");
  } finally {
    await reopened.close();
  }
}
