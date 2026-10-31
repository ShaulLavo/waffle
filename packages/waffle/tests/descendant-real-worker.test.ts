import { expect, test } from "bun:test";
import {
  BrowserProcessBroker,
  type RuntimeDescendant,
  type RuntimeRootOptions,
} from "../browser/process-broker.js";
import {
  attachTerminal,
  claimTerminalAuthority,
  createRuntimeTerminalCodec,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalAttachment,
  type TerminalMember,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
} from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { readOutcome, startStatus } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { requestSignal } from "../proc/signals.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { leb, section, text } from "./fixtures/publication-wasm.js";
import type { DescendantWorkerRequest } from "./fixtures/descendant-real-worker.js";

// Use the existing TypeScript Wasm encoder: _start marks actual guest entry; fd_read
// has a real Wasm call body, so the input assertion goes through the production WASI ABI.
const module = new WebAssembly.Module(
  Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 0x60, 0, 0, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
      section(
        2,
        [2].concat(
          text("descendant_fixture"),
          text("guest_start"),
          [0, 0],
          text("wasi_snapshot_preview1"),
          text("fd_read"),
          [0, 1],
        ),
      ),
      section(3, [2, 0, 1]),
      section(5, [1, 0, 1]),
      section(
        7,
        [3].concat(text("memory"), [2, 0], text("_start"), [0, 2], text("fd_read"), [0, 3]),
      ),
      section(
        10,
        [2, 4, 0, 0x10, 0, 0x0b].concat(
          leb(12),
          [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x10, 1, 0x0b],
        ),
      ),
    ),
  ),
);

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

function deadline() {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error("descendant worker timeout")), 5000);
  return { promise, timer };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  const timeout = deadline();
  try {
    return await Promise.race([pending, timeout.promise]);
  } finally {
    clearTimeout(timeout.timer);
  }
}

interface Notice {
  type: "descendant-fixture";
  event: string;
  pid: number;
  [key: string]: unknown;
}
interface ObservedWorkerRecord {
  worker: Worker;
  closed: Promise<void>;
  isClosed: boolean;
  stops: number;
  pid?: number;
}
function isNotice(value: unknown): value is Notice {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "descendant-fixture" &&
    "event" in value &&
    typeof value.event === "string" &&
    "pid" in value &&
    typeof value.pid === "number"
  );
}

function recordNotice(message: unknown, notices: Notice[], notify: () => void): void {
  if (!isNotice(message)) return;
  notices.push(message);
  notify();
}

