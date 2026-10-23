import { FilesystemClient } from "../../fs/client";
import type { FilesystemConnection } from "../../fs/protocol";
import { WRITE_BARRIER_OFFSET } from "../../fs/write-barrier";

self.onmessage = ({
  data,
}: MessageEvent<{
  connection: FilesystemConnection;
  control: SharedArrayBuffer;
  beforeCut: boolean;
  retry?: boolean;
  append?: boolean;
  admissionWait?: boolean;
}>) => {
  const client = new FilesystemClient(data.connection);
  const root: number = client.call("preopen", ["/"]);
  const path: { node: number } = client.call("resolve", [root, "shared"]);
  client.retain(path.node);
  const control = new Int32Array(data.control);
  const write = () => {
    self.postMessage({ admitted: true });
    while (!Atomics.load(control, 0)) Atomics.wait(control, 0, 0);
    if (data.admissionWait) observeAdmissionWait();
    const result = data.append
      ? client.append(path.node, [new Uint8Array([67])])
      : client.write(path.node, [new TextEncoder().encode("earlier")], 0);
    self.postMessage({ result });
  };
  try {
    if (data.beforeCut) client.withMutation(write);
    else write();
    if (data.retry) {
      while (!Atomics.load(control, 1)) Atomics.wait(control, 1, 0);
      self.postMessage({
        retry: client.write(path.node, [new TextEncoder().encode("resumed")], 0),
      });
    }
  } finally {
    client.dispose();
    self.close();
  }
};

function observeAdmissionWait(): void {
  const wait = Atomics.wait;
  Atomics.wait = (array, index, value, timeout) => {
    if (array.byteOffset === WRITE_BARRIER_OFFSET && index === 0)
      self.postMessage({ waitingAdmission: true });
    if (array instanceof Int32Array && typeof value === "number")
      return wait(array, index, value, timeout);
    if (array instanceof BigInt64Array && typeof value === "bigint")
      return wait(array, index, value, timeout);
    throw new TypeError("invalid atomic wait");
  };
}
