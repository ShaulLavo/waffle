import { parentPort, workerData } from "node:worker_threads";
import { createWorkerPipeCodec } from "../../proc/worker-pipes.js";
import { nonblockGuest } from "./wasi-nonblock.js";

interface Request {
  token: unknown;
  pid: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
}
const request: Request = workerData;
const description = createWorkerPipeCodec().import(request.token, request.pid);
const guest = nonblockGuest();
try {
  guest.wasi.descriptors.inherit(7, {
    description,
    resource: description.resource,
    rightsBase: request.rightsBase,
    rightsInheriting: request.rightsInheriting,
  });
  const flags = guest.flags(7);
  if (flags !== 4) throw new Error(`inherited NONBLOCK was lost: ${flags}`);
  const errno = guest.io("fd_read", 7);
  const clear = guest.call("fd_fdstat_set_flags", 7, 0);
  parentPort!.postMessage({
    flags,
    errno,
    clear,
    rights: guest.wasi.descriptors.get(7)!.rightsBase,
  });
} finally {
  guest.wasi.descriptors.dispose();
  parentPort!.close();
}
