import { attachServiceAccess } from "../../../browser/display/service-readers.js";
import { FencedCommandReader } from "../../../browser/gpu/command-reader.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ fence: SharedArrayBuffer; commands: SharedArrayBuffer; rendezvous: SharedArrayBuffer }>) => void;
  postMessage(message: unknown): void;
};
host.onmessage = ({ data }) => {
  const access = attachServiceAccess(data.fence);
  const rendezvous = new Int32Array(data.rendezvous);
  const ring = new RecordRing(data.commands, 8);
  const physicalRead = ring.readInto;
  ring.readInto = function (destination) {
    Atomics.store(rendezvous, 0, 1);
    Atomics.notify(rendezvous, 0);
    Atomics.wait(rendezvous, 1, 0);
    return physicalRead.call(this, destination);
  };
  const reader = new FencedCommandReader(ring, access);
  const first = reader.readInto(new Uint8Array(64));
  const second = reader.readInto(new Uint8Array(64));
  host.postMessage({ first, second });
};
