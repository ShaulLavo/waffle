import { testReservations } from "./fixtures/shared-memory-platform.js";
import { Worker } from "node:worker_threads";
import type { TerminalControlWorkerData } from "./fixtures/terminal-control-worker.js";
import { controlLoad } from "../proc/control.js";
import { afterEach, expect, test } from "bun:test";
import {
  BrowserProcessBroker,
  type RuntimeDescendant,
  type RuntimeRootOptions,
  type RootPreparationCompletion,
  type RootDescendantPreparation,
} from "../browser/process-broker.js";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalAuthority,
  type TerminalGroup,
  type TerminalMember,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createFilesystemIdentity, revokeFilesystem } from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { readOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { requestSignal } from "../proc/signals.js";
import { ProcessTable } from "../proc/table.js";
import type { ProcessContext, ProcessHandle } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}
function completionLabel(completion: RootPreparationCompletion): string {
  return completion.kind === "committed"
    ? `${completion.kind}:${completion.entry}`
    : completion.kind;
}

/** A real broker, supervisor and directory; only the adapter's Worker is a launch callback. */
function fixture(options: { launch?(context: ProcessContext): ProcessHandle | void } = {}) {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module });
  const launched: number[] = [],
    terminated: number[] = [],
    errors: unknown[] = [];
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table,
    registry,
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      async quiesce() {},
    },
    launch(context) {
      launched.push(context.pid);
      const handle = options.launch?.(context);
      if (handle) return handle;
      return {
        terminate() {
          terminated.push(context.pid);
        },
      };
    },
    onError(error) {
      errors.push(error);
    },
  });
  cleanups.push(() => broker.dispose());
  async function adopt(
    options: (root: WorkerProcessTransport) => Omit<RuntimeRootOptions, "memory"> = () => ({}),
  ) {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root, { memory: [], ...options(root) });
    return root;
  }
  /** Reserve in the parent's directory exactly as a guest would, then post to the page. */
  async function spawn(
    parent: WorkerProcessTransport,
    data: Record<string, unknown> = {},
    job = 0,
    argv: string[] = [],
  ) {
    const descriptors = new DescriptorTable();
    let message: WorkerProcessMessage | undefined;
    const unused = (): never => {
      throw new Error("no descriptors");
    };
    const client = new WorkerProcessClient({
      transport: parent,
      descriptors,
      codec: { import: unused, export: unused, discard: unused },
      prepareSpawn: () => ({ data: { ...data, filesystem: createFilesystemIdentity() } }),
      postMessage(posted) {
        message = posted;
      },
    });
    const pid = client.spawn(parent.pid, {
      executable: "fixture",
      argv,
      env: {},
      cwd: "/",
      job,
      fds: [],
    });
    descriptors.dispose();
    if (message?.operation !== "spawn") throw new Error("expected spawn");
    await broker.runtimeMessage(message, parent.pid);
    const supervisor = await broker.ready();
    await supervisor.start(pid);
    return { pid, transport: message.transport, supervisor };
  }
  return { broker, launched, terminated, errors, adopt, spawn };
}

/** The Shell recipe: root admission in the hook, one-shot membership cleanup on child exit. */
async function shellTerminal(
  f: ReturnType<typeof fixture>,
  extra: Omit<RuntimeRootOptions, "prepareDescendant" | "memory"> & {
    run?: RootDescendantPreparation["run"];
    settled?: RootDescendantPreparation["settled"];
  } = {},
) {
  const input = createTerminalInput();
  const policy = createTerminalInputPolicy({ input });
  const groups = new Map<number, TerminalGroup>(),
    members = new Map<number, TerminalMember>(),
    removed: number[] = [],
    seen: RuntimeDescendant[] = [];
  let display!: ReturnType<typeof createTerminalSession>;
  let authority!: TerminalAuthority;
  const { run, settled, ...options } = extra;
  const root = await f.adopt((root) => {
    display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
    cleanups.push(() => display.close("disposed"));
    authority = must(
      claimTerminalAuthority({
        identity: display.identity,
        process: root,
        checkActive() {},
        policy,
      }),
    );
    return {
      ...options,
      prepareDescendant: {
        terminal: authority,
        settled,
        run(descendant, turn) {
          seen.push(descendant);
          expect(f.launched).not.toContain(descendant.pid);
          const group = groups.get(descendant.job);
          const member = group
            ? must(authority.admitExisting({ group, pid: descendant.pid })).member
            : undefined;
          if (member)
            turn.publish(() => {
              members.set(descendant.pid, member);
            });
          return run?.(descendant, turn) ?? { kind: "ok", value: undefined };
        },
      },
    };
  });
  const cleanupTasks: Promise<unknown>[] = [];
  (await f.broker.ready()).onChildExit(({ pid }) => {
    const member = members.get(pid);
    if (!member) return;
    cleanupTasks.push(
      authority.control((turn) => {
        const result = authority.removeMember(member);
        if (result.kind === "error") return result;
        turn.publish(() => {
          members.delete(pid);
          removed.push(pid);
        });
        return { kind: "ok", value: undefined };
      }),
    );
  });
  const editor = must(authority.createGroup({ initialMode: "raw" }));
  must(authority.admitExisting({ group: editor, pid: root.pid }));
  const lease = must(authority.acquire({ group: editor, expected: null }));
  const job = workerProcessState(root).job;
  /** Map the root's own job to a fresh group, so its same-job children are admitted. */
  const admitRootJob = () =>
    groups.set(job, must(authority.createGroup({ initialMode: "raw" }))) && job;
  return {
    root,
    display,
    input,
    cleanup: async () => {
      await Promise.all(cleanupTasks);
    },
    policy,
    authority,
    groups,
    members,
    removed,
    seen,
    lease,
    admitRootJob,
  };
}

