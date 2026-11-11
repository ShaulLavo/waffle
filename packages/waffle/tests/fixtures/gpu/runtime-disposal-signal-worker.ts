import assert from "node:assert/strict";
import { completionBytes } from "../../../browser/gpu/codec.js";
import { createGraphicsGuest } from "../../../browser/gpu/guest.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { RuntimeWorkerSignal } from "../../../browser/worker.js";
import type { GraphicsConnection } from "../../../browser/display/protocol.js";
import {
  createSharedControlAllocator,
  installSharedControlAllocator,
  type SharedControlGrant,
} from "../../../memory/control.js";

interface Request {
  readonly graphics: GraphicsConnection;
  readonly grant: SharedControlGrant;
  readonly signal: Int32Array;
  readonly progress: Int32Array;
}

function publish(cells: Int32Array, index: number, value: number) {
  Atomics.store(cells, index, value);
  Atomics.notify(cells, index);
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  const { graphics, grant, signal, progress } = data;
  const restore = installSharedControlAllocator(
    createSharedControlAllocator(grant, (buffer) =>
      self.postMessage({ type: "shared-control-allocation", buffer }),
    ),
  );
  const memory = new WebAssembly.Memory({ initial: 1 });
  const live = () => {
    const selected = Atomics.load(signal, 0);
    if (selected) throw new RuntimeWorkerSignal(selected);
  };
  const guest = createGraphicsGuest(graphics, () => memory, live);
  const wait = RecordRing.prototype.wait;
  RecordRing.prototype.wait = function (seen, timeout, check) {
    publish(progress, 0, 1);
    return wait.call(this, seen, timeout, check);
  };
  let failed = false;
  try {
    const imports = guest.imports.runtime_gpu;
    if (typeof imports?.open !== "function" || typeof imports.completions !== "function")
      throw new Error("Missing GPU imports");
    if (imports.open(0, 0) !== 0) throw new Error("GPU open failed");
    const view = new DataView(memory.buffer);
    const id = view.getUint32(0, true);
    const result = imports.completions(id, 16, 128, -1n, 4);
    publish(progress, 2, 1);
    publish(progress, 5, view.getUint32(4, true));
    if (result !== 0) throw new Error(`Unexpected completion result ${result}`);
    assert.deepEqual(
      new Uint8Array(memory.buffer, 16, view.getUint32(4, true)),
      completionBytes("closed", 0, 0, { reason: 4 }, 128),
    );
    // Hold at the next import's enter boundary until the actual broker publishes KILL.
    // This makes the pre-fix return/next-enter tail deterministic, not a timing race.
    publish(progress, 3, 1);
    if (Atomics.wait(progress, 11, 0, 3000) === "timed-out")
      throw new Error("Broker signal publication did not arrive");
    imports.completions(id, 16, 128, -1n, 4);
    throw new Error("Next import returned after process disposal");
  } catch (error) {
    if (error instanceof RuntimeWorkerSignal) publish(progress, 4, error.signal);
    else {
      failed = true;
      self.postMessage({ failure: String(error) });
    }
  } finally {
    RecordRing.prototype.wait = wait;
    guest.dispose();
    restore();
    publish(progress, 1, 1);
    if (!failed) self.postMessage("finished");
  }
};