async function fixture() {
  const previousWorker = globalThis.Worker;
  const workers: ObservedWorkerRecord[] = [];
  class ObservedWorker extends previousWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const closed = Promise.withResolvers<void>();
      const record: ObservedWorkerRecord = {
        worker: this,
        closed: closed.promise,
        isClosed: false,
        stops: 0,
      };
      workers.push(record);
      this.addEventListener("close", () => {
        record.isClosed = true;
        closed.resolve();
      });
      this.addEventListener("message", ({ data }) => {
        if (isNotice(data)) record.pid = data.pid;
      });
    }
    override terminate() {
      const record = workers.find(({ worker }) => worker === this)!;
      record.stops++;
      return super.terminate();
    }
  }
  const ports: MessagePort[] = [],
    errors: unknown[] = [],
    notices: Notice[] = [];
  const markers = new Int32Array(new SharedArrayBuffer(32));
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("child", { module, adapter: "foreign" });
  registry.register("grandchild", { module, adapter: "preview1" });
  const seen: RuntimeDescendant[] = [],
    launched: number[] = [],
    adapters: string[] = [],
    removed: number[] = [],
    cleaned: number[] = [];
  const members = new Map<number, TerminalMember>();
  const changes = new Set<() => void>();
  const notify = () => {
    for (const listener of changes) listener();
  };
  const fence = Promise.withResolvers<void>();
  let holdFence = false;
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    filesystem: {
      connect(identity) {
        const { client, server } = connectFilesystemIdentity(identity);
        ports.push(client.port, server.port);
        return client;
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      async quiesce() {
        if (holdFence) await fence.promise;
      },
    },
    launch(context) {
      expect(seen.some(({ pid }) => pid === context.pid)).toBe(true);
      launched.push(context.pid);
      adapters.push(context.adapter);
      return broker.launchWorker<DescendantWorkerRequest>(context, {
        workerUrl: new URL("./fixtures/descendant-real-worker.ts", import.meta.url).href,
        request: {
          module: context.module,
          args: Array.from(context.request.argv),
          env: {},
          markers,
          terminalIdentity: display.identity,
        },
        onMessage: (message) => recordNotice(message, notices, notify),
        cleanup() {
          cleaned.push(context.pid);
        },
      });
    },
    onError(error) {
      errors.push(error);
      notify();
    },
  });
  function rootTransport() {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    return root;
  }
  const root = rootTransport();
  const input = createTerminalInput();
  const policy = createTerminalInputPolicy({ input });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  const group = must(authority.createGroup({ initialMode: "raw" }));
  const descriptors = new DescriptorTable();
  let attachment: TerminalAttachment | undefined;
  let unsubscribe = () => {};
  function releaseResources() {
    for (const port of ports) port.close();
    descriptors.dispose();
    attachment?.dispose();
    display.close("disposed");
    members.clear();
    globalThis.Worker = previousWorker;
  }
  async function dispose() {
    fence.resolve();
    for (const index of [4, 5]) {
      Atomics.store(markers, index, 1);
      Atomics.notify(markers, index);
    }
    try {
      await bounded(broker.dispose());
      await bounded(Promise.all(workers.map(({ closed }) => closed)));
      expect(workers.every(({ stops }) => stops === 1)).toBe(true);
    } finally {
      unsubscribe();
      for (const record of workers) if (!record.isClosed) record.worker.terminate();
      await bounded(Promise.all(workers.map(({ closed }) => closed))).finally(releaseResources);
    }
  }
  async function notice(event: string) {
    function find(): Notice | undefined {
      if (errors.length) throw new AggregateError(errors, "broker errors");
      return notices.find((item) => item.event === event);
    }
    const ready = find();
    if (ready) return ready;
    const result = Promise.withResolvers<Notice>();
    const listener = () => {
      try {
        const next = find();
        if (next) result.resolve(next);
      } catch (error) {
        result.reject(error);
      }
    };
    changes.add(listener);
    try {
      return await bounded(result.promise);
    } finally {
      changes.delete(listener);
    }
  }
  async function spawn(parent: WorkerProcessTransport, role: string, job = 0) {
    let message: WorkerProcessMessage | undefined;
    const unused = (): never => {
      throw new Error("unexpected nonterminal descriptor");
    };
    const codec = createRuntimeTerminalCodec({
      descriptors,
      fallback: { import: unused, export: unused, discard: unused },
    });
    const client = new WorkerProcessClient({
      transport: parent,
      descriptors,
      codec,
      prepareSpawn: () => ({
        data: {
          terminalContext: display.inherit(),
          terminalInput: input.buffer,
          filesystem: createFilesystemIdentity(),
        },
      }),
      postMessage(posted) {
        message = posted;
      },
    });
    const pid = client.spawn(parent.pid, {
      executable: "child",
      argv: [role],
      env: {},
      cwd: "/",
      job,
      fds: [{ parent: 0, child: 0 }],
    });
    if (message?.operation !== "spawn") throw new Error("missing spawn");
    const transport = message.transport;
    await broker.runtimeMessage(message, parent.pid);
    await (await broker.ready()).start(pid);
    return { pid, transport };
  }
  globalThis.Worker = ObservedWorker;
  try {
    const rootOptions: RuntimeRootOptions = {
      prepareDescendant: {
        terminal: authority,
        run(descendant, turn) {
          expect(launched).not.toContain(descendant.pid);
          const transport = broker.transportFor(descendant.pid)!;
          expect(startStatus(workerProcessState(transport).signals.outcome)).not.toBe(0);
          seen.push(descendant);
          const member = must(authority.admitExisting({ group, pid: descendant.pid })).member;
          turn.publish(() => {
            members.set(descendant.pid, member);
          });
          return { kind: "ok", value: undefined };
        },
      },
      retired() {
        unsubscribe();
        members.clear();
      },
    };
    await broker.adoptRuntimeRoot(root, rootOptions);
    must(authority.admitExisting({ group, pid: root.pid }));
    must(authority.acquire({ group, expected: null }));
    attachment = attachTerminal({
      context: display.inherit(),
      process: root,
      checkActive() {},
      policy,
    });
    descriptors.openAt(0, attachment.resolve(0), (1n << 29n) - 1n, 0n);
    unsubscribe = (await broker.ready()).onChildExit(({ pid }) => {
      const member = members.get(pid);
      if (!member) return;
      members.delete(pid);
      removed.push(pid);
      must(authority.removeMember(member));
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    broker,
    root,
    rootTransport,
    input,
    display,
    seen,
    launched,
    adapters,
    members,
    removed,
    cleaned,
    errors,
    notices,
    markers,
    workers,
    spawn,
    notice,
    dispose,
    holdFence() {
      holdFence = true;
    },
    releaseFence: () => fence.resolve(),
  };
}

test("real Worker same-job descendants inherit identity-only stdin with root admission and one-shot cleanup", async () => {
  const f = await fixture();
  try {
    must(pushTerminalInput(f.display, f.input, Uint8Array.of(65)));
    const child = await f.spawn(f.root, "child");
    const read = await f.notice("read");
    const spawned = await f.notice("spawned");
    expect(read).toMatchObject({ pid: spawned.child, errno: 0, count: 1, byte: 65 });
    expect(f.notices.filter(({ event }) => event === "ready")).toMatchObject([
      { pid: child.pid, claim: { kind: "error", code: "DENIED" } },
      { pid: spawned.child, claim: { kind: "error", code: "DENIED" } },
    ]);
    expect(f.seen).toMatchObject([
      { pid: child.pid, parentPid: f.root.pid },
      { pid: spawned.child, parentPid: child.pid, job: workerProcessState(child.transport).job },
    ]);
    expect(f.seen[1]!.data.terminalContext).toEqual(structuredClone(f.display.inherit()));
    expect(f.seen[1]!.data.terminalContext).toMatchObject({ memberSlot: -1, memberGeneration: 0 });
    expect(
      f.notices.find(({ pid, event }) => pid === child.pid && event === "ready")!.inherited,
    ).toEqual(f.seen[1]!.data.terminalContext);
    expect(f.adapters).toEqual(["foreign", "preview1"]);
    const supervisor = await f.broker.ready();
    if (typeof spawned.child !== "number") throw new Error("missing grandchild pid");
    expect(await bounded(supervisor.waitForExit(child.pid, spawned.child))).toMatchObject({
      kind: "exited",
      code: 0,
    });
    const grandchildWorker = f.workers.find(({ pid }) => pid === spawned.child)!;
    await bounded(grandchildWorker.closed);
    expect(grandchildWorker.stops).toBe(1);
    expect(f.removed).toEqual([spawned.child]);
    expect(f.cleaned).toEqual([spawned.child]);
    Atomics.store(f.markers, 4, 1);
    Atomics.notify(f.markers, 4);
    await bounded(supervisor.waitForExit(f.root.pid, child.pid));
    await bounded(f.workers.find(({ pid }) => pid === child.pid)!.closed);
    expect(f.removed).toEqual([spawned.child, child.pid]);
    expect(f.members.size).toBe(0);
    expect(Array.from(f.markers.subarray(0, 2))).toEqual([1, 1]);
    const isolated: number[] = [];
    const other = f.rootTransport();
    const otherDisplay = createTerminalSession({
      controller: other,
      geometry: { columns: 80, rows: 24 },
    });
    const otherPolicy = createTerminalInputPolicy({ input: createTerminalInput() });
    const otherAuthority = must(
      claimTerminalAuthority({
        identity: otherDisplay.identity,
        process: other,
        checkActive() {},
        policy: otherPolicy,
      }),
    );
    await f.broker.adoptRuntimeRoot(other, {
      prepareDescendant: {
        terminal: otherAuthority,
        run(descendant) {
          isolated.push(descendant.pid);
          throw new Error("isolated root refuses this probe");
        },
      },
    });
    const before = f.launched.length;
    const probe = await f.spawn(other, "probe");
    expect(await bounded(supervisor.waitForExit(other.pid, probe.pid))).toMatchObject({
      kind: "start-failed",
    });
    expect(isolated).toEqual([probe.pid]);
    otherDisplay.close("disposed");
    expect(f.seen.map(({ pid }) => pid)).toEqual([child.pid, spawned.child]);
    expect(f.launched.length).toBe(before);
    expect(f.errors.map(String)).toEqual(["Error: isolated root refuses this probe"]);
  } finally {
    await f.dispose();
  }
}, 15000);

test("a real Worker killed at the instantiated barrier never enters Wasm and is physically stopped", async () => {
  const f = await fixture();
  try {
    f.holdFence();
    const child = await f.spawn(f.root, "race", workerProcessState(f.root).job);
    await f.notice("entry-barrier");
    const state = workerProcessState(child.transport);
    expect(startStatus(state.signals.outcome)).not.toBe(0);
    requestSignal(state.signals, 9);
    expect(readOutcome(state.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
    Atomics.store(f.markers, 5, 1);
    Atomics.notify(f.markers, 5);
    await f.notice("fenced");
    f.releaseFence();
    const supervisor = await f.broker.ready();
    supervisor.observeSignal(child.pid, 9);
    expect(await bounded(supervisor.waitForExit(f.root.pid, child.pid))).toMatchObject({
      kind: "signaled",
      code: 9,
    });
    const worker = f.workers.find(({ pid }) => pid === child.pid)!;
    await bounded(worker.closed);
    expect(Atomics.load(f.markers, 3)).toBe(0);
    expect(Atomics.load(f.markers, 6)).toBe(1);
    expect(Atomics.load(f.markers, 7)).toBe(1);
    expect(worker.stops).toBe(1);
    expect(f.cleaned).toEqual([child.pid]);
    expect(f.removed).toEqual([child.pid]);
    expect(f.members.size).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 15000);
