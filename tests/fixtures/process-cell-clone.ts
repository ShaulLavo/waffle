import assert from "node:assert/strict";
import { MessageChannel, MessagePort, Worker, isMainThread, workerData } from "node:worker_threads";
import { DescriptorTable } from "waffle/core/descriptors";
import * as control from "waffle/proc/control";
import * as outcome from "waffle/proc/outcome";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { WorkerProcessBroker } from "waffle/proc/worker-broker";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { ProcessErrno, ProcessError } from "waffle/proc/types";
import { collectDirectoryJob, collectDirectoryProcess, confirmDirectoryProcess, directoryJobs, directorySlots, reserveDirectoryProcess } from "../../dist/proc/directory.js";

// All executable fixtures stay TypeScript; Node 24+ strips their types. Public
// package imports select prepared dist modules, just as a Node consumer does.
type Cells = { outcome: outcome.OutcomeCell; controls: control.TaggedCells[] };
type Transfer = { outcome: outcome.OutcomeTransfer; controls: control.TaggedCellsTransfer[] };
type Command = Transfer & { command: "stale" | "exit" | "terminal" };
const unused = (): never => { throw new Error("unexpected descriptor transfer"); };
const codec: WorkerDescriptorCodec = { export: unused, import: unused, discard: unused };
const exited = { kind: "exited", code: 23, status: 23 } as const;

function serialize(cells: Cells): Transfer {
  return { outcome: outcome.serializeOutcome(cells.outcome), controls: cells.controls.map(control.serializeTaggedCells) };
}
function revive(transfer: Transfer): Cells {
  const result = outcome.reviveOutcome(transfer.outcome);
  assert.ok(result instanceof outcome.OutcomeCell);
  const controls = transfer.controls.map(control.reviveTaggedCells);
  assert.equal(result.byteOffset, (transfer.outcome as outcome.OutcomeCellTransfer).byteOffset);
  for (let index = 0; index < controls.length; index++) {
    assert.equal(controls[index]!.byteOffset, transfer.controls[index]!.byteOffset);
    assert.equal(controls[index]!.length, transfer.controls[index]!.length);
  }
  return { outcome: result, controls };
}
function checkLive(cells: Cells): void {
  assert.equal(outcome.readOutcome(cells.outcome), null);
  for (const word of cells.controls) {
    for (let index = 0; index < word.length; index++) {
      const previous = control.controlLoad(word, index);
      assert.equal(control.controlCas(word, index, previous, previous + 1), previous);
      assert.equal(control.controlCas(word, index, previous + 1, previous), previous + 1);
    }
  }
}
function checkStale(cells: Cells): void {
  const srch = (error: unknown) => error instanceof ProcessError && error.errno === ProcessErrno.SRCH;
  assert.throws(() => outcome.readOutcome(cells.outcome), srch, "stale outcome read must reject SRCH");
  assert.throws(() => outcome.startStatus(cells.outcome), srch, "stale startup read must reject SRCH");
  assert.throws(() => outcome.markStarted(cells.outcome), srch, "stale startup commit must reject SRCH");
  assert.throws(() => outcome.claimOutcome(cells.outcome, { kind: "signaled", code: 9 }), srch, "stale outcome claim must reject SRCH");
  for (const word of cells.controls) {
    for (let index = 0; index < word.length; index++) {
      assert.throws(() => control.controlLoad(word, index), srch, "stale control load must reject SRCH");
      assert.throws(() => control.controlCas(word, index, 0, 99), srch, "stale control CAS must reject SRCH");
    }
  }
}

