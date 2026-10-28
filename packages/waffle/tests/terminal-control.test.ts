import { DescriptorTable } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { Worker } from "node:worker_threads";
import type { TerminalControlWorkerData } from "./fixtures/terminal-control-worker.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { expect, test } from "bun:test";
import {
  claimTerminalAuthority,
  captureTerminalProcessLifetime,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  attachTerminal,
  terminalControls,
  TERMINAL_SESSION_LIMITS,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { createWorkerProcessTransport, WorkerProcessClient } from "../proc/worker-client.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw Error(result.code);
  return result.value;
}
function fixture(
  input = createTerminalInput(),
  root = createWorkerProcessTransport(),
  forceReady = false,
) {
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const base = createTerminalInputPolicy({ input });
  const policy = forceReady
    ? { ...base, inputReadiness: () => ({ readable: true, nbytes: 1 }) }
    : base;
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  return { root, input, display, policy, authority };
}

test("control publishes one synchronous turn and permits exact-session root aliases", async () => {
  const f = fixture();
  let calls = 0,
    published = false;
  try {
    const result = await f.authority.control((turn) => {
      calls++;
      const group = must(f.authority.createGroup({ initialMode: "raw" }));
      must(f.authority.admitExisting({ group, pid: f.root.pid }));
      must(f.authority.acquire({ group, expected: null }));
      const attachment = attachTerminal({
        context: f.display.inherit(),
        process: f.root,
        checkActive() {},
        policy: f.policy,
      });
      const snapshot = terminalControls(attachment.resolve(0))!.snapshot();
      expect(snapshot.kind).toBe("ok");
      attachment.dispose();
      turn.publish(() => {
        published = true;
      });
      expect(published).toBe(false);
      return { kind: "ok", value: group };
    });
    expect(result.kind).toBe("ok");
    expect(calls).toBe(1);
    expect(published).toBe(true);
    expect(f.display.snapshot().kind).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("real quota failure rolls back only created allocations and preserves selected reused group", async () => {
  const f = fixture();
  try {
    const editor = must(f.authority.createGroup({ initialMode: "raw" }));
    must(f.authority.admitExisting({ group: editor, pid: f.root.pid }));
    const lease = must(f.authority.acquire({ group: editor, expected: null }));
    const selection = must(f.display.snapshot()).selection;
    const result = await f.authority.control(() => {
      for (let i = 1; i < TERMINAL_SESSION_LIMITS.groups; i++)
        must(f.authority.createGroup({ initialMode: "raw" }));
      return f.authority.createGroup({ initialMode: "raw" });
    });
    expect(result).toMatchObject({ kind: "error", code: "CAPACITY" });
    expect(must(f.display.snapshot()).selection).toBe(selection);
    expect(f.authority.release({ lease, restore: null }).kind).toBe("ok");
    for (let i = 1; i < TERMINAL_SESSION_LIMITS.groups; i++)
      expect(f.authority.createGroup({ initialMode: "raw" }).kind).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("cancel at a granted stage discards publication and permits later control", async () => {
  const f = fixture(),
    cancel = new AbortController();
  let published = false;
  try {
    const result = await f.authority.control(
      (turn) => {
        must(f.authority.createGroup({ initialMode: "raw" }));
        turn.publish(() => {
          published = true;
        });
        cancel.abort();
        return { kind: "ok", value: undefined };
      },
      { signal: cancel.signal },
    );
    expect(result).toMatchObject({ kind: "error", code: "CANCELED" });
    expect(published).toBe(false);
    expect(
      (await f.authority.control(() => f.authority.createGroup({ initialMode: "raw" }))).kind,
    ).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("rollback receipt reconciles cached handles and never revives provisional handles", async () => {
  const f = fixture();
  try {
    const editor = must(f.authority.createGroup({ initialMode: "raw" }));
    const member = must(f.authority.admitExisting({ group: editor, pid: f.root.pid })).member;
    const lease = must(f.authority.acquire({ group: editor, expected: null }));
    let provisional: ReturnType<typeof f.authority.createGroup> | undefined;
    let seen: string | undefined;
    const result = await f.authority.control(
      () => {
        provisional = f.authority.createGroup({ initialMode: "raw" });
        const next = must(provisional);
        must(f.authority.admitExisting({ group: next, pid: f.root.pid }));
        must(f.authority.transfer({ from: lease, to: next }));
        return { kind: "error", code: "CAPACITY" };
      },
      {
        settled(receipt) {
          seen = receipt.phase;
        },
      },
    );
    expect(result.receipt.phase).toBe("rolled-back");
    expect(seen).toBe("rolled-back");
    expect(result.receipt.group(editor)).toBe("active");
    expect(result.receipt.member(member)).toBe("bound");
    expect(result.receipt.lease(lease)).toBe(true);
    const abandoned = must(provisional!);
    expect(result.receipt.group(abandoned)).toBe("stale");
    must(f.authority.createGroup({ initialMode: "raw" }));
    expect(f.authority.startBackground(abandoned)).toMatchObject({ kind: "error", code: "STALE" });
    expect(result.receipt.state?.kind).toBe("open");
    if (result.receipt.state?.kind !== "open" || !result.receipt.state.selection)
      throw Error("missing reconciled selection");
    expect(
      f.authority.release({ lease: result.receipt.state.selection.lease, restore: null }).kind,
    ).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("committed receipt issues fresh selection state before publication", async () => {
  const f = fixture();
  try {
    let receiptPhase = "";
    const result = await f.authority.control((turn) => {
      const group = must(f.authority.createGroup({ initialMode: "raw" }));
      must(f.authority.admitExisting({ group, pid: f.root.pid }));
      must(f.authority.acquire({ group, expected: null }));
      turn.publish((receipt) => {
        receiptPhase = receipt.phase;
        expect(receipt.state?.kind).toBe("open");
      });
      return { kind: "ok", value: group };
    });
    expect(receiptPhase).toBe("committed");
    expect(result.receipt.phase).toBe("committed");
    if (result.kind !== "ok") throw Error(result.code);
    expect(result.receipt.group(result.value)).toBe("active");
    if (result.receipt.state?.kind !== "open" || !result.receipt.state.selection)
      throw Error("missing selection");
    expect(result.receipt.member(result.receipt.state.selection.rootMember!)).toBe("bound");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("input observations wake and join on data, cancellation, and lock-only release in another Session", async () => {
  const identities = new ProcessIdentityAllocator();
  const input = createTerminalInput();
  const first = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const second = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const a = fixture(input, first, true),
    b = fixture(input, second, true);
  const flags = new Int32Array(new SharedArrayBuffer(16));
  const dataGroup = must(a.authority.createGroup({ initialMode: "raw" }));
  must(a.authority.admitExisting({ group: dataGroup, pid: first.pid }));
  must(a.authority.acquire({ group: dataGroup, expected: null }));
  const group = must(b.authority.createGroup({ initialMode: "raw" }));
  const member = must(b.authority.admitExisting({ group, pid: second.pid }));
  must(b.authority.acquire({ group, expected: null }));
  const attachment = attachTerminal({
    context: a.display.inherit(),
    process: first,
    checkActive() {},
    policy: a.policy,
  });
  const lifetime = captureTerminalProcessLifetime({
    process: second,
    terminals: [{ identity: b.display.identity, inputs: [input] }],
  });
  const worker = new Worker(new URL("./fixtures/terminal-control-worker.ts", import.meta.url), {
    workerData: {
      role: "holder",
      process: second,
      context: member.context,
      input: input.buffer,
      flags: flags.buffer,
      inputPause: true,
    } satisfies TerminalControlWorkerData,
  });
  const errors: unknown[] = [];
  worker.on("error", (error) => errors.push(error));
  try {
    const deadline = Date.now() + 3000;
    while (Atomics.load(flags, 0) === 0) {
      if (Date.now() > deadline) throw Error("input holder did not acquire");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const sequence = Atomics.load(input.notification, 0);
    const observed = input.observe();
    const blocked = await a.authority.control(() => ({
      kind: "ok",
      value: attachment.resolve(0).tryRead!([new Uint8Array(1)]),
    }));
    expect(blocked).toMatchObject({ kind: "ok", value: -6 });
    let woke = false;
    const pending = observed.wait().then((result) => {
      woke = true;
      return result;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    expect(await pending).toMatchObject({ kind: "ok" });
    expect(Atomics.load(input.notification, 0)).toBe(sequence); // Unlock, not data, woke it.
    expect(await observed.wait()).toMatchObject({ kind: "error", code: "INVALID" });
    const data = input.observe();
    const dataWait = data.wait();
    expect(input.push(Uint8Array.of(66))).toBe(1);
    expect(await dataWait).toMatchObject({ kind: "ok" });
    const bytes = new Uint8Array(1);
    expect(
      (
        await a.authority.control(() => ({
          kind: "ok",
          value: attachment.resolve(0).tryRead!([bytes]),
        }))
      ).kind,
    ).toBe("ok");
    expect(bytes[0]).toBe(66);
    expect(input.available()).toBe(0);
    const cancel = new AbortController();
    const cancelled = input.observe().wait({ signal: cancel.signal });
    cancel.abort();
    expect(await cancelled).toMatchObject({ kind: "error", code: "CANCELED" });
    expect(errors).toEqual([]);
  } finally {
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    await lifetime.quiesce();
    await worker.terminate();
    lifetime.stopped();
    attachment.dispose();
    a.display.close("disposed");
    b.display.close("disposed");
    input.close();
  }
}, 10000);

test("aborted retirement and slot reuse leave the original active group intact", async () => {
  const f = fixture();
  try {
    const original = must(f.authority.createGroup({ initialMode: "raw" }));
    must(f.authority.admitExisting({ group: original, pid: f.root.pid }));
    must(f.authority.startBackground(original));
    let replacement: ReturnType<typeof f.authority.createGroup> | undefined;
    const result = await f.authority.control(() => {
      must(f.authority.retireGroup({ group: original, reason: "completed" }));
      replacement = f.authority.createGroup({ initialMode: "raw" });
      must(replacement);
      return { kind: "error", code: "CAPACITY" };
    });
    expect(result.receipt.group(original)).toBe("active");
    expect(f.authority.startBackground(original).kind).toBe("ok");
    expect(result.receipt.group(must(replacement!))).toBe("stale");
    expect(f.authority.startBackground(must(replacement!))).toMatchObject({
      kind: "error",
      code: "STALE",
    });
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("rollback preserves newly issued aliases of existing memberships and leases", async () => {
  const f = fixture();
  try {
    const group = must(f.authority.createGroup({ initialMode: "raw" }));
    const original = must(f.authority.admitExisting({ group, pid: f.root.pid }));
    const lease = must(f.authority.acquire({ group, expected: null }));
    let alias: typeof original | undefined;
    const result = await f.authority.control(() => {
      alias = must(f.authority.admitExisting({ group, pid: f.root.pid }));
      return { kind: "error", code: "CAPACITY" };
    });
    expect(result.receipt.member(original.member)).toBe("bound");
    expect(result.receipt.member(alias!.member)).toBe("bound");
    expect(result.receipt.lease(lease)).toBe(true);
    expect(result.receipt.lease(alias!.lease!)).toBe(true);
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

function scheduleCancellation(controller: AbortController): undefined {
  queueMicrotask(() => controller.abort());
}

test("cancellation after commit cannot discard a committed return handle", async () => {
  const f = fixture(),
    cancel = new AbortController();
  try {
    const result = await f.authority.control(
      (turn) => {
        const group = must(f.authority.createGroup({ initialMode: "raw" }));
        turn.publish(() => scheduleCancellation(cancel));
        return { kind: "ok", value: group };
      },
      { signal: cancel.signal },
    );
    expect(cancel.signal.aborted).toBe(true);
    expect(result.kind).toBe("ok");
    expect(result.receipt.phase).toBe("committed");
    if (result.kind !== "ok") throw Error(result.code);
    expect(result.receipt.group(result.value)).toBe("active");
    expect(f.authority.retireGroup({ group: result.value, reason: "cancelled" }).kind).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("a scoped runtime wait is rejected without blocking while a nonblocking job probe remains valid", async () => {
  const f = fixture();
  const descriptors = new DescriptorTable();
  let waits = 0;
  const client = new WorkerProcessClient({
    transport: f.root,
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
    postMessage() {},
  });
  const pid = client.spawn(client.pid, {
    executable: "fixture",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  const job = client.jobOf(pid);
  const abi = new ProcessABI({
    memory: new WebAssembly.Memory({ initial: 1 }),
    descriptors,
    fs: new MemFS(),
    pid: client.pid,
    service: client,
    signals: client.signals,
    wake: client.wake,
    wait() {
      waits++;
      throw Error("a scoped wait reached the blocking host");
    },
  });
  try {
    const result = await f.authority.control(() => {
      expect(abi.imports.wait_job!(job, 1, 64)).toBe(-6);
      expect(abi.imports.wait_job!(job, 0, 64)).toBe(-58);
      return { kind: "ok", value: undefined };
    });
    expect(result.kind).toBe("ok");
    expect(waits).toBe(0);
  } finally {
    descriptors.dispose();
    f.display.close("disposed");
    f.input.close();
  }
});