test("a same-job grandchild admitted by the root reads its inherited terminal", async () => {
  const f = fixture({ launch: (context) => void context.started() });
  const t = await shellTerminal(f);
  const job = must(t.authority.createGroup({ initialMode: "raw" }));
  const child = await f.spawn(t.root, {
    terminalContext: t.display.inherit(),
    terminalInput: t.input.buffer,
  });
  const childJob = workerProcessState(child.transport).job;
  t.groups.set(childJob, job);
  // The Shell's own direct spawn is admitted the same way it already is today.
  must(t.authority.admitExisting({ group: job, pid: child.pid }));
  must(t.authority.transfer({ from: t.lease, to: job }));
  const childAttachment = attachTerminal({
    context: (child.transport.data as { terminalContext: unknown }).terminalContext,
    process: child.transport,
    checkActive() {},
    policy: t.policy,
  });
  cleanups.push(() => childAttachment.dispose());
  // Bun forwards identity-only metadata and cannot claim the root's authority.
  expect(
    claimTerminalAuthority({
      identity: t.display.identity,
      process: child.transport,
      checkActive() {},
      policy: t.policy,
    }),
  ).toEqual({ kind: "error", code: "DENIED" });
  const inherited = childAttachment.inherit();
  const grandchild = await f.spawn(
    child.transport,
    { terminalContext: inherited, terminalInput: t.input.buffer },
    childJob,
  );
  expect(workerProcessState(grandchild.transport).job).toBe(childJob);
  expect(t.seen.map((descendant) => descendant.pid)).toEqual([child.pid, grandchild.pid]);
  expect(t.seen[1]).toMatchObject({ pid: grandchild.pid, parentPid: child.pid, job: childJob });
  expect(Object.isFrozen(t.seen[1])).toBe(true);
  expect(Object.isFrozen(t.seen[1]!.data)).toBe(true);
  expect(t.seen[1]!.data).not.toHaveProperty("filesystem");
  // No metadata rewrite: the guest receives the parent's identity-only context unchanged.
  expect((grandchild.transport.data as { terminalContext: unknown }).terminalContext).toBe(
    inherited,
  );
  const attachment = attachTerminal({
    context: inherited,
    process: grandchild.transport,
    checkActive() {},
    policy: t.policy,
  });
  cleanups.push(() => attachment.dispose());
  expect(attachment.ready().kind).toBe("ok");
  must(pushTerminalInput(t.display, t.input, Uint8Array.of(65)));
  const bytes = new Uint8Array(1);
  expect(attachment.resolve(0).tryRead!([bytes])).toBe(1);
  expect(bytes[0]).toBe(65);
  grandchild.supervisor.exit(grandchild.pid, 0);
  await grandchild.supervisor.waitForExit(child.pid, grandchild.pid);
  // An entered descendant's exit cleans its membership exactly once.
  await t.cleanup();
  expect(t.removed).toEqual([grandchild.pid]);
  expect(f.errors).toEqual([]);
});

