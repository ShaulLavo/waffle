import { RIGHT_FD_READ, RIGHT_POLL_FD_READWRITE } from "../../core/rights.js";
import type { DescriptorTable } from "../../core/descriptors.js";
import { PipeEndpoint } from "../../proc/pipes.js";
import { controlWait } from "../../proc/control.js";
import { assertTerminalWaitAllowed } from "../../proc/terminal-turn.js";
import {
  DataViewConstructor,
  dataViewGetUint32,
  isInstance,
  wasmMemoryBuffer,
} from "../../proc/intrinsics.js";
import type { OperationWriter } from "./writer.js";

export { createOperationWriters } from "./writer.js";

type Poll = (ptr: number, count: number, timeout: number, out: number) => number;
const PIPE_READ_RIGHTS = RIGHT_FD_READ | RIGHT_POLL_FD_READWRITE;

function qualifyingPipe(
  memory: WebAssembly.Memory | undefined,
  descriptors: DescriptorTable,
  ptr: number,
): boolean {
  if (!memory) return false;
  try {
    const subscription = new DataViewConstructor(wasmMemoryBuffer(memory), ptr >>> 0, 16);
    if (dataViewGetUint32(subscription, 0, true) !== 0) return false;
    const descriptor = descriptors.get(dataViewGetUint32(subscription, 4, true));
    return (
      !!descriptor &&
      (descriptor.rightsBase & PIPE_READ_RIGHTS) === PIPE_READ_RIGHTS &&
      isInstance(descriptor.resource, PipeEndpoint) &&
      descriptor.resource.mode === "read"
    );
  } catch {
    // The actual import owns validation and its error result.
    return false;
  }
}

export function observePipePoll(options: {
  readonly writer: OperationWriter;
  readonly entered: () => boolean;
  readonly memory: () => WebAssembly.Memory | undefined;
  readonly descriptors: DescriptorTable;
  readonly checkActive: () => void;
  readonly stopped: (error: unknown) => boolean;
}) {
  const { writer, entered, memory, descriptors, checkActive, stopped } = options;
  let qualified = false;
  let guardStopped = false;
  function guard(): void {
    try {
      checkActive();
    } catch (error) {
      guardStopped = stopped(error);
      throw error;
    }
  }
  return {
    wait(ms: number, word: Int32Array, expected: number): void {
      guard();
      assertTerminalWaitAllowed();
      if (qualified) writer.begin(1);
      controlWait(word, 0, expected, ms);
      guard();
    },
    wrap(poll: Poll): Poll {
      return (ptr, count, timeout, out) => {
        if (
          count !== 1 ||
          timeout !== -1 ||
          !entered() ||
          !qualifyingPipe(memory(), descriptors, ptr)
        )
          return poll(ptr, count, timeout, out);
        qualified = true;
        guardStopped = false;
        try {
          const result = poll(ptr, count, timeout, out);
          writer.settle(result === 1 ? "completed" : result === 0 ? "signalPending" : "pollError");
          return result;
        } catch (error) {
          writer.settle(guardStopped ? "processStop" : "pollError");
          throw error;
        } finally {
          qualified = false;
        }
      };
    },
  };
}
