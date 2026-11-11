import { ConnectionAccess } from "../../../browser/gpu/access.js";
import { FencedCommandReader } from "../../../browser/gpu/command-reader.js";
import { GPU_TERMINAL, ServiceCredit } from "../../../browser/gpu/protocol.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { LogicalReader } from "../../../browser/gpu/transport.js";
import { serviceAccess } from "./service-access.js";

// Keep the original read so this control isolates the actual installed disposal observer.
const read = LogicalReader.prototype.read;
try {
  await import("./ownership-service-worker.js");
  const results = Object.values(GPU_TERMINAL).map((reason) => {
    const access = new ConnectionAccess(serviceAccess(), () => {});
    const backing = new SharedArrayBuffer(320);
    const fenced = new FencedCommandReader(new RecordRing(backing, 8), access);
    const credit = new ServiceCredit();
    const reader = new LogicalReader(fenced, credit);
    try {
      reader.dispose(reason);
      access.seal();
      fenced.terminal = () => {
        throw new Error("Disposed reader queried sealed transport");
      };
      const bytes = new Uint8Array(backing);
      const frozen = Array.from(bytes);
      const result = read.call(reader);
      return {
        expected: reason,
        result,
        readBytes: reader.lastReadBytes,
        credit: credit.used,
        unchanged: frozen.every((byte, index) => byte === bytes[index]),
      };
    } finally {
      reader.dispose();
    }
  });
  postMessage({ results });
} catch (error) {
  postMessage({ error: String(error) });
}
close();
