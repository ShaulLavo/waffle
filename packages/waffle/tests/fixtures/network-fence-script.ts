// Runs in its own process: a runtime that keeps its filesystem also keeps the page guard.
import assert from "node:assert/strict";
import { createRuntime } from "../../index.js";
import { createRing } from "../../browser/net/ring.js";
import { FilesystemClient } from "../../fs/client.js";

const worker = new URL("../../browser/fs-worker.ts", import.meta.url);
const options = { filesystem: { mode: "memory" as const, workerURL: worker } };
const runtime = createRuntime(options);
await runtime.filesystem.mkdirp("/run/sub");
const network = await runtime.network();
const admin = new FilesystemClient(runtime.filesystem.connect(runtime.filesystem.createIdentity()));
const adminRoot = await admin.asyncCall("preopen", ["/"]);
const identity = runtime.filesystem.createIdentity();
const guest = new FilesystemClient(runtime.filesystem.connect(identity));
await guest.asyncCall("preopen", ["/"]);
const lease = await runtime.filesystem.directoryHandle("/");
const helper = network.createHelper({
  ring: createRing(),
  fetch: async () => {
    throw Error("External fetch forbidden");
  },
  pathScope: { filesystem: identity, directory: lease.handle },
});
const reply = new SharedArrayBuffer(12);
const cells = new Int32Array(reply);
helper.handle({
  type: "unix-listen",
  id: 1,
  path: "/run/sub/held.sock",
  unlinkOnClose: true,
  reply,
});
await Atomics.waitAsync(cells, 0, 0).value;
assert.equal(Atomics.load(cells, 1), 0);
const sub = await admin.asyncCall("resolve", [adminRoot, "run/sub", false]);
assert.equal(await admin.asyncCall("setMode", [sub.node, 0o500]), 0);
helper.dispose();
lease.release();
let failure: unknown;
await runtime.dispose().catch((error: unknown) => (failure = error));
assert.match(String((failure as Error)?.message), /Socket cleanup failed|Network disposal failed/);
// Unsettled socket cleanup keeps the filesystem and the page guard alive.
assert.throws(() => createRuntime(options), /already owns/);
console.log("fence retained filesystem after socket cleanup failure");
process.exit(0);