test("root cleanup composes with a foreign adapter's own process controller", async () => {
  const exited: number[] = [];
  const f = fixture({
    launch(context) {
      // A foreign adapter (for example Bun's) keeps its own per-process controller.
      f.broker.registerController(context.pid, {
        exited: (event) => void exited.push(event.pid),
      });
      context.started();
    },
  });
  const t = await shellTerminal(f);
  const job = workerProcessState(t.root).job;
  const outside = await f.spawn(t.root, {}, job);
  t.admitRootJob();
  const member = await f.spawn(t.root, {}, job);
  expect(t.members.has(outside.pid)).toBe(false);
  expect(t.members.has(member.pid)).toBe(true);
  for (const { pid } of [outside, member]) {
    member.supervisor.exit(pid, 0);
    await member.supervisor.waitForExit(t.root.pid, pid);
  }
  expect(exited).toEqual([outside.pid, member.pid]);
  await t.cleanup();
  expect(t.removed).toEqual([member.pid]);
  expect(f.errors).toEqual([]);
});

for (const failure of ["throw", "promise", "value"] as const)
  test(`a hook ${failure} fails the start before launch and cleans membership once`, async () => {
    const f = fixture();
    const t = await shellTerminal(f, {
      run: (() => {
        if (failure === "throw") throw new Error("root refused");
        if (failure === "promise") return Promise.reject(new Error("late root refusal"));
        return { unexpected: true };
      }) as unknown as RootDescendantPreparation["run"],
    });
    const child = await f.spawn(t.root, {}, t.admitRootJob());
    await child.supervisor.waitForExit(t.root.pid, child.pid);
    await Promise.resolve();
    expect(readOutcome(workerProcessState(child.transport).signals.outcome)?.kind).toBe(
      "start-failed",
    );
    expect(f.launched).toEqual([]);
    await t.cleanup();
    expect(t.removed).toEqual([]);
    if (failure === "promise")
      expect(f.errors.some((error) => String(error).includes("synchronous TerminalResult"))).toBe(
        true,
      );
  });

test("a kill and root exit inside the hook prevent launch; retirement follows cleanup", async () => {
  const f = fixture();
  const order: string[] = [];
  const root = { pid: 0 };
  const t = await shellTerminal(f, {
    run({ pid }) {
      void f.broker.kill(pid, 9);
      void f.broker.rootExit(root.pid, 0);
      return { kind: "ok", value: undefined };
    },
    retired() {
      order.push("retired");
    },
  });
  root.pid = t.root.pid;
  const supervisor = await f.broker.ready();
  const exited = Promise.withResolvers<void>();
  supervisor.onChildExit((event) => {
    order.push(`child-exit:${event.result.kind}`);
    exited.resolve();
  });
  await f.spawn(t.root, {}, t.admitRootJob());
  await exited.promise;
  await f.broker.dispose();
  expect(f.launched).toEqual([]);
  await t.cleanup();
  expect(t.removed).toEqual([]);
  expect(order[0]).toBe("child-exit:signaled");
  expect(order).toContain("retired");
});

test("disposing from inside the hook neither deadlocks nor launches", async () => {
  const f = fixture();
  let disposal: Promise<void> | undefined;
  const t = await shellTerminal(f, {
    run() {
      disposal = f.broker.dispose();
      return { kind: "ok", value: undefined };
    },
  });
  await f.spawn(t.root);
  await disposal;
  expect(f.launched).toEqual([]);
});

test("a kill from another worker after the hook is fenced at guest entry", async () => {
  const entered: boolean[] = [];
  const f = fixture({
    launch(context) {
      // Another worker publishes SIGKILL on the shared row between preparation and entry.
      requestSignal(workerProcessState(f.broker.transportFor(context.pid)!).signals, 9);
      entered.push(context.started());
    },
  });
  const t = await shellTerminal(f);
  const child = await f.spawn(t.root, {}, t.admitRootJob());
  child.supervisor.observeSignal(child.pid, 9);
  await child.supervisor.waitForExit(t.root.pid, child.pid);
  expect(entered).toEqual([false]);
  expect(readOutcome(workerProcessState(child.transport).signals.outcome)?.kind).toBe("signaled");
  expect(f.terminated).toEqual([child.pid]);
  await t.cleanup();
  expect(t.removed).toEqual([child.pid]);
});

