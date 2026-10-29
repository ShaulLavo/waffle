import {
  receiveRequestBuffer,
  releaseRequestBuffer,
  REQUEST_SERVICE,
  type FilesystemRequestMemory,
} from "../../fs/request-memory.js";

self.onmessage = ({
  data,
}: MessageEvent<{ memory: FilesystemRequestMemory; ring: SharedArrayBuffer }>) => {
  const q = new Int32Array(data.ring);
  let read = 0;
  for (;;) {
    while (Atomics.load(q, 0) === read) {
      if (Atomics.load(q, 1)) {
        postMessage("done");
        return;
      }
    }
    const slot = 4 + (read % 4096) * 3;
    const id = q[slot]!,
      offset = q[slot + 1]!,
      length = q[slot + 2]!;
    read++;
    const buffer = receiveRequestBuffer(data.memory, id, data.memory.generation, offset, length);
    releaseRequestBuffer(buffer, REQUEST_SERVICE);
    Atomics.store(q, 2, read);
  }
};
