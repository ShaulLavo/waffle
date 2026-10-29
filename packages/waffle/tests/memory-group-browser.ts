import { createRuntime, type ProcessService, type RuntimeSupervisor } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import type { MemoryGroupHandle, MemoryGroupSnapshot } from "../group/state.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pause = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(check: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 1000; i++) {
    const value = check();
    if (value) return value;
    await pause();
  }
  throw new Error(`memory group observation timed out: ${label}`);
}

function flatten(error: unknown): string[] {
  if (error instanceof AggregateError) return [error.message].concat(error.errors.flatMap(flatten));
  return [String(error instanceof Error ? error.message : error)];
}

const Op = {
  INIT: 1, INFO: 2, CHURN: 3, CREATE: 4, ATTACH: 5, DETACH: 6, PIN: 7, ROUTE: 8,
  ACCEPT: 9, UNPIN: 10, WAIT32: 11, STORE: 12, LOAD: 13, WAKE: 14, EXIT: 15, GROW: 16,
} as const;

interface Member {
  readonly pid: number;
  readonly command: number;
  seq: number;
}

/** Runs the J1 acceptance through the real runtime, broker, worker bootstrap and PIE loader. */
export async function memoryGroupBrowser(): Promise<Record<string, unknown>> {
  const NativeWorker = globalThis.Worker;
  const failing = new Set<number>();
  const workers = new Map<number, Worker>();
  const created: Worker[] = [];
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created.push(this);
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "group-ready") workers.set(data.pid, this);
      });
    }
    override terminate() {
      for (const [pid, worker] of workers)
        if (worker === this && failing.has(pid)) throw new Error(`injected terminate failure ${pid}`);
      super.terminate();
    }
  };
  const runtime = createRuntime({
    filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
    memoryGroups: { members: 4, budgetBytes: 256 * 1024 * 1024, stackBytes: 64 * 1024 },
  });
  const ready = new Map<number, number>();
  let group: MemoryGroupHandle | undefined;
  runtime.registerAdapter("group", (context, service) =>
    service.launchWorker(context, {
      workerUrl: "/memory-group-worker.js",
      request: { module: context.module, args: context.request.argv, env: {}, interruptible: false },
      memoryGroup: context.request.argv[0] === "lead" ? "new" : group!,
      onMessage(message) {
        const data = message as { type?: string; command?: number; pid?: number };
        if (data.type === "group-ready") ready.set(data.pid!, data.command!);
      },
    }),
  );
  const source = new Uint8Array(await (await fetch("/memory-group-member.wasm")).arrayBuffer());
  const module = await WebAssembly.compile(source);
  runtime.registerProgram("/member", { adapter: "group", module, cooperative: true });
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  const unused = (): never => {
    throw new Error("unexpected descriptor transfer");
  };
  const notices: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  const service: ProcessService = await runtime.processes();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  };
  let supervisor!: RuntimeSupervisor;
  const launch = async (role: string): Promise<number> => {
    const pid = client.spawn(root.pid, {
      executable: "/member",
      argv: [role],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    await flush();
    await supervisor.start(pid).catch(() => {});
    return pid;
  };
  const spawn = async (role: string): Promise<Member> => {
    const pid = await launch(role);
    const command = await until(() => ready.get(pid), `ready ${pid}`);
    return { pid, command, seq: 0 };
  };
  const words = () => new Int32Array(group!.memory.buffer);
  const send = (member: Member, op: number, ...args: number[]): Promise<number[]> => {
    const base = member.command / 4;
    const cells = words();
    for (let i = 0; i < 4; i++) cells[base + 3 + i] = args[i] ?? 0;
    cells[base + 2] = op;
    const seq = ++member.seq;
    Atomics.store(cells, base, seq);
    Atomics.notify(cells, base);
    return (async () => {
      for (;;) {
        const done = Atomics.load(cells, base + 1);
        if (done === seq) return Array.from(cells.subarray(base + 8, base + 12));
        const waited = Atomics.waitAsync(cells, base + 1, done, 5000);
        if ((waited.async ? await waited.value : waited.value) === "timed-out")
          throw new Error(`member ${member.pid} did not answer op ${op}`);
      }
    })();
  };
  const call = async (member: Member, op: number, ...args: number[]) => {
    const result = await send(member, op, ...args);
    return result;
  };
  const snapshot = (): MemoryGroupSnapshot =>
    service.memoryGroups().find((entry) => entry.id === group!.id)!;
  const reaped = (pid: number) =>
    until(() => !snapshot().pids.includes(pid), `physical stop of ${pid}`);
  const kill = async (member: Member) => {
    await supervisor.kill(member.pid, 9);
    await supervisor.waitForExit(root.pid, member.pid);
    client.wait(root.pid, member.pid);
    await flush();
  };
  const exit = async (member: Member) => {
    void send(member, Op.EXIT, 0);
    await supervisor.waitForExit(root.pid, member.pid);
    client.wait(root.pid, member.pid);
    await flush();
  };
  const report: Record<string, unknown> = {};
  try {
    await runtime.filesystem.writeFile("/member", source);
    await service.adoptRuntimeRoot(root);
    supervisor = await service.ready();

    // Two relocated images in one shared memory.
    const leadPid = await launch("lead");
    await until(() => ready.get(leadPid), "leader ready");
    group = service.memoryGroupOf(leadPid);
    assert(group?.memory.buffer instanceof SharedArrayBuffer, "leader has no shared group memory");
    const a: Member = { pid: leadPid, command: ready.get(leadPid)!, seq: 0 };
    const b = await spawn("member");
    assert(service.memoryGroupOf(b.pid) === group, "second member joined another group");
    const [counterA, addrA, opA, stackA] = await call(a, Op.INIT, 1, 0);
    const [counterB, addrB, opB, stackB] = await call(b, Op.INIT, 2, 1);
    assert(counterA === 8 && counterB === 9 && addrA !== addrB, "statics are not per member");
    assert(opA === 14 && opB === 21, "function tables are not per member");
    assert(stackA! > 0 && stackB! > 0 && stackA !== stackB, "stacks are not per member");
    const [greetingA, parallelism, pidA] = await call(a, Op.INFO);
    const [greetingB, , pidB] = await call(b, Op.INFO);
    assert(greetingA === 1 && greetingB === 1, "data relocation failed");
    assert(parallelism === 1 && pidA === a.pid && pidB === b.pid, "W2 hint or pid is wrong");
    const [churnA, lowA, highA] = await Promise.all([
      call(a, Op.CHURN, 0x41, 3),
      call(b, Op.CHURN, 0x42, 3),
    ]).then(([left, right]) => {
      assert(right[0] === 0, `member B heap churn ${right[0]}`);
      // Both fill-verify every block while the other grows the same memory concurrently.
      report.heaps = { a: left.slice(1, 3), b: right.slice(1, 3) };
      return left;
    });
    assert(churnA === 0 && lowA! < highA!, `member A heap churn ${churnA}`);
    report.images = { counters: [counterA, counterB], statics: [addrA, addrB], stacks: [stackA, stackB] };

    // Real shared bytes, transit pin, cross-member futex.
    const [created, handle, addr] = await call(a, Op.CREATE, 64, 16);
    assert(created === 0, `shm_create ${created}`);
    assert((await call(b, Op.ATTACH, handle!))[1] === addr, "attach saw another address");
    await call(b, Op.STORE, addr! + 4, 42);
    assert((await call(a, Op.LOAD, addr! + 4))[0] === 42, "bytes are not shared");
    const [pinned, pin] = await call(a, Op.PIN, handle!);
    assert(pinned === 0 && (await call(a, Op.ROUTE, pin!, b.pid))[0] === 0, "route failed");
    assert((await call(a, Op.ACCEPT, pin!))[0] === -8, "a non-owner accepted a pin");
    const accepted = await call(b, Op.ACCEPT, pin!);
    assert(accepted[0] === 0 && accepted[1] === handle && accepted[2] === addr, "accept failed");
    assert(snapshot().pins === 0 && snapshot().holds === 3, "accept did not convert the pin");
    const waiting = send(a, Op.WAIT32, addr!, 0, -1);
    await pause(100);
    await call(b, Op.STORE, addr!, 1);
    const [woken] = await call(b, Op.WAKE, addr!, 1);
    const [waited] = await waiting;
    assert(woken === 1 && waited === 0, `cross-member futex woke ${woken}, wait ${waited}`);
    assert((await call(a, Op.WAIT32, addr!, 0, -1))[0] === 1, "not-equal");
    assert((await call(a, Op.WAIT32, addr!, 1, 10))[0] === 2, "timed-out");
    assert((await call(a, Op.DETACH, handle!))[0] === 0, "leader detach");
    assert(snapshot().regions === 1, "region freed while a holder remains");
    await call(b, Op.DETACH, handle!);
    await call(b, Op.DETACH, handle!);
    assert(snapshot().regions === 0 && snapshot().holds === 0, "region survived both detaches");
    report.sharing = { woken, waited, regionsAfterDetach: snapshot().regions };

    // A member killed while blocked in futex_wait, holding and owed deliveries.
    const [, mailbox, mailboxAddr] = await call(a, Op.CREATE, 256, 16);
    const blocked = await spawn("member");
    await call(blocked, Op.ATTACH, mailbox!);
    const [, owned] = await call(blocked, Op.CREATE, 4096, 16);
    await call(blocked, Op.PIN, owned!);
    const [, owed] = await call(a, Op.CREATE, 128 * 1024, 16);
    const [, owedPin] = await call(a, Op.PIN, owed!);
    await call(a, Op.ROUTE, owedPin!, blocked.pid);
    await call(a, Op.DETACH, owed!);
    const [blockedPage] = await call(blocked, Op.GROW, 4);
    const parked = send(blocked, Op.WAIT32, 8, 12345, -1);
    void parked.catch(() => {});
    await pause(50);
    const beforeKill = snapshot();
    await kill(blocked);
    await reaped(blocked.pid);
    const afterKill = snapshot();
    assert(afterKill.pins === 0 && afterKill.regions === 1 && afterKill.holds === 1, "kill leaked");
    assert(afterKill.committedBytes === beforeKill.committedBytes, "kill changed committed backing");
    assert(afterKill.freeBytes > beforeKill.freeBytes, "killed member chunks were not freed");
    // The freed first region may have been reused; wait on the live mailbox instead.
    assert((await call(a, Op.WAIT32, mailboxAddr!, 0, 5))[0] === 2, "group unusable after kill");
    report.killedBlocked = { before: beforeKill, after: afterKill };

    // Exited chunks are reused without growing the group.
    const reused = await spawn("member");
    assert(reused.command === blocked.command, "member data did not reuse the freed chunk");
    // Heap growth comes from pages committed before this member started, not new backing.
    const [reusedPage] = await call(reused, Op.GROW, 4);
    assert(
      reusedPage! > 0 && (reusedPage! + 4) * 65536 <= afterKill.committedBytes,
      "heap did not reuse freed chunks",
    );
    assert(snapshot().committedBytes === afterKill.committedBytes, "reuse grew the group");
    report.reuse = { command: reused.command, killedHeapPage: blockedPage, reusedHeapPage: reusedPage };

    // Repeated spawn/send/kill returns to baseline without ending the group.
    const baseline = snapshot();
    let committed = 0;
    const rounds: number[] = [];
    for (let round = 0; round < 6; round++) {
      const target = await spawn("member");
      const [, big] = await call(a, Op.CREATE, 512 * 1024, 16);
      const [, bigPin] = await call(a, Op.PIN, big!);
      await call(a, Op.ROUTE, bigPin!, target.pid);
      await call(a, Op.DETACH, big!);
      const [, small] = await call(a, Op.PIN, mailbox!);
      await call(a, Op.ROUTE, small!, target.pid);
      const [, aborted] = await call(a, Op.PIN, mailbox!);
      await call(a, Op.UNPIN, aborted!);
      await call(target, Op.GROW, 2);
      await kill(target);
      await reaped(target.pid);
      const now = snapshot();
      assert(
        now.regions === baseline.regions && now.pins === baseline.pins && now.holds === baseline.holds,
        `round ${round} leaked ${JSON.stringify(now)}`,
      );
      if (round === 0) committed = now.committedBytes;
      else assert(now.committedBytes === committed, `round ${round} grew backing`);
      rounds.push(now.committedBytes);
    }
    report.churn = { baseline, rounds };

    // W3: a request beyond the page budget fails without growth.
    const budgetBefore = snapshot().committedBytes;
    assert((await call(a, Op.CREATE, 300 * 1024 * 1024, 16))[0] === -48, "W3 admitted too much");
    assert(snapshot().committedBytes === budgetBefore, "rejected request grew the group");

    // W1: four members including the leader; the fifth gets EAGAIN with nothing retained.
    const fourth = await spawn("member");
    const rejected = await launch("member");
    const outcome = await supervisor.waitForExit(root.pid, rejected);
    client.wait(root.pid, rejected);
    await flush();
    assert(snapshot().members === 4 && snapshot().reserved === 0, "EAGAIN left a reservation");
    report.admission = { rejected: outcome };

    // W4: a failed physical stop keeps capacity, memory and debt.
    failing.add(fourth.pid);
    const beforeFailure = snapshot();
    await kill(fourth);
    await until(() => snapshot().retained === 1, "retained debt");
    const debt = snapshot();
    assert(debt.pids.includes(fourth.pid) && debt.freeBytes === beforeFailure.freeBytes, "debt freed");
    const stillFull = await launch("member");
    await supervisor.waitForExit(root.pid, stillFull);
    client.wait(root.pid, stillFull);
    await flush();
    assert(snapshot().retained === 1 && snapshot().members === 3, "failed stop returned capacity");
    report.failedStop = { before: beforeFailure, debt };

    for (const member of [a, b, reused]) await exit(member);
    await until(() => snapshot().members === 0, "members exited");
    report.final = snapshot();
    return report;
  } finally {
    descriptors.dispose();
    const disposal = await runtime.dispose().then(
      () => "resolved",
      (error: unknown) => flatten(error).join("; "),
    );
    report.disposal = disposal;
    failing.clear();
    for (const worker of created) worker.terminate();
    globalThis.Worker = NativeWorker;
  }
}
