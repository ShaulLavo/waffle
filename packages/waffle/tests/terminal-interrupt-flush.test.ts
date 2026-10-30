import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  type TerminalContext,
  type TerminalLease,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { DescriptorTable } from "../core/descriptors.js";
import { claimOutcome } from "../proc/outcome.js";
import { requestSignal, setSignalDisposition, SignalDisposition } from "../proc/signals.js";
import { Signal } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import type { TerminalControlWorkerData } from "./fixtures/terminal-control-worker.js";
import type {
  TerminalModeReply,
  TerminalModeRequest,
  TerminalModeWorkerData,
} from "./fixtures/terminal-mode-worker.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw Error(result.code);
  return result.value;
}

// The deployed Ctrl-C shape: the shell root polls stdin while the page queues terminal work,
// and the interrupted foreground job restores cooked mode from its signal handler.
function interruptFixture(editorMode: "raw" | "cooked" = "cooked") {
  const input = createTerminalInput();
  const root = createWorkerProcessTransport({ capacity: 16 });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const policy = createTerminalInputPolicy({ input });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw Error("unused");
      },
      import() {
        throw Error("unused");
      },
      discard() {},
    },
    postMessage: (message) => messages.push(message),
  });
  const pid = client.spawn(root.pid, {
    executable: "repl",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  const spawned = messages.find((item) => item.operation === "spawn" && item.transport.pid === pid);
  if (!spawned || spawned.operation !== "spawn") throw Error("spawn failed");
  const editor = must(authority.createGroup({ initialMode: editorMode }));
  const rootMember = must(authority.admitExisting({ group: editor, pid: root.pid }));
  const editorLease = must(authority.acquire({ group: editor, expected: null }));
  const repl = must(authority.createGroup({ initialMode: "raw" }));
  const replRoot = must(authority.admitExisting({ group: repl, pid: root.pid }));
  const replMember = must(authority.admitExisting({ group: repl, pid }));
  const replLease: TerminalLease = must(authority.transfer({ from: editorLease, to: repl }));
  const buffer = (display.identity as unknown as { buffer: SharedArrayBuffer }).buffer;
  return {
    input,
    root,
    child: spawned.transport,
    display,
    authority,
    descriptors,
    editor,
    rootMember,
    editorLease,
    repl,
    replRoot,
    replMember,
    replLease,
    cells: new Int32Array(buffer),
    gate: new BigInt64Array(buffer, 64, 1),
  };
}
type Fixture = ReturnType<typeof interruptFixture>;

function startRepl(f: Fixture) {
  return new Worker(new URL("./fixtures/terminal-mode-worker.ts", import.meta.url), {
    workerData: {
      process: f.child,
      context: f.replMember.context,
      input: f.input.buffer,
    } satisfies TerminalModeWorkerData,
  });
}
/** The shell root inside its stdin readiness turn, holding the Session gate until released. */
function startHolder(f: Fixture, context: TerminalContext, flags: Int32Array) {
  return new Worker(new URL("./fixtures/terminal-control-worker.ts", import.meta.url), {
    workerData: {
      role: "holder",
      process: f.root,
      context,
      input: f.input.buffer,
      flags: flags.buffer as SharedArrayBuffer,
      readOnlyPause: true,
    } satisfies TerminalControlWorkerData,
  });
}
/** Resolves once the worker published its contention hint (a plain store, so no notify), or
 * as soon as its reply arrives; the caller's assertions then decide which happened. */
async function contendedOrReplied(cells: Int32Array, reply: Promise<unknown>): Promise<void> {
  let replied = false;
  void reply.then(() => (replied = true));
  for (let attempt = 0; attempt < 2000 && !replied && Atomics.load(cells, 6) === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
}
async function stopWorker(worker: Worker): Promise<void> {
  const exited = once(worker, "exit");
  worker.postMessage({ kind: "exit" } satisfies TerminalModeRequest);
  await exited;
}

/** REPL worker attached, shell-root holder parked in its readiness turn, page work queued. */
async function contention<T>(f: Fixture, page: () => TerminalResult<T>) {
  const flags = new Int32Array(new SharedArrayBuffer(16));
  const repl = startRepl(f);
  expect((await once(repl, "message"))[0]).toEqual({ kind: "ready", result: "ok" });
  const holder = startHolder(f, f.replRoot.context, flags);
  expect((await once(holder, "message"))[0]).toMatchObject({ kind: "held" });
  const queued = f.authority.control(page);
  expect(Atomics.load(f.cells, 22)).toBe(1);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const parked = once(holder, "message");
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    await parked;
  };
  /** Posts the restore and returns once the worker is blocked on contention (or replied). */
  const restore = async (request: Extract<TerminalModeRequest, { kind: "restore" }>) => {
    Atomics.store(f.cells, 6, 0);
    const reply = once(repl, "message").then(([value]) => value as TerminalModeReply);
    repl.postMessage(request);
    await contendedOrReplied(f.cells, reply);
    return { reply };
  };
  const stop = async () => {
    await release();
    await Promise.all([stopWorker(repl), holder.terminate()]);
    await queued.catch(() => undefined);
    f.display.close("disposed");
    f.descriptors.dispose();
  };
  return { queued, release, restore, stop };
}

test("a foreground worker restores cooked mode while a page control waits behind the shell", async () => {
  const f = interruptFixture();
  const c = await contention(f, () => ({ kind: "ok", value: "page" }));
  try {
    const before = f.cells.slice(8, 12);
    const { reply } = await c.restore({ kind: "restore" });
    await c.release();
    expect(must(await c.queued)).toBe("page");
    expect(await reply).toEqual({ kind: "restored", step: "setMode", code: "ok", pending: false });
    const after = f.cells.slice(8, 12);
    expect({ selected: after[0], selection: after[1], mode: after[2] }).toEqual({
      selected: before[0],
      selection: before[1],
      mode: 0,
    });
    expect(after[3]).toBe(before[3]! + 1); // exactly one mode writer
    expect(Atomics.load(f.cells, 22)).toBe(0);
    expect(Atomics.load(f.gate, 0)).toBe(0n);
  } finally {
    await c.stop();
  }
});

test("the SIGINT being handled does not cancel its own cooked-mode restore", async () => {
  const f = interruptFixture();
  const signals = workerProcessState(f.child).signals;
  setSignalDisposition(signals.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  expect(requestSignal(signals, Signal.SIGINT).action).toBe("handled");
  const c = await contention(f, () => ({ kind: "ok", value: undefined }));
  try {
    const { reply } = await c.restore({ kind: "restore", takeSignal: true });
    await c.release();
    expect(await reply).toEqual({ kind: "restored", step: "setMode", code: "ok", pending: false });
  } finally {
    await c.stop();
  }
});

test("a signal arriving during the wait ends it without consuming the signal", async () => {
  const f = interruptFixture();
  const signals = workerProcessState(f.child).signals;
  setSignalDisposition(signals.signalState, Signal.SIGINT, SignalDisposition.HANDLE);
  const c = await contention(f, () => ({ kind: "ok", value: undefined }));
  try {
    const { reply } = await c.restore({ kind: "restore" });
    expect(requestSignal(signals, Signal.SIGINT).action).toBe("handled");
    expect(await reply).toEqual({
      kind: "restored",
      step: "snapshot",
      code: "CANCELED",
      pending: true,
    });
    expect(Atomics.load(f.cells, 10)).toBe(1); // raw: no mode write happened
  } finally {
    await c.stop();
  }
});

test("closing the session ends a blocked restore", async () => {
  const f = interruptFixture();
  const c = await contention(f, () => ({ kind: "ok", value: undefined }));
  try {
    const { reply } = await c.restore({ kind: "restore" });
    f.display.close("disposed");
    expect(await reply).toMatchObject({ step: "snapshot", code: "CLOSED" });
  } finally {
    await c.stop();
  }
});

test("terminal root death ends a blocked restore", async () => {
  const f = interruptFixture();
  const c = await contention(f, () => ({ kind: "ok", value: undefined }));
  try {
    const { reply } = await c.restore({ kind: "restore" });
    claimOutcome(workerProcessState(f.root).signals.outcome, { kind: "exited", code: 0 });
    expect(await reply).toMatchObject({ step: "snapshot", code: "PROCESS_GONE" });
  } finally {
    await c.stop();
  }
});

test("a job displaced while it waited is denied and writes no mode", async () => {
  const f = interruptFixture("raw");
  const c = await contention(f, () => f.authority.transfer({ from: f.replLease, to: f.editor }));
  try {
    const { reply } = await c.restore({ kind: "restore" });
    await c.release();
    must(await c.queued);
    expect(await reply).toEqual({
      kind: "restored",
      step: "setMode",
      code: "DENIED",
      pending: false,
    });
    expect(Atomics.load(f.cells, 10)).toBe(1);
  } finally {
    await c.stop();
  }
});