test("only the descendant's own preparation runs, as captured at adoption", async () => {
  const f = fixture();
  const calls: string[] = [];
  let captured!: RuntimeRootOptions;
  const first = await f.adopt((root) => {
    const display = createTerminalSession({
      controller: root,
      geometry: { columns: 80, rows: 24 },
    });
    cleanups.push(() => display.close("disposed"));
    const policy = createTerminalInputPolicy({ input: createTerminalInput() });
    const terminal = must(
      claimTerminalAuthority({
        identity: display.identity,
        process: root,
        checkActive() {},
        policy,
      }),
    );
    captured = {
      memory: [],
      prepareDescendant: {
        terminal,
        run() {
          calls.push("first");
          return { kind: "ok", value: undefined };
        },
      },
    };
    return captured;
  });
  captured.prepareDescendant = {
    terminal: captured.prepareDescendant!.terminal,
    run() {
      calls.push("replaced");
      return { kind: "ok", value: undefined };
    },
  };
  const second = await shellTerminal(f, {
    run() {
      calls.push("second");
      return { kind: "ok", value: undefined };
    },
  });
  const unprepared = await f.adopt();
  await f.spawn(first);
  await f.spawn(second.root);
  await f.spawn(unprepared);
  expect(calls).toEqual(["first", "second"]);
  expect(f.launched.length).toBe(3);
});

test("precommit resource rollback notifies before exit and never publishes membership", async () => {
  const f = fixture();
  const phases: string[] = [];
  const t = await shellTerminal(f, {
    run() {
      return { kind: "error", code: "CAPACITY" };
    },
    settled(_descendant, completion) {
      phases.push(`${completion.kind}:${completion.receipt.phase}`);
    },
  });
  const supervisor = await f.broker.ready();
  supervisor.onChildExit(() => phases.push("exit"));
  const child = await f.spawn(t.root, {}, t.admitRootJob());
  await supervisor.waitForExit(t.root.pid, child.pid);
  expect(t.members.has(child.pid)).toBe(false);
  expect(f.launched).not.toContain(child.pid);
  expect(readOutcome(workerProcessState(child.transport).signals.outcome)).toMatchObject({
    kind: "start-failed",
    error: "EAGAIN",
  });
  expect(phases).toEqual(["rolled-back:rolled-back", "exit"]);
});

test("postcommit cancellation reports committed/no-entry before exactly one exit cleanup", async () => {
  const f = fixture();
  const order: string[] = [];
  let committed = false;
  let ownedMember: TerminalMember | undefined;
  const t = await shellTerminal(f, {
    run(descendant, turn) {
      turn.publish((receipt) => {
        committed = receipt.phase === "committed";
        requestSignal(workerProcessState(f.broker.transportFor(descendant.pid)!).signals, 9);
      });
      return { kind: "ok", value: undefined };
    },
    settled(_descendant, completion) {
      ownedMember = t.members.get(_descendant.pid);
      order.push(completionLabel(completion));
    },
  });
  const { exits } = await assertChildExitCleanup(f, t, order, "committed:not-entered");
  expect(committed).toBe(true);
  expect(f.launched).toEqual([]);
  expect(exits).toBe(1);
  const reconciled = await t.authority.control(() => ({ kind: "ok", value: undefined }));
  expect(reconciled.receipt.member(ownedMember!)).toBe("removed");
});

test("failed adapter invocation transfers committed membership to exit cleanup once", async () => {
  const f = fixture({
    launch() {
      throw Error("adapter start failed");
    },
  });
  const order: string[] = [];
  const t = await shellTerminal(f, {
    settled(_descendant, completion) {
      order.push(completionLabel(completion));
    },
  });
  const { exits } = await assertChildExitCleanup(f, t, order, "committed:adapter-invoked");
  expect(exits).toBe(1);
});

