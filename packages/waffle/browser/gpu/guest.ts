import { allocateSharedControl } from "../../memory/control.js";
import type { GraphicsConnection, GraphicsOpen } from "../display/protocol.js";
import { createDisplayImports, guestOutput, guestSpan } from "../display/guest.js";
import {
  atomicsLoad,
  atomicsStore,
  atomicsNotify,
  atomicsWait,
  dataViewSetUint32,
  Int32ArrayConstructor,
  MapConstructor,
  mapGet,
  mapSet,
  mapSize,
  mapForEach,
  mapDelete,
  reflectApply,
  typedArrayBuffer,
  typedArrayByteOffset,
  typedArrayLength,
  Uint8ArrayConstructor,
  objectCreate,
} from "../../proc/intrinsics.js";
import { RecordRing } from "./ring.js";
import { LogicalAppend } from "./transport.js";
import { ProcessError } from "../../proc/errors.js";
import { GPU_TERMINAL, GpuResourceError } from "./protocol.js";

interface GuestGpuConnection {
  readonly control: Int32Array;
  readonly commands: RecordRing;
  readonly replies: RecordRing;
  closed: boolean;
}
const minimum = Math.min;
const now = performance.now.bind(performance);
/** Capture the actual port hooks at bootstrap, before any executor/guest runs. */
export function createGraphicsGuest(
  connection: GraphicsConnection,
  memory: () => WebAssembly.Memory,
  live: () => void,
) {
  const port = connection.port;
  const revocation = new Int32ArrayConstructor(connection.revocation);
  const sendMethod = port.postMessage,
    closeMethod = port.close;
  const send = (message: unknown) => reflectApply(sendMethod, port, [message]);
  const connections = new MapConstructor<number, GuestGpuConnection>();
  let next = 1;
  const terminal = (entry: GuestGpuConnection) =>
    entry.replies.terminal()?.reason ?? entry.commands.terminal()?.reason;
  const errno = (reason: number | undefined) => (reason === GPU_TERMINAL.resource ? -48 : -64);
  const synchronize = (entry: GuestGpuConnection): void => {
    if (!atomicsLoad(revocation, 0)) return;
    const reason = entry.commands.terminate(GPU_TERMINAL.revoked).reason;
    entry.replies.terminate(reason);
    atomicsStore(entry.control, 0, reason === GPU_TERMINAL.resource ? -48 : -64);
    atomicsNotify(entry.control, 0);
  };
  const get = (id: number): GuestGpuConnection => {
    const entry = mapGet(connections, id);
    if (!entry) throw new ProcessError(id > 0 && id < next ? 64 : 8, "Unknown GPU connection");
    synchronize(entry);
    return entry;
  };
  const close = (id: number): number => {
    const entry = mapGet(connections, id);
    if (!entry) return id > 0 && id < next ? 0 : -8;
    entry.closed = true;
    entry.commands.terminate(GPU_TERMINAL.closed);
    entry.replies.terminate(GPU_TERMINAL.closed);
    mapDelete(connections, id);
    send({ __proto__: null, type: "close", id });
    return 0;
  };
  const open = (flags: number, ptr: number): number => {
    const output = guestOutput(memory, ptr, 4);
    if (flags !== 0) return -28;
    if (atomicsLoad(revocation, 0)) return -64;
    if (mapSize(connections) >= 8 || next > 0xffffffff) return -33;
    // Admission happens before each fixed backing is constructed. Failed partial opens
    // deliberately consume the incarnation's monotonic control grant.
    const control = allocateSharedControl(64);
    const commands = allocateSharedControl(connection.commandBytes + 64);
    const replies = allocateSharedControl(connection.completionBytes + 64);
    const entry: GuestGpuConnection = {
      control: new Int32ArrayConstructor(control),
      commands: new RecordRing(commands, 8),
      replies: new RecordRing(replies, 16),
      closed: false,
    };
    const id = next++;
    mapSet(connections, id, entry);
    const message: GraphicsOpen = { type: "open", id, control, commands, replies };
    try {
      send(message);
    } catch {
      entry.closed = true;
      entry.commands.terminate(GPU_TERMINAL.service);
      entry.replies.terminate(GPU_TERMINAL.service);
      mapDelete(connections, id);
      return -64;
    }
    while (atomicsLoad(entry.control, 0) === 0) {
      live();
      synchronize(entry);
      atomicsWait(entry.control, 0, 0, 10);
    }
    live();
    const status = atomicsLoad(entry.control, 0);
    if (status < 0) {
      mapDelete(connections, id);
      return status;
    }
    dataViewSetUint32(output, 0, id, true);
    return 0;
  };
  const append = (id: number, ptr: number, length: number): number => {
    const bytes = guestSpan(memory, ptr, length);
    const entry = get(id);
    if (entry.closed || terminal(entry)) return errno(terminal(entry));
    const append = new LogicalAppend(entry.commands, bytes);
    for (;;) {
      live();
      synchronize(entry);
      const seen = entry.commands.sequence();
      const result = append.advance();
      if (result === "done") return 0;
      if (result === "terminal") return errno(terminal(entry));
      if (result !== "progress") entry.commands.wait(seen, 10, live);
    }
  };
  const completions = (
    id: number,
    ptr: number,
    length: number,
    ns: bigint,
    written: number,
  ): number => {
    const destination = guestSpan(memory, ptr, length);
    const output = guestOutput(memory, written, 4);
    const entry = get(id);
    const deadline = ns < 0n ? Infinity : now() + Number(ns) / 1e6;
    for (;;) {
      live();
      synchronize(entry);
      const seen = entry.replies.sequence();
      const result = drainReplies(entry, destination);
      if (result !== 0) {
        if (result > 0) dataViewSetUint32(output, 0, result, true);
        return result > 0 ? 0 : result;
      }
      if (entry.closed || terminal(entry)) return errno(terminal(entry));
      const remaining = deadline - now();
      if (remaining <= 0) {
        dataViewSetUint32(output, 0, 0, true);
        return 0;
      }
      entry.replies.wait(seen, minimum(10, remaining), live);
    }
  };
  const invoke = (operation: () => number): number => {
    live();
    try {
      return operation();
    } catch (error) {
      live();
      return error instanceof GpuResourceError
        ? -48
        : error instanceof ProcessError
          ? -error.errno
          : -28;
    }
  };
  const imports: WebAssembly.Imports = objectCreate(null);
  imports.runtime_window = createDisplayImports(connection, memory, live);
  if (connection.gpu)
    imports.runtime_gpu = {
      open: (flags: number, ptr: number) => invoke(() => open(flags, ptr)),
      append: (id: number, ptr: number, length: number) => invoke(() => append(id, ptr, length)),
      completions: (id: number, ptr: number, length: number, ns: bigint, written: number) =>
        invoke(() => completions(id, ptr, length, ns, written)),
      payload: (id: number, handle: number, ptr: number, length: number) =>
        invoke(() => {
          guestSpan(memory, ptr, length);
          guestSpan(memory, handle, 8);
          const entry = get(id);
          return entry.closed || terminal(entry) ? -64 : -8;
        }),
      close: (id: number) => invoke(() => close(id)),
    };
  const retireConnection = (entry: GuestGpuConnection, id: number): void => {
    if (entry.closed) return;
    try {
      close(id);
    } catch {
      /* Continue retiring the remaining connections. */
    }
  };
  return {
    imports,
    dispose() {
      try {
        mapForEach(connections, retireConnection);
      } finally {
        reflectApply(closeMethod, port, []);
      }
    },
  };
}
function drainReplies(entry: GuestGpuConnection, destination: Uint8Array): number {
  let written = 0;
  while (written < typedArrayLength(destination)) {
    const output = new Uint8ArrayConstructor(
      typedArrayBuffer(destination),
      typedArrayByteOffset(destination) + written,
      typedArrayLength(destination) - written,
    );
    const result = entry.replies.readInto(output);
    if (result.kind === "short") return written || -42;
    if (result.kind !== "record") return written;
    written += result.bytes;
  }
  return written || -42;
}
