import { createRuntime, type ProcessService, type RuntimeSupervisor } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import type { MemoryGroupHandle, MemoryGroupSnapshot } from "../group/state.js";
import { prepareLinkPlan } from "../link/index.js";

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
  INIT: 1,
  INFO: 2,
  CHURN: 3,
  CREATE: 4,
  ATTACH: 5,
  DETACH: 6,
  PIN: 7,
  ROUTE: 8,
  ACCEPT: 9,
  UNPIN: 10,
  WAIT32: 11,
  STORE: 12,
  LOAD: 13,
  WAKE: 14,
  EXIT: 15,
  GROW: 16,
  WATCH: 17,
  UNWATCH: 18,
  POLL: 19,
  WRITE: 20,
  READ: 21,
  CWD: 22,
  CREATE_RAW: 23,
  ACCEPT_RAW: 24,
  ATTACH_RAW: 25,
  PIN_RAW: 26,
} as const;

interface Member {
  readonly pid: number;
  readonly command: number;
  seq: number;
}

type Report = Record<string, unknown>;

/** Real runtime, broker, generic bootstrap and PIE loader; the page drives each member. */
async function harness() {
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
        if (worker === this && failing.has(pid))
          throw new Error(`injected terminate failure ${pid}`);
      super.terminate();
    }
  };
  const runtime = createRuntime({
    filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
    memoryGroups: { members: 4, budgetBytes: 256 * 1024 * 1024, stackBytes: 64 * 1024 },
  });
  const ready = new Map<number, number>();
  let group: MemoryGroupHandle | undefined;
  const source = new Uint8Array(await (await fetch("/memory-group-member.wasm")).arrayBuffer());
  // Group members load through Waffle's link loader, which admits only growth-free images.
  const plan = await prepareLinkPlan({
    core: {
      id: "member",
      source,
      cooperative: true,
      checkpoint: { module: "test", name: "checkpoint" },
      initialize: ["member_initialize_memory"],
    },
    libraries: [],
    reserve: "member_reserve",
  });
  runtime.registerAdapter("group", (context, service) =>
    service.launchWorker(context, {
      workerUrl: "/memory-group-worker.js",
      request: {
        module: context.module,
        args: context.request.argv,
        env: {},
        linkPlan: plan.toSource(),
      },
      memoryGroup: context.request.argv[0] === "lead" ? "new" : group!,
      onMessage(message) {
        const data = message as { type?: string; command?: number; pid?: number };
        if (data.type === "group-ready") ready.set(data.pid!, data.command!);
      },
    }),
  );
  runtime.registerProgram("/member", {
    adapter: "group",
    module: plan.entryModule,
    cooperative: true,
  });
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
  await runtime.filesystem.writeFile("/member", source);
  await service.adoptRuntimeRoot(root);
  const supervisor: RuntimeSupervisor = await service.ready();
  await runtime.filesystem.mkdirp("/tmp");
  const launch = async (role: string, cwd = "/"): Promise<number> => {
    const pid = client.spawn(root.pid, {
      executable: "/member",
      argv: [role],
      env: {},
      cwd,
      job: -1,
      fds: [],
    });
    await flush();
    await supervisor.start(pid).catch(() => {});
    return pid;
  };
  const collect = async (pid: number) => {
    const outcome = await supervisor.waitForExit(root.pid, pid);
    client.wait(root.pid, pid);
    await flush();
    return outcome;
  };
  const spawn = async (role: string, cwd = "/"): Promise<Member> => {
    const pid = await launch(role, cwd);
    const command = await until(() => ready.get(pid), `ready ${pid}`);
    if (role === "lead") group = service.memoryGroupOf(pid);
    return { pid, command, seq: 0 };
  };
  const send = (member: Member, op: number, ...args: number[]): Promise<number[]> => {
    const base = member.command / 4;
    const cells = new Int32Array(group!.buffer());
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
  const snapshot = (): MemoryGroupSnapshot =>
    service.memoryGroups().find((entry) => entry.id === group!.id)!;
  return {
    service,
    launch,
    spawn,
    send,
    call: send,
    collect,
    snapshot,
    failing,
    group: () => group!,
    reaped: (pid: number) => until(() => !snapshot().pids.includes(pid), `physical stop of ${pid}`),
    kill: async (member: Member) => {
      await supervisor.kill(member.pid, 9);
      await collect(member.pid);
    },
    exit: async (member: Member) => {
      void send(member, Op.EXIT, 0);
      await collect(member.pid);
    },
    async dispose(): Promise<string> {
      descriptors.dispose();
      const disposal = await runtime.dispose().then(
        () => "resolved",
        (error: unknown) => flatten(error).join("; "),
      );
      // Unsettled group debt must keep the one-runtime page guard.
      let guard = "released";
      try {
        await createRuntime().dispose();
      } catch (error) {
        guard = String(error instanceof Error ? error.message : error);
      }
      failing.clear();
      for (const worker of created) worker.terminate();
      globalThis.Worker = NativeWorker;
      return `${disposal} | guard: ${guard}`;
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;

/** Two relocated images: distinct statics, tables, stacks and concurrent private heaps. */
async function images(h: Harness, report: Report) {
  const a = await h.spawn("lead");
  assert(h.group().buffer() instanceof SharedArrayBuffer, "no shared group memory");
  assert(!("memory" in h.group()), "the page handle exposes a growable Memory");
  const b = await h.spawn("member");
  assert(h.service.memoryGroupOf(b.pid) === h.group(), "second member joined another group");
  const [counterA, addrA, opA, stackA] = await h.call(a, Op.INIT, 1, 0);
  const [counterB, addrB, opB, stackB] = await h.call(b, Op.INIT, 2, 1);
  assert(counterA === 8 && counterB === 9 && addrA !== addrB, "statics are not per member");
  assert(opA === 14 && opB === 21, "function tables are not per member");
  assert(stackA! > 0 && stackB! > 0 && stackA !== stackB, "stacks are not per member");
  const [greetingA, parallelism, pidA] = await h.call(a, Op.INFO);
  const [greetingB, , pidB] = await h.call(b, Op.INFO);
  assert(greetingA === 1 && greetingB === 1, "data relocation failed");
  assert(parallelism === 1 && pidA === a.pid && pidB === b.pid, "W2 hint or pid is wrong");
  // Both fill-verify every block while the other grows the same memory concurrently.
  const [left, right] = await Promise.all([
    h.call(a, Op.CHURN, 0x41, 3),
    h.call(b, Op.CHURN, 0x42, 3),
  ]);
  assert(left[0] === 0 && right[0] === 0, `heap churn ${left[0]}/${right[0]}`);
  report.images = {
    counters: [counterA, counterB],
    statics: [addrA, addrB],
    stacks: [stackA, stackB],
    heaps: { a: left.slice(1, 3), b: right.slice(1, 3) },
  };
  return { a, b };
}

/** Real shared bytes, a routed transit pin, cross-member futex, region freed by both detaches. */
async function sharing(h: Harness, a: Member, b: Member, report: Report) {
  const [created, handle, addr] = await h.call(a, Op.CREATE, 64, 16);
  assert(created === 0, `shm_create ${created}`);
  assert((await h.call(b, Op.ATTACH, handle!))[1] === addr, "attach saw another address");
  await h.call(b, Op.STORE, addr! + 4, 42);
  assert((await h.call(a, Op.LOAD, addr! + 4))[0] === 42, "bytes are not shared");
  const [pinned, pin] = await h.call(a, Op.PIN, handle!);
  assert(pinned === 0 && (await h.call(a, Op.ROUTE, pin!, b.pid))[0] === 0, "route failed");
  assert((await h.call(a, Op.ACCEPT, pin!))[0] === -8, "a non-owner accepted a pin");
  const accepted = await h.call(b, Op.ACCEPT, pin!);
  assert(accepted[0] === 0 && accepted[1] === handle && accepted[2] === addr, "accept failed");
  assert(h.snapshot().pins === 0 && h.snapshot().holds === 3, "accept kept the pin");
  const waiting = h.send(a, Op.WAIT32, addr!, 0, -1);
  await pause(100);
  await h.call(b, Op.STORE, addr!, 1);
  const [woken] = await h.call(b, Op.WAKE, addr!, 1);
  const [waited] = await waiting;
  assert(woken === 1 && waited === 0, `cross-member futex woke ${woken}, wait ${waited}`);
  assert((await h.call(a, Op.WAIT32, addr!, 0, -1))[0] === 1, "not-equal");
  assert((await h.call(a, Op.WAIT32, addr!, 1, 10))[0] === 2, "timed-out");
  assert((await h.call(a, Op.DETACH, handle!))[0] === 0, "leader detach");
  assert(h.snapshot().regions === 1, "region freed while a holder remains");
  await h.call(b, Op.DETACH, handle!);
  await h.call(b, Op.DETACH, handle!);
  assert(h.snapshot().regions === 0 && h.snapshot().holds === 0, "region survived both detaches");
  report.sharing = { woken, waited, regionsAfterDetach: h.snapshot().regions };
}

/** FUTEX watches through runtime_proc.poll kind 7: a wake from another member readies it. */
async function watches(h: Harness, a: Member, b: Member, mailbox: number, report: Report) {
  const [, addr] = await h.call(b, Op.ATTACH, mailbox);
  const watched = addr! + 64;
  const [watchStatus, watch] = await h.call(a, Op.WATCH, watched, 0);
  assert(watchStatus === 0 && h.snapshot().watches === 1, "futex_watch failed");
  assert((await h.call(a, Op.POLL, watch!, 5))[0] === 0, "an unhit watch polled ready");
  const polling = h.send(a, Op.POLL, watch!, -1);
  await pause(50);
  const [woken] = await h.call(b, Op.WAKE, watched, 1);
  const [ready, userdata] = await polling;
  assert(woken === 1 && ready === 1 && userdata === 0x5157, `watch ${woken}/${ready}`);
  assert((await h.call(a, Op.POLL, watch!, 0))[0] === 1, "watch readiness was consumed");
  await h.call(a, Op.UNWATCH, watch!);
  const [, valueWatch] = await h.call(a, Op.WATCH, watched, 5);
  assert((await h.call(a, Op.POLL, valueWatch!, 0))[0] === 1, "value change did not ready");
  await h.call(a, Op.UNWATCH, valueWatch!);
  // Successive one-count wakes ready distinct watches; a hit watch is never selected again.
  const [, first] = await h.call(a, Op.WATCH, watched, 0);
  const [, second] = await h.call(a, Op.WATCH, watched, 0);
  const wakes = [(await h.call(b, Op.WAKE, watched, 1))[0]];
  const firstReady = (await h.call(a, Op.POLL, first!, 0))[0];
  const secondBefore = (await h.call(a, Op.POLL, second!, 0))[0];
  wakes.push((await h.call(b, Op.WAKE, watched, 1))[0], (await h.call(b, Op.WAKE, watched, 1))[0]);
  const secondAfter = (await h.call(a, Op.POLL, second!, 0))[0];
  const fair = firstReady === 1 && secondBefore === 0 && secondAfter === 1;
  assert(fair && wakes.join() === "1,1,0", `wake-one starvation ${wakes} ${secondAfter}`);
  await h.call(a, Op.UNWATCH, first!);
  await h.call(a, Op.UNWATCH, second!);
  await h.call(b, Op.DETACH, mailbox);
  assert(h.snapshot().watches === 0 && h.snapshot().holds === 1, "unwatch or detach leaked");
  report.watches = { woken, ready, partialWakes: wakes };
}

/** F1: members share the tree through their own identities, each with its spawn cwd. */
async function filesystem(h: Harness, a: Member, b: Member, report: Report) {
  const text = (address: number, length: number) =>
    new TextDecoder().decode(new Uint8Array(h.group().buffer(), address, length).slice());
  assert((await h.call(a, Op.WRITE, 0x1234))[0] === 4, "member write failed");
  const [read, value] = await h.call(b, Op.READ);
  assert(read === 4 && value === 0x1234, `completed write not visible: ${read}/${value}`);
  const elsewhere = await h.spawn("member", "/tmp");
  const [length, cwd] = await h.call(elsewhere, Op.CWD);
  const [rootLength, rootCwd] = await h.call(a, Op.CWD);
  assert(text(cwd!, length!) === "/tmp" && text(rootCwd!, rootLength!) === "/", "cwd snapshot");
  const [againRead, again] = await h.call(elsewhere, Op.READ);
  assert(againRead === 4 && again === 0x1234, "a later member does not see the shared tree");
  await h.exit(elsewhere);
  await h.reaped(elsewhere.pid);
  report.filesystem = { value, cwd: text(cwd!, length!) };
}

/** Invalid output spans fail before the owner changes regions, holds or pins. */
async function outputs(h: Harness, a: Member, mailbox: number, report: Report) {
  const counters = () => {
    const { regions, pins, holds } = h.snapshot();
    return `${regions}/${pins}/${holds}`;
  };
  const before = counters();
  const bad = [0xfffffff8, 3];
  for (const out of bad) {
    assert((await h.call(a, Op.CREATE_RAW, 16, 16, out))[0] === -28, "create accepted bad out");
    assert((await h.call(a, Op.ATTACH_RAW, mailbox, out))[0] === -28, "attach accepted bad out");
    assert((await h.call(a, Op.PIN_RAW, mailbox, out))[0] === -28, "pin accepted bad out");
  }
  assert(counters() === before, `failed outputs changed owner state ${before} -> ${counters()}`);
  const [, pin] = await h.call(a, Op.PIN, mailbox);
  await h.call(a, Op.ROUTE, pin!, a.pid);
  const pinned = counters();
  assert((await h.call(a, Op.ACCEPT_RAW, pin!, 0xfffffff8))[0] === -28, "accept bad out");
  assert(counters() === pinned, "a failed accept consumed its pin");
  assert((await h.call(a, Op.ACCEPT, pin!))[0] === 0, "pin lost after a failed accept");
  await h.call(a, Op.DETACH, mailbox);
  assert(counters() === before, "accept left an extra hold");
  report.outputs = { counters: before };
}

/** A member killed while blocked in futex_wait; then its chunks are reused. */
async function killed(h: Harness, a: Member, mailbox: number, mailboxAddr: number, report: Report) {
  const blocked = await h.spawn("member");
  await h.call(blocked, Op.ATTACH, mailbox);
  const [, owned] = await h.call(blocked, Op.CREATE, 4096, 16);
  await h.call(blocked, Op.PIN, owned!);
  const [, owed] = await h.call(a, Op.CREATE, 128 * 1024, 16);
  const [, owedPin] = await h.call(a, Op.PIN, owed!);
  await h.call(a, Op.ROUTE, owedPin!, blocked.pid);
  await h.call(a, Op.DETACH, owed!);
  const [blockedPage] = await h.call(blocked, Op.GROW, 4);
  await h.call(blocked, Op.WATCH, mailboxAddr, 0);
  void h.send(blocked, Op.WAIT32, 8, 12345, -1).catch(() => {});
  await pause(50);
  const before = h.snapshot();
  await h.kill(blocked);
  await h.reaped(blocked.pid);
  const after = h.snapshot();
  const clean = after.pins === 0 && after.regions === 1 && after.holds === 1 && !after.watches;
  assert(clean, `kill leaked ${JSON.stringify(after)}`);
  assert(after.committedBytes === before.committedBytes, "kill changed committed backing");
  assert(after.freeBytes > before.freeBytes, "killed member chunks were not freed");
  assert((await h.call(a, Op.WAIT32, mailboxAddr, 0, 5))[0] === 2, "group unusable after kill");
  const reused = await h.spawn("member");
  assert(reused.command === blocked.command, "member data did not reuse the freed chunk");
  // Heap growth comes from pages committed before this member started, not new backing.
  const [reusedPage] = await h.call(reused, Op.GROW, 4);
  const inside = reusedPage! > 0 && (reusedPage! + 4) * 65536 <= after.committedBytes;
  assert(inside, "heap did not reuse freed chunks");
  assert(h.snapshot().committedBytes === after.committedBytes, "reuse grew the group");
  report.killedBlocked = { before, after };
  report.reuse = {
    command: reused.command,
    killedHeapPage: blockedPage,
    reusedHeapPage: reusedPage,
  };
  return reused;
}

/** Repeated spawn/send/kill returns to baseline without ending the group. */
async function churn(h: Harness, a: Member, mailbox: number, report: Report) {
  const baseline = h.snapshot();
  const rounds: number[] = [];
  for (let round = 0; round < 6; round++) {
    const target = await h.spawn("member");
    const [, big] = await h.call(a, Op.CREATE, 512 * 1024, 16);
    const [, bigPin] = await h.call(a, Op.PIN, big!);
    await h.call(a, Op.ROUTE, bigPin!, target.pid);
    await h.call(a, Op.DETACH, big!);
    const [, small] = await h.call(a, Op.PIN, mailbox);
    await h.call(a, Op.ROUTE, small!, target.pid);
    const [, aborted] = await h.call(a, Op.PIN, mailbox);
    await h.call(a, Op.UNPIN, aborted!);
    await h.call(target, Op.GROW, 2);
    await h.kill(target);
    await h.reaped(target.pid);
    const now = h.snapshot();
    const same =
      now.regions === baseline.regions &&
      now.pins === baseline.pins &&
      now.holds === baseline.holds;
    assert(same, `round ${round} leaked ${JSON.stringify(now)}`);
    assert(round === 0 || now.committedBytes === rounds[0], `round ${round} grew backing`);
    rounds.push(now.committedBytes);
  }
  report.churn = { baseline, rounds };
}

/** W3 rejection, W1 EAGAIN, and W4 retained debt after a failed physical stop. */
async function limits(h: Harness, a: Member, report: Report) {
  const budgetBefore = h.snapshot().committedBytes;
  assert((await h.call(a, Op.CREATE, 300 * 1024 * 1024, 16))[0] === -48, "W3 admitted too much");
  assert(h.snapshot().committedBytes === budgetBefore, "rejected request grew the group");
  const fourth = await h.spawn("member");
  const rejected = await h.collect(await h.launch("member"));
  assert(h.snapshot().members === 4 && h.snapshot().reserved === 0, "EAGAIN left a reservation");
  h.failing.add(fourth.pid);
  const before = h.snapshot();
  await h.kill(fourth);
  await until(() => h.snapshot().retained === 1, "retained debt");
  const debt = h.snapshot();
  assert(debt.pids.includes(fourth.pid) && debt.freeBytes === before.freeBytes, "debt freed");
  await h.collect(await h.launch("member"));
  assert(h.snapshot().retained === 1 && h.snapshot().members === 3, "failed stop freed capacity");
  report.admission = { rejected };
  report.failedStop = { before, debt };
}

/** @browserEntry Runs the J1 acceptance through the real runtime and Waffle's PIE loader. */
export async function memoryGroupBrowser(): Promise<Report> {
  const report: Report = {};
  const h = await harness();
  try {
    const { a, b } = await images(h, report);
    await sharing(h, a, b, report);
    const [, mailbox, mailboxAddr] = await h.call(a, Op.CREATE, 256, 16);
    await watches(h, a, b, mailbox!, report);
    await filesystem(h, a, b, report);
    await outputs(h, a, mailbox!, report);
    const reused = await killed(h, a, mailbox!, mailboxAddr!, report);
    await churn(h, a, mailbox!, report);
    await limits(h, a, report);
    for (const member of [a, b, reused]) await h.exit(member);
    await until(() => h.snapshot().members === 0, "members exited");
    report.final = h.snapshot();
    return report;
  } finally {
    report.disposal = await h.dispose();
  }
}