/** Owns only this test's worker, two ports, listeners and bounded response timer. */
class Guest {
  readonly channel = new MessageChannel();
  readonly worker: Worker;
  private messages: unknown[] = [];
  private failure?: Error;
  private pending?: { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  constructor(data: object, readAfterExit = false) {
    const readReplies = () => this.channel.port1.on("message", message => {
      const pending = this.pending;
      if (pending) { this.pending = undefined; clearTimeout(pending.timer); pending.resolve(message); }
      else this.messages.push(message);
    });
    // Worker exit only follows messages on parentPort, not this transferred port.
    // Its own close event follows its queued replies, so that is the reply fence.
    this.channel.port1.on("close", () => this.fail(new Error("Node worker reply port closed before the next reply")));
    if (!readAfterExit) readReplies();
    try {
      this.worker = new Worker(new URL(import.meta.url), { workerData: { ...data, port: this.channel.port2 }, transferList: [this.channel.port2] });
    } catch (error) {
      this.channel.port1.close(); this.channel.port2.close();
      throw error;
    }
    this.worker.on("error", error => this.fail(error));
    // Leave replies buffered until exit to force the legal exit-before-reply
    // ordering in the regression case, without timers or scheduler assumptions.
    if (readAfterExit) this.worker.once("exit", readReplies);
  }
  private fail(error: Error): void {
    this.failure = error;
    const pending = this.pending;
    if (pending) { this.pending = undefined; clearTimeout(pending.timer); pending.reject(error); }
  }
  next(): Promise<unknown> {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.failure) return Promise.reject(this.failure);
    assert.equal(this.pending, undefined, "only one response waiter per guest");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Node worker response timed out")), 3_000);
      this.pending = { resolve, reject, timer };
    });
  }
  post(message: object): void { this.channel.port1.postMessage(message); }
  async close(): Promise<void> {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = undefined; }
    this.channel.port1.close(); this.channel.port2.close();
    await this.worker.terminate();
  }
}

function fixture() {
  // Neither process nor job lifecycle identity is interchangeable with the other.
  const root = createWorkerProcessTransport({ pid: 11, job: 31, capacity: 2 });
  const child = reserveDirectoryProcess(root, 71, root.pid, 901, root.pid);
  return { root, child, state: workerProcessState(child) };
}
async function instances(readAfterExit = false): Promise<void> {
  const { child, state } = fixture();
  assert.notEqual(state.job, state.pid);
  let guest: Guest | undefined;
  try {
    // Deliberately pass the actual instances, not extracted buffers or serializer
    // output. Main's captured validity closures throw DataCloneError right here.
    guest = new Guest({ role: "instances", process: state.signals.outcome, job: state.jobOutcome,
      controls: [state.signals.interrupt, state.signals.signalState, state.jobPending], transport: child }, readAfterExit);
    assert.deepEqual(await guest.next(), { phase: "instances", pid: state.pid, job: state.job });
  } finally { await guest?.close(); }
}
async function noReply(): Promise<void> {
  const guest = new Guest({ role: "no-reply" });
  try { await assert.rejects(guest.next(), /reply port closed before the next reply/); }
  finally { await guest.close(); }
}
async function stale(mode: "process" | "job"): Promise<void> {
  const { root, child, state } = fixture();
  const cells: Cells = mode === "process"
    ? { outcome: state.signals.outcome, controls: [state.signals.interrupt, state.signals.requestedSignal, state.signals.signalState, state.confirmed, state.jobConfirmed, state.controlParent] }
    : { outcome: state.jobOutcome, controls: [state.jobPending, state.jobControlParent] };
  assert.notEqual(state.job, state.pid);
  assert.equal(cells.outcome.validity.id, mode === "job" ? state.job : state.pid);
  assert.equal(cells.outcome.pid, state.pid);
  assert.ok(cells.outcome.byteOffset > 0);
  let guest: Guest | undefined;
  try {
    assert.equal(outcome.markStarted(cells.outcome), true);
    guest = new Guest({ role: "stale", cells: serialize(cells) });
    assert.deepEqual(await guest.next(), { phase: "live" });
    assert.equal(outcome.readOutcome(cells.outcome), null);
    assert.equal(outcome.startStatus(cells.outcome), 0);
    assert.deepEqual(outcome.claimOutcome(cells.outcome, exited), exited);
    assert.deepEqual(outcome.claimOutcome(cells.outcome, { kind: "exited", code: 99 }), exited);
    guest.post({ command: "terminal", ...serialize(cells) });
    assert.deepEqual(await guest.next(), { phase: "terminal" });
    outcome.claimOutcome(state.signals.outcome, exited);
    confirmDirectoryProcess(child);
    assert.deepEqual(collectDirectoryProcess(child), exited);
    assert.deepEqual(collectDirectoryJob(root.directory, state.jobSlot, state.job), exited);
    assert.deepEqual(directorySlots(root.directory), [root.slot]);
    assert.deepEqual(directoryJobs(root.directory), [workerProcessState(root).jobSlot]);
    for (const phase of ["collected", "reused"] as const) {
      if (phase === "reused") {
        const replacement = reserveDirectoryProcess(root, 72, root.pid, 902, root.pid);
        const replacementState = workerProcessState(replacement);
        assert.equal(replacement.slot, child.slot, "exercise the very same process row");
        assert.equal(replacementState.jobSlot, state.jobSlot, "exercise the very same job row");
        assert.equal(outcome.readOutcome(replacementState.signals.outcome), null);
        assert.equal(outcome.readOutcome(replacementState.jobOutcome), null);
      }
      // Collection alone must invalidate escaping cells, even though their tagged
      // data words still contain the old incarnation until the next allocation.
      const before = Array.from(new BigInt64Array(root.directory));
      guest.post({ command: "stale", ...serialize(cells) });
      assert.deepEqual(await guest.next(), { phase: "stale" });
      assert.deepEqual(Array.from(new BigInt64Array(root.directory)), before, `${phase}: stale writes changed shared directory`);
    }
  } finally { await guest?.close(); }
}

