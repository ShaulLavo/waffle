import type { DescriptorTable } from "../../core/descriptors.js";
import type { FilesystemClient } from "../../fs/index.js";
import { ProcessABI } from "../../proc/abi.js";
import { outcomeWord } from "../../proc/outcome.js";
import { createSignalState } from "../../proc/signals.js";

/** The runtime_proc ABI for a guest fixture that only does file I/O and poll. Any call into the
 * process service is a test failure, and `wait` is the guest's one blocking wait. */
export function fileOnlyABI(options: {
  memory: WebAssembly.Memory;
  descriptors: DescriptorTable;
  fs: FilesystemClient;
  wake: Int32Array;
  wait(milliseconds: number): void;
}): ProcessABI {
  const unused = (): never => {
    throw new Error("unexpected process service call");
  };
  return new ProcessABI({
    memory: options.memory,
    descriptors: options.descriptors,
    fs: options.fs,
    pid: 1,
    service: {
      cwd: unused,
      spawn: unused,
      startStatus: unused,
      waitJob: unused,
      jobEmpty: unused,
      jobCleanupReady: unused,
      wait: unused,
      childExited: unused,
      kill: unused,
      killJob: unused,
      jobOf: unused,
      defaultSignal: unused,
    },
    signals: {
      signalState: createSignalState(),
      interrupt: new Int32Array(new SharedArrayBuffer(4)),
      requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
      outcome: outcomeWord(),
    },
    wake: options.wake,
    wait: options.wait,
  });
}
