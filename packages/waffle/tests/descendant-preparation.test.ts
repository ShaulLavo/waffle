import { afterEach, expect, test } from "bun:test";
import {
  BrowserProcessBroker,
  type RuntimeDescendant,
  type RuntimeDescendantPreparation,
  type RuntimeRootOptions,
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
import { readOutcome, startStatus } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
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

/** A real broker, supervisor and directory; only the adapter's Worker is replaced. */
function fixture(options: { launch?(context: ProcessContext): ProcessHandle } = {}) {
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module });
  const launched: ProcessContext[] = [],
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
      launched.push(context);
      return options.launch?.(context) ?? { terminate() {} };
    },
    onError(error) {
      errors.push(error);
    },
  });
  cleanups.push(() => broker.dispose());
  async function adopt(rootOptions: RuntimeRootOptions = {}) {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root, rootOptions);
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
    const start = (await broker.ready()).start(pid);
    return { pid, transport: message.transport, start };
  }
  return { broker, launched, errors, adopt, spawn };
}

test("a same-job grandchild is bound and published before its guest can enter", async () => {
  const f = fixture({
    launch(context) {
      // The adapter boundary: the guest enters only after this point.
      const transport = f.broker.transportFor(context.pid)!;
      entries.set(context.pid, structuredClone(transport.data) as Record<string, unknown>);
      expect(context.started()).toBe(true);
      return { terminate() {} };
    },
  });
  const entries = new Map<number, Record<string, unknown>>();
  const input = createTerminalInput();
  const policy = createTerminalInputPolicy({ input });
  const members = new Map<number, { group: TerminalGroup; member: TerminalMember }>();
  const terminal = {} as { authority: TerminalAuthority };
  const seen: RuntimeDescendant[] = [];
  const root = await f.adopt({
    prepareDescendant(descendant) {
      seen.push(descendant);
      // Rendezvous: reserved and admitted, with no adapter launch yet.
      expect(f.launched.some((context) => context.pid === descendant.pid)).toBe(false);
      expect(f.broker.transportFor(descendant.pid)).toBeDefined();
      const parent = members.get(descendant.parentPid)!;
      const plan = must(
        terminal.authority.planMember({ group: parent.group, parent: parent.member }),
      );
      const bound = must(
        terminal.authority.bindMember({ planned: plan.member, pid: descendant.pid }),
      );
      members.set(descendant.pid, { group: parent.group, member: bound.member });
      return { data: { terminalContext: bound.context } };
    },
  });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  cleanups.push(() => display.close("disposed"));
  const authority = (terminal.authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  ));
  const shell = must(authority.createGroup({ initialMode: "raw" }));
  const rootMember = must(authority.admitExisting({ group: shell, pid: root.pid }));
  const lease = must(authority.acquire({ group: shell, expected: null }));
  const job = must(authority.createGroup({ initialMode: "raw" }));
  members.set(root.pid, { group: job, member: rootMember.member });

  const child = await f.spawn(root);
  await child.start;
  must(authority.transfer({ from: lease, to: job }));
  // Bun forwards only cloneable identity metadata, never membership.
  const unbound = attachTerminal({
    context: entries.get(child.pid)!.terminalContext,
    process: child.transport,
    checkActive() {},
    policy,
  }).inherit();
  const grandchild = await f.spawn(
    child.transport,
    { terminalContext: unbound, terminalInput: input.buffer },
    workerProcessState(child.transport).job,
  );
  await grandchild.start;
  expect(workerProcessState(grandchild.transport).job).toBe(
    workerProcessState(child.transport).job,
  );
  expect(seen.map((descendant) => descendant.pid)).toEqual([child.pid, grandchild.pid]);
  expect(Object.isFrozen(seen[1])).toBe(true);
  expect(seen[1]!.data).not.toHaveProperty("filesystem");
  expect(seen[1]!.data.terminalInput).toBeInstanceOf(SharedArrayBuffer);

  const attachment = attachTerminal({
    context: entries.get(grandchild.pid)!.terminalContext,
    process: grandchild.transport,
    checkActive() {},
    policy,
  });
  cleanups.push(() => attachment.dispose());
  expect(attachment.ready().kind).toBe("ok");
  must(pushTerminalInput(display, input, Uint8Array.of(65)));
  const bytes = new Uint8Array(1);
  expect(attachment.resolve(0).tryRead!([bytes])).toBe(1);
  expect(bytes[0]).toBe(65);
  expect(f.errors).toEqual([]);
});

