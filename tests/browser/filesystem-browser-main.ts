import { SharedFilesystem } from "../src/shared-fs";
import { startRun } from "../src/runner";

const fs = new SharedFilesystem();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: ${actual} !== ${expected}`);
}
async function guest(connection: ReturnType<SharedFilesystem["fork"]>, action: string) {
  const worker = new Worker("./filesystem-browser-guest.js", { type: "module" });
  try {
    return await new Promise<any>((resolve, reject) => {
      worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ connection, action }, [connection.port]);
    });
  } finally { worker.terminate(); fs.revoke(connection); }
}
try {
  await fs.writeFile("/shared", "before");
  const first = await guest(fs.fork(), "identity");
  equal(first.original, "before", "guest read");
  equal(first.detached, "after!", "open unlinked file");
  equal(decoder.decode(await fs.readFile("/shared")), "replacement", "page sees guest write before process teardown");
  await Promise.all(Array.from({ length: 2 }, () => guest(fs.fork(), "writers")));
  const entries = (await fs.lookup("/"))!.children;
  equal(new Set(Array.from(entries.values(), entry => entry.ino)).size, entries.size, "worker-owned inode allocator");
  const large = new Uint8Array(9 * 1024 * 1024).fill(37);
  await fs.writeFile("/larger-than-old-snapshot", large);
  const read = await fs.readFile("/larger-than-old-snapshot");
  equal(read?.length, large.length, "large response length");
  equal(read?.every(byte => byte === 37), true, "large response bytes");
  // Production run bootstrap, including the transferred connection and descriptor disposal.
  const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,10,4,1,2,0,11]));
  const run = startRun({ engine: "quickjs", module, args: [], env: {}, filesystem: fs, moduleScope: false }, { stdout() {}, stderr() {} });
  const result = await run.done;
  if (result.error) throw new Error(result.error);
  equal(result.code, 0, "real run worker exit");
  // Use a genuinely failing worker module, not a synthetic error event. Only worker creation
  // is routed; the production controller's error handling and SAB cancellation run unchanged.
  const NativeWorker = globalThis.Worker;
  let failed: SharedFilesystem | undefined;
  try {
    globalThis.Worker = class extends NativeWorker {
      constructor(_url: string | URL, options?: WorkerOptions) { super("./filesystem-browser-failure.js", options); }
    };
    failed = new SharedFilesystem();
  } finally { globalThis.Worker = NativeWorker; }
  try {
    const error = await failed!.mkdirp("/startup").then(() => undefined, error => error);
    if (!(error instanceof Error)) throw new Error("worker load failure did not reject startup");
    const flushed = await failed!.flush().then(() => undefined, error => error);
    if (!(flushed instanceof Error) || !flushed.message.includes("Filesystem worker failed")) throw new Error("worker load failure not surfaced");
  } finally { failed?.dispose(); }
  Object.assign(globalThis, { filesystemResult: { ok: true, checks: 9 } });
} catch (error) {
  Object.assign(globalThis, { filesystemResult: { error: error instanceof Error ? error.stack : String(error) } });
} finally { fs.dispose(); }
