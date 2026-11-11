import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.ts";
import { FilesystemSection } from "../../fs/section.ts";
import { captureProcessObserver } from "../../proc/observation.ts";

declare const self: Worker;
self.onmessage = ({
  data,
}: MessageEvent<
  RuntimeWorkerRequest & {
    gate: SharedArrayBuffer;
    boundary: "initial" | "runtime";
  }
>) => {
  const gate = new Int32Array(data.gate);
  const process = data.runtimeProcess!;
  const observer = captureProcessObserver(process);
  const section = new FilesystemSection(data.filesystem);
  let reads = 0;
  let completion = false;
  const pause = () => {
    if (observer.read().kind !== "pending") throw new Error("acquisition barrier was not pending");
    section.enter();
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    if (Atomics.wait(gate, 1, 0, 10000) === "timed-out") throw new Error("guest gate timeout");
    section.exit();
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);
    if (Atomics.wait(gate, 2, 0, 10000) === "timed-out") throw new Error("guest gate timeout");
  };
  Object.defineProperty(data, "runtimeProcess", {
    get() {
      reads++;
      if (reads === (data.boundary === "initial" ? 1 : 4)) pause();
      return process;
    },
  });
  void bootstrap(
    data,
    {
      setup() {
        throw new Error("terminal acquisition must not invoke executor setup");
      },
      run() {
        throw new Error("terminal acquisition must not enter the guest");
      },
    },
    {
      crossOriginIsolated: true,
      postMessage(message, transfer) {
        if (message.type === "exit") {
          completion = true;
          self.postMessage({ observed: { authenticatedSignal: message.signal ?? null } });
        }
        self.postMessage(message, transfer ?? []);
      },
    },
  ).then(() => {
    const observed = observer.read();
    if (!completion)
      self.postMessage({
        observed: { terminated: observed.kind === "terminated", authenticatedSignal: null },
      });
    Atomics.store(gate, 0, 4);
    Atomics.notify(gate, 0);
    self.postMessage({ ownedCleanupFinished: true });
  });
};