test("a blocked preparation holds launch; a kill while blocked cancels once and never launches", async () => {
  const f = fixture();
  const blocked = Promise.withResolvers<RuntimeDescendantPreparation>();
  let calls = 0,
    cancels = 0;
  const root = await f.adopt({
    prepareDescendant() {
      calls++;
      return blocked.promise;
    },
  });
  const child = await f.spawn(root);
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(f.launched).toEqual([]);
  await f.broker.kill(child.pid, 9);
  blocked.resolve({
    data: { late: true },
    cancel() {
      cancels++;
    },
  });
  await child.start;
  const supervisor = await f.broker.ready();
  await supervisor.waitForExit(root.pid, child.pid);
  expect(cancels).toBe(1);
  expect(f.launched).toEqual([]);
  expect(readOutcome(workerProcessState(child.transport).signals.outcome)?.kind).toBe("signaled");
  expect(f.broker.transportFor(child.pid)?.data).not.toHaveProperty("late");
});

for (const failure of ["throw", "reject", "reserved", "uncloneable", "launch"] as const)
  test(`preparation failure (${failure}) fails start and cancels only accepted work`, async () => {
    let cancels = 0;
    const f = fixture({
      launch() {
        throw new Error("adapter refused");
      },
    });
    const cancel = () => {
      cancels++;
    };
    const root = await f.adopt({
      prepareDescendant() {
        if (failure === "throw") throw new Error("root refused");
        if (failure === "reject") return Promise.reject(new Error("root refused"));
        if (failure === "reserved") return { data: { filesystem: null }, cancel };
        if (failure === "uncloneable") return { data: { callback() {} }, cancel };
        return { data: { ok: true }, cancel };
      },
    });
    const child = await f.spawn(root);
    await child.start;
    await (await f.broker.ready()).waitForExit(root.pid, child.pid);
    const outcome = readOutcome(workerProcessState(child.transport).signals.outcome);
    expect(outcome?.kind).toBe("start-failed");
    expect(f.launched.length).toBe(failure === "launch" ? 1 : 0);
    expect(cancels).toBe(failure === "throw" || failure === "reject" ? 0 : 1);
  });

test("an entered descendant's exit is ordinary and never cancels", async () => {
  const f = fixture({
    launch(context) {
      context.started();
      return { terminate() {} };
    },
  });
  let cancels = 0,
    prepared = 0;
  const root = await f.adopt({
    prepareDescendant() {
      prepared++;
      return {
        cancel() {
          cancels++;
        },
      };
    },
  });
  const child = await f.spawn(root);
  await child.start;
  const supervisor = await f.broker.ready();
  expect(prepared).toBe(1);
  expect(startStatus(workerProcessState(child.transport).signals.outcome)).toBe(0);
  supervisor.exit(child.pid, 0);
  await supervisor.waitForExit(root.pid, child.pid);
  expect(cancels).toBe(0);
});

test("only the descendant's own captured root hook runs", async () => {
  const f = fixture();
  const calls: string[] = [];
  const options: RuntimeRootOptions = {
    prepareDescendant: () => {
      calls.push("first");
    },
  };
  const first = await f.adopt(options);
  options.prepareDescendant = () => {
    calls.push("replaced");
  };
  const second = await f.adopt({
    prepareDescendant: () => {
      calls.push("second");
    },
  });
  await (
    await f.spawn(first)
  ).start;
  await (
    await f.spawn(second)
  ).start;
  expect(calls).toEqual(["first", "second"]);
  expect(f.launched.length).toBe(2);
});

test("root death does not retire the root before an unentered descendant cancels", async () => {
  const f = fixture();
  const order: string[] = [];
  const blocked = Promise.withResolvers<void>();
  const root = await f.adopt({
    async prepareDescendant() {
      await blocked.promise;
      return {
        cancel() {
          order.push("cancel");
        },
      };
    },
    retired() {
      order.push("retired");
    },
  });
  const child = await f.spawn(root);
  await f.broker.rootExit(root.pid, 0);
  blocked.resolve();
  await child.start;
  expect(order).toEqual([]);
  // Launched but never entered; the descendant's exit settles the root's reservation.
  const supervisor = await f.broker.ready();
  supervisor.failStart(child.pid, new Error("guest never entered"));
  await supervisor.waitForExit(root.pid, child.pid);
  expect(order).toEqual(["cancel"]);
  await f.broker.dispose();
  expect(order).toEqual(["cancel", "retired"]);
});

test("disposal waits for a blocked preparation and cancels it before retiring the root", async () => {
  const f = fixture();
  const order: string[] = [];
  const blocked = Promise.withResolvers<RuntimeDescendantPreparation>();
  const root = await f.adopt({
    prepareDescendant: () => blocked.promise,
    retired() {
      order.push("retired");
    },
  });
  const child = await f.spawn(root);
  await Promise.resolve();
  const disposal = f.broker.dispose();
  await Promise.resolve();
  expect(order).toEqual([]);
  blocked.resolve({
    cancel() {
      order.push("cancel");
    },
  });
  await disposal;
  await child.start;
  expect(order).toEqual(["cancel", "retired"]);
  expect(f.launched).toEqual([]);
});
