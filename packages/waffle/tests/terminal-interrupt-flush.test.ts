import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalAuthority,
  type TerminalContext,
  type TerminalInput,
  type TerminalLease,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { DescriptorTable } from "../core/descriptors.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
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
function interruptFixture(
  editorMode: "raw" | "cooked" = "cooked",
  input: TerminalInput = createTerminalInput(),
  root = createWorkerProcessTransport({ capacity: 16 }),
) {
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
    policy,
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

// ── Input flush ──

const encoder = new TextEncoder();
function push(f: Fixture, text: string): void {
  expect(pushTerminalInput(f.display, f.input, encoder.encode(text))).toMatchObject({ kind: "ok" });
}
/** The page's own root reader in the currently selected group. */
function rootReader(f: Fixture, context: TerminalContext) {
  const attachment = attachTerminal({
    context,
    process: f.root,
    checkActive() {},
    policy: f.policy,
  });
  const stream = attachment.resolve(0);
  return {
    read(size = 64): string {
      const bytes = new Uint8Array(size);
      const count = stream.tryRead!([bytes]);
      return count < 0 ? `errno ${count}` : new TextDecoder().decode(bytes.subarray(0, count));
    },
    dispose: () => attachment.dispose(),
  };
}
function cookedFixture() {
  const f = interruptFixture();
  must(f.authority.transfer({ from: f.replLease, to: f.editor }));
  return { f, reader: rootReader(f, f.rootMember.context) };
}
function metadata(f: Fixture) {
  return Array.from(f.cells.slice(8, 15));
}
function cleanup(f: Fixture, ...disposers: { dispose(): void }[]) {
  for (const item of disposers) item.dispose();
  f.display.close("disposed");
  f.descriptors.dispose();
}

test("flushing drops queued input, keeps later input and changes no terminal metadata", async () => {
  const f = interruptFixture();
  const reader = rootReader(f, f.replRoot.context);
  try {
    push(f, "stale");
    const before = metadata(f);
    const flushed = await f.authority.flushInput();
    expect(flushed).toMatchObject({ kind: "ok", value: undefined });
    expect(flushed.receipt.phase).toBe("committed");
    expect(flushed.receipt.state).toMatchObject({
      kind: "open",
      snapshot: { mode: "raw", selection: before[1] },
    });
    expect(metadata(f)).toEqual(before);
    expect(f.input.available()).toBe(0);
    push(f, "new");
    expect(reader.read()).toBe("new");
  } finally {
    cleanup(f, reader);
  }
});

test("a partially delivered cooked line never resurfaces after a flush", async () => {
  const { f, reader } = cookedFixture();
  try {
    push(f, "hello\n");
    expect(reader.read(2)).toBe("he");
    expect(must(await f.authority.flushInput())).toBeUndefined();
    push(f, "x\n");
    expect(reader.read()).toBe("x\n");
  } finally {
    cleanup(f, reader);
  }
});

test("a line feed after a flushed carriage return is new input", async () => {
  const { f, reader } = cookedFixture();
  try {
    push(f, "a\r");
    expect(reader.read()).toBe("a\n");
    must(await f.authority.flushInput());
    push(f, "\nb\n");
    expect(reader.read()).toBe("\n");
    expect(reader.read()).toBe("b\n");
  } finally {
    cleanup(f, reader);
  }
});

test("flushing keeps end of file and discards in-band delimiters", async () => {
  const { f, reader } = cookedFixture();
  try {
    push(f, "abc\u0004def");
    f.input.close();
    must(await f.authority.flushInput());
    expect(f.input.available()).toBe(0);
    expect(reader.read()).toBe("");
  } finally {
    cleanup(f, reader);
  }
});

test("cancelled input fails the flush after entry and keeps every byte", async () => {
  const f = interruptFixture();
  try {
    push(f, "kept");
    f.input.cancel();
    const result = await f.authority.flushInput();
    expect(result).toMatchObject({ kind: "error", code: "CANCELED" });
    expect(result.receipt.phase).toBe("rolled-back");
    expect(f.input.available()).toBe(4);
  } finally {
    cleanup(f);
  }
});

test("an aborted flush is not entered and keeps every byte", async () => {
  const f = interruptFixture();
  try {
    push(f, "kept");
    const abort = new AbortController();
    abort.abort();
    const settled: string[] = [];
    const result = await f.authority.flushInput({
      signal: abort.signal,
      settled(receipt) {
        settled.push(receipt.phase);
      },
    });
    expect(result).toMatchObject({ kind: "error", code: "CANCELED" });
    expect(result.receipt.phase).toBe("not-entered");
    expect(settled).toEqual(["not-entered"]);
    expect(f.input.available()).toBe(4);
  } finally {
    cleanup(f);
  }
});

test("only the built-in input policy object can be flushed", async () => {
  const input = createTerminalInput();
  const root = createWorkerProcessTransport({ capacity: 4 });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const policy = { ...createTerminalInputPolicy({ input }) };
  const authority: TerminalAuthority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  try {
    expect(input.push(Uint8Array.of(1))).toBe(1);
    const result = await authority.flushInput();
    expect(result).toMatchObject({ kind: "error", code: "INVALID" });
    expect(result.receipt.phase).toBe("not-entered");
    expect(input.available()).toBe(1);
  } finally {
    display.close("disposed");
  }
});

test("a flush inside a control turn is rejected as a recursive wait", async () => {
  const f = interruptFixture();
  try {
    await expect(
      f.authority.control(() => {
        void f.authority.flushInput();
        return { kind: "ok", value: undefined };
      }),
    ).rejects.toThrow("blocking wait inside a terminal control or policy turn");
  } finally {
    cleanup(f);
  }
});

test("the committed receipt reflects earlier queued controls, not the call time", async () => {
  const f = interruptFixture();
  try {
    const earlier = f.authority.control(() =>
      f.authority.transfer({ from: f.replLease, to: f.editor }),
    );
    const flushed = f.authority.flushInput();
    must(await earlier);
    const after = metadata(f);
    const result = await flushed;
    expect(result.receipt.phase).toBe("committed");
    expect(result.receipt.state).toMatchObject({ kind: "open", snapshot: { selection: after[1] } });
    expect(metadata(f)).toEqual(after);
  } finally {
    cleanup(f);
  }
});

test("another Session's input holder delays the flush without losing its read", async () => {
  const identities = new ProcessIdentityAllocator();
  const input = createTerminalInput();
  const transport = () =>
    createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
  const a = interruptFixture("cooked", input, transport());
  const second = transport();
  const display = createTerminalSession({
    controller: second,
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input });
  const b = must(
    claimTerminalAuthority({
      identity: display.identity,
      process: second,
      checkActive() {},
      policy,
    }),
  );
  const group = must(b.createGroup({ initialMode: "raw" }));
  const member = must(b.admitExisting({ group, pid: second.pid }));
  must(b.acquire({ group, expected: null }));
  const flags = new Int32Array(new SharedArrayBuffer(16));
  expect(input.push(encoder.encode("xy"))).toBe(2);
  const holder = new Worker(new URL("./fixtures/terminal-control-worker.ts", import.meta.url), {
    workerData: {
      role: "holder",
      process: second,
      context: member.context,
      input: input.buffer,
      flags: flags.buffer as SharedArrayBuffer,
      inputPause: true,
    } satisfies TerminalControlWorkerData,
  });
  try {
    expect((await once(holder, "message"))[0]).toMatchObject({ kind: "held" });
    let settled = false;
    const flushed = a.authority.flushInput().then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    const released = once(holder, "message");
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    expect((await released)[0]).toMatchObject({ kind: "released", count: 1 });
    const result = await flushed;
    expect(result).toMatchObject({ kind: "ok" });
    expect(result.receipt.phase).toBe("committed");
    expect(input.available()).toBe(0);
    expect(display.snapshot()).toMatchObject({ kind: "ok" }); // B stays open
  } finally {
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    await holder.terminate();
    display.close("disposed");
    cleanup(a);
  }
});

test("Ctrl-C flush and the interrupted job's cooked restore both finish", async () => {
  const f = interruptFixture();
  push(f, "typed ahead");
  const before = metadata(f);
  const c = await contention(f, () => ({ kind: "ok", value: undefined }));
  try {
    const flushed = f.authority.flushInput();
    const { reply } = await c.restore({ kind: "restore" });
    await c.release();
    must(await c.queued);
    const result = await flushed;
    expect(result.receipt.phase).toBe("committed");
    expect(await reply).toEqual({ kind: "restored", step: "setMode", code: "ok", pending: false });
    expect(f.input.available()).toBe(0);
    const after = metadata(f);
    expect([after[0], after[1], after[2]]).toEqual([before[0], before[1], 0]);
    expect(Atomics.load(f.cells, 22)).toBe(0);
    expect(Atomics.load(f.gate, 0)).toBe(0n);
  } finally {
    await c.stop();
  }
});
