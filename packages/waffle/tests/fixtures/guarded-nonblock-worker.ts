import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { guardedStream } from "../../browser/guarded-stream.js";
import { WasiExit } from "../../core/wasi.js";
import { createWorkerPipeCodec } from "../../proc/worker-pipes.js";
import { nonblockGuest } from "./wasi-nonblock.js";

const request: { token: unknown } = workerData;
const description = createWorkerPipeCodec().import(request.token, 3);
if (description.resource.kind !== "pipe") throw new Error("expected transferred pipe");
const stream = description.resource;
let active = true;
const guarded = guardedStream(stream, () => {
  if (!active) throw new WasiExit(1);
});
const guest = nonblockGuest({ 0: guarded });
try {
  const ready = once(parentPort!, "message", { signal: AbortSignal.timeout(3000) });
  parentPort!.postMessage("ready");
  await ready;
  const flags = guest.flags(0);
  const errno = guest.io("fd_read", 0);
  const clear = guest.call("fd_fdstat_set_flags", 0, 0);
  const cleared = guest.flags(0);
  active = false;
  let denied = false;
  try {
    guest.call("fd_fdstat_set_flags", 0, 4);
  } catch (error) {
    if (!(error instanceof WasiExit)) throw error;
    denied = true;
  }
  parentPort!.postMessage({ flags, errno, clear, cleared, denied, final: guest.flags(0) });
} finally {
  guest.wasi.descriptors.dispose();
  parentPort!.close();
}
