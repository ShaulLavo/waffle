import { parentPort, workerData } from "node:worker_threads";
import { attachPipeEndpoint, type PipeEndpointHandle } from "../../proc/pipes.js";
import { nonblockGuest } from "./wasi-nonblock.js";

interface Request {
  endpoint: PipeEndpointHandle;
  operation: "fd_read" | "fd_write";
  clear: boolean;
  released: SharedArrayBuffer;
}
const request: Request = workerData;
const fd = request.operation === "fd_read" ? 0 : 1;
const endpoint = attachPipeEndpoint(request.endpoint);
const guest = nonblockGuest({ [fd]: endpoint });
try {
  const set = guest.call("fd_fdstat_set_flags", fd, 4);
  const clear = request.clear ? guest.call("fd_fdstat_set_flags", fd, 0) : null;
  const flags = guest.flags(fd);
  parentPort!.postMessage({ ready: true });
  const errno = guest.io(request.operation, fd);
  const released = Atomics.load(new Int32Array(request.released), 0);
  parentPort!.postMessage({ set, clear, flags, errno, count: guest.view.getUint32(264, true), released });
} finally {
  guest.wasi.descriptors.dispose();
  parentPort!.close();
}
