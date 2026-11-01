import { ExecutionUnwind } from "../core/unwind.ts";
import { terminalInterrupt } from "../interrupt/check.ts";
import { createSupervisedWaitImports, WAIT_REGISTRATION_WORDS } from "../interrupt/wait.ts";
import {
  Int32ArrayConstructor,
  reflectApply,
  isSharedArrayBuffer,
  wasmMemoryBuffer,
  sharedArrayBufferByteLength,
  wasmModuleImports,
} from "../proc/intrinsics.ts";
import { reviveOutcome, type OutcomeTransfer } from "../proc/outcome.ts";
import { enterGuest, GuestTerminal, type GuestEntry, type GuestReport } from "./entry.ts";
import { guestImports } from "./guest-imports.ts";
import { ThreadLane, type ThreadLaneTransfer, type ThreadWaitEvent } from "./lane.ts";
import type { ThreadKey } from "./protocol.ts";

const Instance = WebAssembly.Instance;
const closePort = MessagePort.prototype.close;
export interface GuestWorkerRequest {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly thread: ThreadKey;
  readonly entry: GuestEntry;
  readonly outcome: OutcomeTransfer;
  readonly signal: SharedArrayBuffer;
  readonly waits: SharedArrayBuffer;
  readonly lane: ThreadLaneTransfer;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export type GuestWorkerEvent = GuestReport | ThreadWaitEvent | { kind: "ready"; thread: ThreadKey };
export interface GuestWorkerHost {
  postMessage(event: GuestWorkerEvent): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

/** No Wasi, descriptor table, FS client, runtime, or MessageChannel exists in this Worker. */
export async function bootstrapGuestWorker(
  request: GuestWorkerRequest,
  host: GuestWorkerHost,
): Promise<void> {
  const send = host.postMessage;
  const add = host.addEventListener;
  const remove = host.removeEventListener;
  const outcome = reviveOutcome(request.outcome);
  const signal = new Int32ArrayConstructor(request.signal);
  const permission = Promise.withResolvers<boolean>();
  let lane: ThreadLane | undefined;
  function command(event: MessageEvent<unknown>): void {
    const value = event.data;
    if (!value || typeof value !== "object" || !("kind" in value)) return;
    if (value.kind === "enter" || value.kind === "close")
      permission.resolve(value.kind === "enter");
  }
  function cleanup(): void {
    if (lane) lane.close();
    else reflectApply(closePort, request.lane.port, []);
    reflectApply(remove, host, ["message", command]);
  }
  const terminal = new GuestTerminal({
    thread: request.thread,
    outcome,
    signal,
    report: (event) => {
      if (event.kind === "host-idle") cleanup();
      reflectApply(send, host, [event]);
    },
  });
  reflectApply(add, host, ["message", command]);
  try {
    await enterGuest(request.entry, terminal, async () => {
      validate(request);
      lane = new ThreadLane(request.lane, () => {
        if (terminalInterrupt(outcome)) throw new ExecutionUnwind("thread process is terminal");
      });
      const waits = createSupervisedWaitImports(
        request.memory,
        new Int32ArrayConstructor(request.waits),
        () => terminalInterrupt(outcome),
        {
          registered: (registration) =>
            reflectApply(send, host, [
              {
                kind: "wait-registered",
                thread: request.thread,
                registration,
              } satisfies ThreadWaitEvent,
            ]),
          cleared: (generation) =>
            reflectApply(send, host, [
              {
                kind: "wait-cleared",
                thread: request.thread,
                generation,
              } satisfies ThreadWaitEvent,
            ]),
        },
      );
      const imports = guestImports(request.module, {
        memory: request.memory,
        lane,
        terminal,
        args: request.args,
        env: request.env,
        interrupt: { ...waits, __waffle_fatal: () => terminalInterrupt(outcome) },
      });
      const instance = new Instance(request.module, imports);
      reflectApply(send, host, [
        { kind: "ready", thread: request.thread } satisfies GuestWorkerEvent,
      ]);
      if (!(await permission.promise)) throw new ExecutionUnwind("thread entry permission closed");
      return instance;
    });
  } finally {
    cleanup();
  }
}
function validate(request: GuestWorkerRequest): void {
  const memory = wasmMemoryBuffer(request.memory);
  if (!isSharedArrayBuffer(memory)) throw new TypeError("thread guests require shared memory");
  const outcome = isSharedArrayBuffer(request.outcome) ? request.outcome : request.outcome.buffer;
  if (
    request.lane.reply === memory ||
    request.waits === memory ||
    request.signal === memory ||
    outcome === memory
  )
    throw new TypeError("thread controls must not be guest-writable");
  if (
    request.waits === request.lane.reply ||
    request.waits === request.signal ||
    request.signal === request.lane.reply
  )
    throw new TypeError("thread controls require distinct backings");
  if (
    sharedArrayBufferByteLength(request.signal) !== 4 ||
    sharedArrayBufferByteLength(request.waits) !== WAIT_REGISTRATION_WORDS * 4
  )
    throw new TypeError("invalid thread control shape");
  const imports = wasmModuleImports(request.module);
  const supervised =
    imports.some(
      (entry) =>
        entry.module === "runtime_proc" &&
        entry.name === "__waffle_wait32" &&
        entry.kind === "function",
    ) &&
    imports.some(
      (entry) =>
        entry.module === "runtime_proc" &&
        entry.name === "__waffle_wait64" &&
        entry.kind === "function",
    ) &&
    imports.some(
      (entry) =>
        entry.module === "runtime_proc" &&
        entry.name === "__waffle_fatal" &&
        entry.kind === "function",
    );
  if (!supervised) throw new TypeError("thread guest requires supervised-thread admission");
  const tid = request.thread.tid;
  if (!Number.isSafeInteger(tid) || tid < 1 || tid > 0x1fffffff)
    throw new TypeError("invalid thread identity");
  // Host lane 1 is initial; stock libc uses its own main sentinel above the child TID range.
  if (request.entry.kind === "initial" ? tid !== 1 : tid === 1 || tid !== request.entry.tid)
    throw new TypeError("thread entry does not match its identity");
}
