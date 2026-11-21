import {
  Int32ArrayConstructor,
  Uint8ArrayConstructor,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsStore,
  encodeUtf8Prefix,
  decodeUtf8,
  typedArraySet,
  typedArrayLength,
} from "./intrinsics.js";
import { wakeDirectory } from "./directory.js";
import { describeStartError } from "./start-diagnostic.js";

const HEADER_BYTES = 20;
const DIAGNOSTIC_BYTES = 1024;
export const COMMAND_TRANSFER_BYTES = HEADER_BYTES + DIAGNOSTIC_BYTES;

interface TransferSource {
  readonly directory: SharedArrayBuffer;
  readonly commandTransfer?: SharedArrayBuffer;
  readonly pid: number;
  readonly generation: number;
}

/** Publication stays inside the producer's filesystem fence, even if no message was sent. */
export function recordCommandTransferFailure(
  source: TransferSource,
  kind: "spawn" | "exec",
  target: number,
  error: unknown,
): void {
  const buffer = source.commandTransfer;
  if (!buffer) return;
  const words = new Int32ArrayConstructor(buffer, 0, HEADER_BYTES / 4);
  if (atomicsCompareExchange(words, 0, 0, -1) !== 0) return;
  atomicsStore(words, 1, source.pid);
  atomicsStore(words, 2, source.generation);
  atomicsStore(words, 3, target);
  try {
    const bytes = encodeUtf8Prefix(describeStartError(error), DIAGNOSTIC_BYTES);
    typedArraySet(new Uint8ArrayConstructor(buffer, HEADER_BYTES), bytes);
    atomicsStore(words, 4, typedArrayLength(bytes));
  } finally {
    atomicsStore(words, 0, kind === "spawn" ? 1 : 2);
    wakeDirectory(source.directory);
  }
}

export function commandTransferFailed(buffer: SharedArrayBuffer | undefined): boolean {
  return buffer !== undefined && atomicsLoad(new Int32ArrayConstructor(buffer, 0, 1), 0) !== 0;
}

export function readCommandTransferFailure(buffer: SharedArrayBuffer) {
  const words = new Int32ArrayConstructor(buffer, 0, HEADER_BYTES / 4);
  const operation = atomicsLoad(words, 0);
  if (operation <= 0) return;
  const pid = atomicsLoad(words, 1);
  const generation = atomicsLoad(words, 2);
  const target = atomicsLoad(words, 3);
  const length = atomicsLoad(words, 4);
  const cause = decodeUtf8(new Uint8ArrayConstructor(buffer, HEADER_BYTES, length));
  const kind = operation === 1 ? "spawn" : "exec";
  const error = new Error(
    kind === "spawn"
      ? `Spawn transfer to process ${target} from process ${pid} image ${generation} could not be released`
      : `Exec transfer for process ${pid} image ${target} could not be released`,
    { cause: new Error(cause) },
  );
  return { kind, pid, generation, target, error };
}
