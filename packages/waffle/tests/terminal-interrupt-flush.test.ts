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
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import type { TerminalControlWorkerData } from "./fixtures/terminal-control-worker.js";
import type { TerminalModeWorkerData } from "./fixtures/terminal-mode-worker.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw Error(result.code);
  return result.value;
}

// The deployed Ctrl-C shape: the shell root polls stdin while the page queues terminal work,
// and the interrupted foreground job restores cooked mode from its signal handler.
function interruptFixture() {
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
  const editor = must(authority.createGroup({ initialMode: "cooked" }));
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
  worker.postMessage({ kind: "exit" });
  await exited;
}

test("a foreground worker restores cooked mode while a page control waits behind the shell", async () => {
  const f = interruptFixture();
  const flags = new Int32Array(new SharedArrayBuffer(16));
  const repl = startRepl(f);
  let holder: Worker | undefined;
  try {
    expect((await once(repl, "message"))[0]).toEqual({ kind: "ready", result: "ok" });
    holder = startHolder(f, f.replRoot.context, flags);
    expect((await once(holder, "message"))[0]).toMatchObject({ kind: "held" });
    const before = f.cells.slice(8, 12);
    const queued = f.authority.control(() => ({ kind: "ok", value: "page" }));
    expect(Atomics.load(f.cells, 22)).toBe(1);
    Atomics.store(f.cells, 6, 0); // observe the worker's own contention hint below
    const restored = once(repl, "message");
    repl.postMessage({ kind: "restore" });
    await contendedOrReplied(f.cells, restored);
    const released = once(holder, "message");
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    await released;
    expect(must(await queued)).toBe("page");
    expect((await restored)[0]).toEqual({ kind: "restored", step: "setMode", code: "ok" });
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
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    await Promise.all([stopWorker(repl), holder?.terminate()]);
    f.display.close("disposed");
    f.descriptors.dispose();
  }
});
