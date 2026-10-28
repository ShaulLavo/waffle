import { afterEach, expect, test } from "bun:test";
import {
  BrowserProcessBroker,
  type RuntimeDescendant,
  type RuntimeRootOptions,
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
import type { ProcessContext } from "../proc/types.js";
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

/** A real broker, supervisor and directory; only the adapter's Worker is a launch callback. */
function fixture(options: { launch?(context: ProcessContext): void } = {}) {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module });
  const launched: number[] = [],
    terminated: number[] = [],
    errors: unknown[] = [];
  const broker = new BrowserProcessBroker({
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
      options.launch?.(context);
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
  async function adopt(options: (root: WorkerProcessTransport) => RuntimeRootOptions = () => ({})) {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root, options(root));
    return root;
  }
  /** Reserve in the parent's directory exactly as a guest would, then post to the page. */
  async function spawn(
    parent: WorkerProcessTransport,
    data: Record<string, unknown> = {},
    job = 0,
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
      argv: [],
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
  extra: Omit<RuntimeRootOptions, "prepareDescendant"> & {
    run?: RootDescendantPreparation["run"];
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
  const { run, ...options } = extra;
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
  (await f.broker.ready()).onChildExit(({ pid }) => {
    const member = members.get(pid);
    if (!member) return;
    members.delete(pid);
    removed.push(pid);
    authority.removeMember(member);
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
  const child = await f.spawn(t.root, {}, t.admitRootJob());
  await exited.promise;
  await f.broker.dispose();
  expect(f.launched).toEqual([]);
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