async function broker(): Promise<void> {
  const transport = createWorkerProcessTransport({ pid: 11, job: 31, capacity: 2 });
  const state = workerProcessState(transport);
  const descriptors = new DescriptorTable();
  const notices = new MessageChannel();
  const registry = new ExecutableRegistry();
  registry.register("clone-fixture", { module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), adapter: "preview1" });
  let guest: Guest | undefined;
  let processes: WorkerProcessBroker | undefined;
  const supervisor = new ProcessSupervisor({ registry,
    launch(context) {
      const child = processes!.get(context.pid)!;
      // Generic transports contain directory handles only. Consumers additionally
      // pass their signal cells in workerData, as Node adapters actually do.
      guest = new Guest({ role: "broker", transport: child, cells: serialize({ outcome: context.outcome as outcome.OutcomeCell,
        controls: [context.interrupt, context.requestedSignal, context.signalState] as control.TaggedCells[] }) });
      return { terminate: () => guest!.close() };
    },
    quiesce: () => guest?.close(),
  });
  const client = new WorkerProcessClient({ transport, descriptors, codec, postMessage: message => notices.port1.postMessage(message) });
  let pendingNotice: { resolve(value: WorkerProcessMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const queued: WorkerProcessMessage[] = [];
  notices.port2.on("message", (message: WorkerProcessMessage) => {
    if (pendingNotice) { const waiter = pendingNotice; pendingNotice = undefined; clearTimeout(waiter.timer); waiter.resolve(message); }
    else queued.push(message);
  });
  const nextNotice = (): Promise<WorkerProcessMessage> => queued.length ? Promise.resolve(queued.shift()!) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingNotice = undefined; reject(new Error("broker notice timed out")); }, 3_000);
    pendingNotice = { resolve, reject, timer };
  });
  let stopQuiescent: (() => void) | undefined;
  let quiescentTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
    processes = new WorkerProcessBroker({ supervisor: async () => supervisor, codec });
    processes.adoptRoot(transport);
    const pid = client.spawn(state.pid, { executable: "clone-fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    assert.equal(client.wait(state.pid, pid), null);
    await processes.handle(await nextNotice(), state.pid);
    await supervisor.start(pid);
    assert.ok(guest, "broker must launch a real Node worker");
    assert.deepEqual(await guest.next(), { phase: "live" });
    const childState = workerProcessState(processes.get(pid)!);
    assert.equal(childState.signals.interrupt.load(), 0);
    const safe = new Promise<void>((resolve, reject) => {
      quiescentTimer = setTimeout(() => reject(new Error("broker child did not become quiescent")), 3_000);
      stopQuiescent = supervisor.onProcessQuiescent(event => { if (event.pid === pid) resolve(); });
    });
    guest.post({ command: "exit" });
    const message = await guest.next() as WorkerProcessMessage;
    assert.equal(message.operation, "exit");
    await processes.handle(message, pid);
    await safe;
    clearTimeout(quiescentTimer);
    assert.deepEqual(client.wait(state.pid, pid), exited);
    await processes.handle(await nextNotice(), state.pid);
    assert.deepEqual(client.waitJob(state.pid, childState.job), exited);
    await processes.handle(await nextNotice(), state.pid);
    assert.equal(supervisor.get(pid), undefined);
    assert.equal(processes.get(pid), undefined);
  } finally {
    clearTimeout(quiescentTimer); stopQuiescent?.();
    if (pendingNotice) clearTimeout(pendingNotice.timer);
    processes?.dispose(); supervisor.dispose(); descriptors.dispose();
    notices.port1.close(); notices.port2.close();
    await guest?.close();
  }
}

