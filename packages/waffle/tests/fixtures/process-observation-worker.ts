import { isProcessExecutionTerminated } from "../../proc/observation.ts";
import { bootstrap, RuntimeWorkerSignal, type RuntimeWorkerRequest } from "../../browser/worker.ts";
import { FilesystemSection } from "../../fs/section.ts";

declare const self: Worker;
self.onmessage = ({ data }: MessageEvent<RuntimeWorkerRequest & { gate: SharedArrayBuffer }>) => {
  const gate = new Int32Array(data.gate);
  const section = new FilesystemSection(data.filesystem);
  const publish = (phase: number) => {
    Atomics.store(gate, 0, phase);
    Atomics.notify(gate, 0);
  };
  const wait = (index: number) => {
    while (Atomics.load(gate, index) === 0) {
      if (Atomics.wait(gate, index, 0, 10000) === "timed-out")
        throw new Error("guest gate timeout");
    }
  };
  const held = (checkActive: () => void) => {
    section.enter();
    publish(1);
    wait(1);
    section.exit();
    publish(2);
    wait(2);
    try {
      checkActive();
      publish(3);
    } catch (error) {
      self.postMessage({
        observed:
          error instanceof Error
            ? {
                terminated: isProcessExecutionTerminated(error),
                name: error.name,
                message: error.message,
                stack: error.stack,
                authenticatedSignal: error instanceof RuntimeWorkerSignal ? error.signal : null,
              }
            : String(error),
      });
      publish(4);
      throw error;
    }
  };
  void bootstrap(
    data,
    {
      setup({ fs }) {
        fs.preopen = () => 1;
        fs.retain = () => {};
        fs.release = () => {};
      },
      namespaces(context) {
        return {
          env: {
            held: () => held(context.checkActive),
          },
        };
      },
      run(_context, exited) {
        return exited ?? 0;
      },
    },
    {
      crossOriginIsolated: true,
      postMessage(message, transfer) {
        self.postMessage(message, transfer ?? []);
      },
    },
  ).then(() => self.postMessage({ ownedCleanupFinished: true }));
};