async function assertChildExitCleanup(
  f: ReturnType<typeof fixture>,
  t: Awaited<ReturnType<typeof shellTerminal>>,
  order: string[],
  expected: string,
): Promise<{ child: Awaited<ReturnType<typeof f.spawn>>; exits: number }> {
  const supervisor = await f.broker.ready();
  let exits = 0;
  supervisor.onChildExit(() => {
    exits++;
    order.push("exit");
  });
  const child = await f.spawn(t.root, {}, t.admitRootJob());
  await supervisor.waitForExit(t.root.pid, child.pid);
  expect(order).toEqual([expected, "exit"]);
  expect(exits).toBe(1);
  await t.cleanup();
  expect(t.removed).toEqual([child.pid]);
  return { child, exits };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("controlled preparation deadline");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
for (const count of [1, 2])
  test(`real parent Worker waits outside the Session while ${count} child preparation waits for a live holder`, async () => {
    const flags = new Int32Array(new SharedArrayBuffer(16));
    const notices: Array<Record<string, unknown>> = [];
    const workers: Worker[] = [];
    const stops: Array<() => Promise<void>> = [];
    let parent: Worker | undefined;
    let t!: Awaited<ReturnType<typeof shellTerminal>>;
    const run = (data: TerminalControlWorkerData) => {
      const worker = new Worker(new URL("./fixtures/terminal-control-worker.ts", import.meta.url), {
        workerData: data,
      });
      workers.push(worker);
      worker.on("message", (message) => {
        if (message.type === "runtime-proc")
          void f.broker
            .runtimeMessage(message, data.process.pid)
            .catch((error) => notices.push({ kind: "failure", error: String(error) }));
        else notices.push(message);
      });
      worker.on("error", (error) => notices.push({ kind: "failure", error: String(error) }));
      let stopping: Promise<number> | undefined;
      const stop = async () => {
        stopping ??= worker.terminate();
        await stopping;
      };
      stops.push(stop);
      return { worker, stop };
    };
    const f = fixture({
      launch(context) {
        const transport = f.broker.transportFor(context.pid)!;
        return {
          terminate: run({
            role: context.request.argv[0] === "holder" ? "holder" : "child",
            process: transport,
            context: t.display.inherit(),
            input: t.input.buffer,
            flags: flags.buffer,
          }).stop,
        };
      },
    });
    try {
      t = await shellTerminal(f, {
        stop: async () => {
          await parent?.terminate();
        },
        run(descendant, turn) {
          if (t.groups.has(descendant.job)) return { kind: "ok", value: undefined };
          const group = must(t.authority.createGroup({ initialMode: "raw" }));
          const member = must(t.authority.admitExisting({ group, pid: descendant.pid })).member;
          must(t.authority.startBackground(group));
          turn.publish((receipt) => {
            expect(receipt.member(member)).toBe("bound");
            t.groups.set(descendant.job, group);
            t.members.set(descendant.pid, member);
          });
          return { kind: "ok", value: undefined };
        },
      });
      t.groups.set(
        workerProcessState(t.root).job,
        must(t.authority.createGroup({ initialMode: "raw" })),
      );
      // Holder and root belong to one running selected group.
      const group = t.groups.get(workerProcessState(t.root).job)!;
      must(t.authority.admitExisting({ group, pid: t.root.pid }));
      must(t.authority.transfer({ from: t.lease, to: group }));
      must(pushTerminalInput(t.display, t.input, Uint8Array.of(65)));
      const holder = await f.spawn(
        t.root,
        { terminalContext: t.display.inherit(), terminalInput: t.input.buffer },
        workerProcessState(t.root).job,
        ["holder"],
      );
      await until(() => Atomics.load(flags, 0) === 1);
      const rootState = workerProcessState(t.root);
      parent = run({
        role: "parent",
        process: t.root,
        context: t.display.inherit(),
        input: t.input.buffer,
        flags: flags.buffer,
        count,
        childFilesystem: createFilesystemIdentity(),
      }).worker;
      await until(
        () => Atomics.load(flags, 2) === 1 && notices.some((notice) => notice.kind === "waiting"),
      );
      const waiting = notices.find((notice) => notice.kind === "waiting");
      if (!waiting || !Array.isArray(waiting.children)) throw Error("missing parent children");
      const children = waiting.children;
      expect(controlLoad(rootState.terminalAdmission)).toBe(0);
      expect(controlLoad(workerProcessState(holder.transport).terminalAdmission)).toBe(1);
      expect(children.every((pid) => !f.launched.includes(pid))).toBe(true);
      expect(t.seen.filter((descendant) => children.includes(descendant.pid))).toHaveLength(0);
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 1);
      await until(
        () =>
          Atomics.load(flags, 3) === 1 && notices.some((notice) => notice.kind === "parent-done"),
      );
      const done = notices.find((notice) => notice.kind === "parent-done");
      expect(done).toMatchObject({ code: 0, status: 7 });
      expect(notices.filter((notice) => notice.kind === "failure")).toEqual([]);
      for (const pid of children) {
        expect(t.seen.filter((descendant) => descendant.pid === pid)).toHaveLength(1);
        expect(
          notices.find((notice) => notice.kind === "child-entry" && notice.pid === pid),
        ).toMatchObject({ started: true });
      }
      await t.cleanup();
    } finally {
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 1);
      if (t) await f.broker.dispose();
      for (const stop of stops) await stop();
      for (const worker of workers) await worker.terminate();
    }
  }, 10000);