async function runWorker(): Promise<void> {
  const port = workerData.port as MessagePort;
  const descriptors = new DescriptorTable();
  try {
    if (workerData.role === "no-reply") return;
    if (workerData.role === "instances") {
      const cloned = workerData as { process: outcome.OutcomeCell; job: outcome.OutcomeCell; controls: control.TaggedCells[]; transport: WorkerProcessTransport };
      const state = workerProcessState(cloned.transport);
      for (const cell of [cloned.process, cloned.job]) {
        assert.equal(Object.getPrototypeOf(cell), Object.prototype, "structured clone strips class prototypes");
        assert.ok(cell.validity.buffer instanceof SharedArrayBuffer);
        const revived = new outcome.OutcomeCell(cell.cells, cell.pid, cell.validity);
        assert.equal(outcome.readOutcome(revived), null);
      }
      for (const word of cloned.controls) checkLive({ outcome: new outcome.OutcomeCell(cloned.process.cells, cloned.process.pid, cloned.process.validity),
        controls: [new control.TaggedCells(word.cells, word.id, word.validity)] });
      assert.equal(cloned.job.validity.id, state.job);
      assert.notEqual(cloned.job.validity.id, cloned.job.pid);
      port.postMessage({ phase: "instances", pid: state.pid, job: state.job });
      return;
    }
    const cells = revive(workerData.cells);
    checkLive(cells);
    if (workerData.role === "stale") {
      assert.equal(outcome.startStatus(cells.outcome), 0);
      assert.equal(outcome.markStarted(cells.outcome), true);
    }
    const client = workerData.role === "broker" ? new WorkerProcessClient({ transport: workerData.transport, descriptors, codec, postMessage: message => port.postMessage(message) }) : undefined;
    if (client) {
      assert.equal(cells.outcome.byteOffset, (client.signals.outcome as outcome.OutcomeCell).byteOffset);
      client.installBindings();
    }
    const commands: Command[] = [];
    let waiting: ((command: Command) => void) | undefined;
    port.on("message", (command: Command) => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(command); } else commands.push(command); });
    port.postMessage({ phase: "live" });
    for (;;) {
      const command = commands.shift() ?? await new Promise<Command>(resolve => { waiting = resolve; });
      if (command.command === "exit") { client!.exit(23); return; }
      if (command.command === "terminal") {
        for (const copy of [cells, revive(command)]) {
          assert.equal(outcome.startStatus(copy.outcome), 0);
          assert.deepEqual(outcome.readOutcome(copy.outcome), exited);
          assert.deepEqual(outcome.claimOutcome(copy.outcome, { kind: "signaled", code: 9 }), exited);
          assert.equal(outcome.markStarted(copy.outcome), false);
        }
        port.postMessage({ phase: "terminal" });
        continue;
      }
      // Both the views retained from workerData and newly received MessagePort
      // payloads must keep the original lifecycle guard after collection/reuse.
      checkStale(cells);
      checkStale(revive(command));
      port.postMessage({ phase: "stale" });
    }
  } finally { descriptors.dispose(); port.close(); }
}

if (isMainThread) {
  const mode = process.argv[2];
  if (mode === "instances" || mode === "instances-after-exit") await instances(mode === "instances-after-exit");
  else if (mode === "process" || mode === "job") await stale(mode);
  else if (mode === "broker") await broker();
  else if (mode === "no-reply") await noReply();
  else throw new Error(`unknown fixture mode ${mode}`);
  console.log(`ok ${mode}`);
} else await runWorker();
