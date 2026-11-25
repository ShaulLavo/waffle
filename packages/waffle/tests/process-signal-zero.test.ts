import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import { MemFS } from "../fs/memory";
import { BrowserProcessBroker, type ProcessFilesystem } from "../browser/process-broker";
import { createFilesystemIdentity } from "../fs/protocol";
import { controlLoad, controlStore, packedControl } from "../proc/control";
import {
  confirmDirectoryProcess,
  directoryState,
  findDirectoryJob,
  wakeDirectory,
} from "../proc/directory";
import { ProcessIdentityAllocator } from "../proc/identity";
import { claimOutcome, readOutcome } from "../proc/outcome";
import { requestSignal, setSignalDisposition, type SignalTransport } from "../proc/signals";
import { ProcessABI } from "../proc/abi";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { ProcessTable } from "../proc/table";
import {
  ProcessErrno,
  ProcessError,
  Signal,
  checkedSignal,
  type SpawnRequest,
} from "../proc/types";
import {
  WorkerProcessClient,
  createWorkerProcessTransport,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client";
import { testReservations } from "./fixtures/shared-memory-platform";

const spawnRequest = (job = 0, overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  executable: "fixture",
  argv: [],
  env: {},
  cwd: "/",
  job,
  fds: [],
  ...overrides,
});

const unusedCodec = {
  export() {
    throw new Error("unused");
  },
  import() {
    throw new Error("unused");
  },
  discard() {},
};

function signalSnapshot(signals: SignalTransport) {
  const cells: number[] = [];
  for (let signal = 1; signal <= 64; signal++) cells.push(controlLoad(signals.signalState, signal));
  return {
    interrupt: controlLoad(signals.interrupt, 0),
    requestedSignal: controlLoad(signals.requestedSignal, 0),
    outcome: readOutcome(signals.outcome),
    cells,
  };
}

function createSupervisorFixture() {
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("not launched");
    },
  });
  const fs = new MemFS();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const root = supervisor.createRoot();
  const abiFor = (pid: number) => {
    const record = supervisor.get(pid)!;
    return new ProcessABI({
      processIdentity: record.processIdentity,
      memory,
      descriptors: record.image.descriptors,
      fs,
      pid,
      service: supervisor,
      signals: record,
    });
  };
  return { supervisor, root, abiFor };
}

function createWorkerClient(
  transport: WorkerProcessTransport,
  messages: WorkerProcessMessage[],
  onRevoke: () => void,
) {
  const descriptors = new DescriptorTable();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const fs = new MemFS();
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: unusedCodec,
    postMessage(message) {
      messages.push(message);
    },
    revokeProcess() {
      onRevoke();
    },
  });
  const abi = new ProcessABI({
    processIdentity: client.processIdentity,
    memory,
    descriptors,
    fs,
    pid: client.pid,
    service: client,
    signals: client.signals,
    wake: client.wake,
  });
  return { client, abi, descriptors };
}

function spawnWorkerChild(
  parent: WorkerProcessClient,
  messages: WorkerProcessMessage[],
  job = 0,
  overrides: Partial<SpawnRequest> = {},
): WorkerProcessTransport {
  const before = messages.length;
  parent.spawn(parent.pid, spawnRequest(job, overrides));
  const spawnMessage = messages.slice(before).find((message) => message.operation === "spawn");
  if (!spawnMessage || spawnMessage.operation !== "spawn") {
    throw new Error("expected spawn message");
  }
  return spawnMessage.transport;
}

function expectProcessError(operation: () => unknown, errno: number) {
  try {
    operation();
    throw new Error(`expected ProcessError(${errno})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessError);
    expect((error as ProcessError).errno).toBe(errno);
  }
}

test("supervisor and ABI signal 0 probes self, descendants, non-descendants, zombies, and collected processes with no side effects", () => {
  const f = createSupervisorFixture();
  try {
    const parent = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const sibling = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const child = f.supervisor.reserveSpawn(parent, spawnRequest());
    const rootAbi = f.abiFor(f.root);
    const parentAbi = f.abiFor(parent);
    const siblingAbi = f.abiFor(sibling);
    const childAbi = f.abiFor(child);

    // Arm a handled signal on child and make another handled signal pending so we verify
    // signal 0 touches neither dispositions nor pending bits nor wake hints.
    expect(childAbi.imports.signal!(Signal.SIGINT, 2)).toBe(0);
    expect(childAbi.imports.signal!(Signal.SIGTERM, 2)).toBe(0);
    f.supervisor.kill(child, Signal.SIGINT);
    const childRecord = f.supervisor.get(child)!;
    const beforeChild = signalSnapshot(childRecord);
    const beforeParent = signalSnapshot(f.supervisor.get(parent)!);

    // Self and descendants succeed without changing signal state.
    expect(rootAbi.imports.kill!(f.root, 0)).toBe(0);
    expect(rootAbi.imports.kill!(parent, 0)).toBe(0);
    expect(rootAbi.imports.kill!(child, 0)).toBe(0);
    expect(parentAbi.imports.kill!(child, 0)).toBe(0);
    expect(childAbi.imports.kill!(child, 0)).toBe(0);
    f.supervisor.kill(child, 0);
    expect(signalSnapshot(childRecord)).toEqual(beforeChild);

    // Existing processes outside the caller's ancestry return -EPERM (-63) without side effects.
    expect(childAbi.imports.kill!(parent, 0)).toBe(-63);
    expect(childAbi.imports.kill!(f.root, 0)).toBe(-63);
    expect(childAbi.imports.kill!(sibling, 0)).toBe(-63);
    expect(parentAbi.imports.kill!(sibling, 0)).toBe(-63);
    expect(parentAbi.imports.kill!(f.root, 0)).toBe(-63);
    expect(signalSnapshot(f.supervisor.get(parent)!)).toEqual(beforeParent);
    expect(signalSnapshot(childRecord)).toEqual(beforeChild);

    // Non-existent and invalid PIDs return -ESRCH (-71).
    for (const missing of [0, -1, 99999]) {
      expect(rootAbi.imports.kill!(missing, 0)).toBe(-ProcessErrno.SRCH);
      expect(childAbi.imports.kill!(missing, 0)).toBe(-ProcessErrno.SRCH);
      expectProcessError(() => f.supervisor.kill(missing, 0), ProcessErrno.SRCH);
    }

    // Zombie child (exited, not yet collected): still exists until collected (Linux/FreeBSD/gVisor).
    f.supervisor.exit(child, 0);
    const zombieSnapshot = signalSnapshot(childRecord);
    expect(parentAbi.imports.kill!(child, 0)).toBe(0);
    expect(rootAbi.imports.kill!(child, 0)).toBe(0);
    expect(siblingAbi.imports.kill!(child, 0)).toBe(-63);
    f.supervisor.kill(child, 0);
    expect(signalSnapshot(childRecord)).toEqual(zombieSnapshot);

    // Once collected, the same PID returns -ESRCH (-71) to every caller.
    expect(f.supervisor.wait(parent, child)).toMatchObject({ kind: "exited", code: 0 });
    expect(parentAbi.imports.kill!(child, 0)).toBe(-ProcessErrno.SRCH);
    expect(rootAbi.imports.kill!(child, 0)).toBe(-ProcessErrno.SRCH);
    expect(siblingAbi.imports.kill!(child, 0)).toBe(-ProcessErrno.SRCH);
    expectProcessError(() => f.supervisor.kill(child, 0), ProcessErrno.SRCH);

    // Parent liveness transition: live parent -> EPERM, zombie parent -> EPERM, collected parent -> ESRCH.
    const liveChild = f.supervisor.reserveSpawn(parent, spawnRequest());
    const liveChildAbi = f.abiFor(liveChild);
    expect(liveChildAbi.imports.kill!(parent, 0)).toBe(-63);
    f.supervisor.exit(parent, 0);
    expect(liveChildAbi.imports.kill!(parent, 0)).toBe(-63);
    expect(rootAbi.imports.kill!(parent, 0)).toBe(0);
    expect(f.supervisor.wait(f.root, parent)).toMatchObject({ kind: "exited", code: 0 });
    expect(liveChildAbi.imports.kill!(parent, 0)).toBe(-ProcessErrno.SRCH);
    expect(rootAbi.imports.kill!(parent, 0)).toBe(-ProcessErrno.SRCH);
  } finally {
    f.supervisor.dispose();
  }
});

test("worker client signal 0 probes shared directory without wake, messages, revocation, or signal mutations", () => {
  const messages: WorkerProcessMessage[] = [];
  let revocations = 0;
  const rootTransport = createWorkerProcessTransport();
  const root = createWorkerClient(rootTransport, messages, () => {
    revocations++;
  });
  const parentTransport = spawnWorkerChild(root.client, messages);
  const siblingTransport = spawnWorkerChild(root.client, messages);
  const parent = createWorkerClient(parentTransport, messages, () => {
    revocations++;
  });
  const sibling = createWorkerClient(siblingTransport, messages, () => {
    revocations++;
  });
  const childTransport = spawnWorkerChild(parent.client, messages);
  const child = createWorkerClient(childTransport, messages, () => {
    revocations++;
  });

  try {
    // Advance wake once so we check exact non-increment from a nonzero baseline.
    wakeDirectory(rootTransport.directory);
    setSignalDisposition(child.client.signals.signalState, Signal.SIGINT, 2);
    const beforeMessages = messages.length;
    const beforeWake = Atomics.load(root.client.wake, 0);
    const beforeChild = signalSnapshot(child.client.signals);
    const beforeParent = signalSnapshot(parent.client.signals);

    // Permitted probes succeed with zero side effects.
    expect(root.abi.imports.kill!(root.client.pid, 0)).toBe(0);
    expect(root.abi.imports.kill!(parent.client.pid, 0)).toBe(0);
    expect(root.abi.imports.kill!(child.client.pid, 0)).toBe(0);
    expect(parent.abi.imports.kill!(child.client.pid, 0)).toBe(0);
    expect(child.abi.imports.kill!(child.client.pid, 0)).toBe(0);
    parent.client.kill(child.client.pid, 0);

    // Unpermitted existing processes return -EPERM (-63) with zero side effects.
    expect(child.abi.imports.kill!(parent.client.pid, 0)).toBe(-63);
    expect(child.abi.imports.kill!(root.client.pid, 0)).toBe(-63);
    expect(child.abi.imports.kill!(sibling.client.pid, 0)).toBe(-63);
    expect(parent.abi.imports.kill!(sibling.client.pid, 0)).toBe(-63);
    expectProcessError(() => child.client.kill(parent.client.pid, 0), 63);

    // Non-existent PIDs return -ESRCH (-71).
    expect(child.abi.imports.kill!(99999, 0)).toBe(-ProcessErrno.SRCH);
    expect(root.abi.imports.kill!(0, 0)).toBe(-ProcessErrno.SRCH);
    expectProcessError(() => root.client.kill(99999, 0), ProcessErrno.SRCH);

    expect(messages.length).toBe(beforeMessages);
    expect(revocations).toBe(0);
    expect(Atomics.load(root.client.wake, 0)).toBe(beforeWake);
    expect(signalSnapshot(child.client.signals)).toEqual(beforeChild);
    expect(signalSnapshot(parent.client.signals)).toEqual(beforeParent);

    // Zombie child in shared directory: still exists until wait() collects it.
    claimOutcome(child.client.signals.outcome, { kind: "exited", code: 0 });
    controlStore(directoryState(childTransport).confirmed, 0, 1);
    confirmDirectoryProcess(childTransport);
    const zombieWake = Atomics.load(root.client.wake, 0);
    const zombieMessages = messages.length;
    expect(parent.abi.imports.kill!(child.client.pid, 0)).toBe(0);
    expect(sibling.abi.imports.kill!(child.client.pid, 0)).toBe(-63);
    expect(Atomics.load(root.client.wake, 0)).toBe(zombieWake);
    expect(messages.length).toBe(zombieMessages);

    // Collected child returns -ESRCH (-71).
    expect(parent.client.wait(parent.client.pid, child.client.pid)).toMatchObject({
      kind: "exited",
      code: 0,
    });
    expect(parent.abi.imports.kill!(child.client.pid, 0)).toBe(-ProcessErrno.SRCH);
    expect(sibling.abi.imports.kill!(child.client.pid, 0)).toBe(-ProcessErrno.SRCH);

    // Exited caller itself cannot probe other processes (ESRCH).
    const orphanTransport = spawnWorkerChild(parent.client, messages);
    const orphan = createWorkerClient(orphanTransport, messages, () => {
      revocations++;
    });
    try {
      expect(orphan.abi.imports.kill!(parent.client.pid, 0)).toBe(-63);
      claimOutcome(parent.client.signals.outcome, { kind: "exited", code: 0 });
      controlStore(directoryState(parentTransport).confirmed, 0, 1);
      confirmDirectoryProcess(parentTransport);
      // Exited parent is still a zombie until root collects it.
      expect(orphan.abi.imports.kill!(parent.client.pid, 0)).toBe(-63);
      expect(parent.abi.imports.kill!(root.client.pid, 0)).toBe(-ProcessErrno.SRCH);
      expect(root.client.wait(root.client.pid, parent.client.pid)).toMatchObject({
        kind: "exited",
        code: 0,
      });
      expect(orphan.abi.imports.kill!(parent.client.pid, 0)).toBe(-ProcessErrno.SRCH);
    } finally {
      orphan.descriptors.dispose();
    }
  } finally {
    child.descriptors.dispose();
    sibling.descriptors.dispose();
    parent.descriptors.dispose();
    root.descriptors.dispose();
  }
});

test("kill_job signal 0 probes job existence and ownership without side effects", () => {
  const f = createSupervisorFixture();
  try {
    const child = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const sibling = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const childJob = f.supervisor.jobOf(child);
    const siblingJob = f.supervisor.jobOf(sibling);
    const rootAbi = f.abiFor(f.root);
    const childAbi = f.abiFor(child);
    const before = signalSnapshot(f.supervisor.get(child)!);

    expect(rootAbi.imports.kill_job!(childJob, 0)).toBe(0);
    f.supervisor.killJob(childJob, 0);
    expect(signalSnapshot(f.supervisor.get(child)!)).toEqual(before);

    expect(childAbi.imports.kill_job!(siblingJob, 0)).toBe(-63);
    expect(childAbi.imports.kill_job!(childJob, 0)).toBe(-63);
    expect(rootAbi.imports.kill_job!(99999, 0)).toBe(-ProcessErrno.SRCH);
    expectProcessError(() => f.supervisor.killJob(99999, 0), ProcessErrno.SRCH);
  } finally {
    f.supervisor.dispose();
  }
});

test("signal validation runs before permission checks and non-kill paths still reject signal 0", () => {
  const f = createSupervisorFixture();
  try {
    const child = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const sibling = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const childAbi = f.abiFor(child);

    // Invalid and unsupported signal numbers fail before EPERM/ESRCH.
    for (const invalid of [-1, 32, 33, 65, 1.5]) {
      expect(childAbi.imports.kill!(sibling, invalid)).toBe(-ProcessErrno.INVAL);
      expect(childAbi.imports.kill!(99999, invalid)).toBe(-ProcessErrno.INVAL);
      expect(childAbi.imports.kill_job!(f.supervisor.jobOf(sibling), invalid)).toBe(
        -ProcessErrno.INVAL,
      );
    }
    for (const stop of [19, 20, 21, 22]) {
      expect(childAbi.imports.kill!(sibling, stop)).toBe(-ProcessErrno.NOTSUP);
      expect(childAbi.imports.kill!(99999, stop)).toBe(-ProcessErrno.NOTSUP);
    }

    // Non-kill APIs keep rejecting signal 0.
    expectProcessError(() => checkedSignal(0), ProcessErrno.INVAL);
    expectProcessError(() => requestSignal(f.supervisor.get(f.root)!, 0), ProcessErrno.INVAL);
    expectProcessError(() => f.supervisor.defaultSignal(f.root, 0), ProcessErrno.INVAL);
    expect(childAbi.imports.default_signal!(0)).toBe(-ProcessErrno.INVAL);
    for (const mode of [1, 2, 3]) {
      expect(childAbi.imports.signal!(0, mode)).toBe(-ProcessErrno.INVAL);
    }

    // Non-zero signals retain existing descendant-only rules.
    expect(childAbi.imports.kill!(sibling, Signal.SIGTERM)).toBe(-63);
    expect(childAbi.imports.kill!(f.root, Signal.SIGKILL)).toBe(-63);
  } finally {
    f.supervisor.dispose();
  }
});

test("browser process broker kill(pid, 0) checks existence without waking or signaling", async () => {
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const filesystem: ProcessFilesystem = {
    connect() {
      throw new Error("unused");
    },
    revoke() {},
    reap() {},
    async quiesce() {},
  };
  let launches = 0;
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table,
    registry: new ExecutableRegistry(),
    filesystem,
    launch() {
      launches++;
      throw new Error("should not launch");
    },
  });
  try {
    let wakes = 0;
    const pid = broker.reserveRoot(
      {},
      {
        wake() {
          wakes++;
        },
      },
    );
    const supervisor = await broker.ready();
    const record = supervisor.get(pid)!;
    const before = signalSnapshot(record);
    await expect(broker.kill(pid, 0)).resolves.toBeUndefined();
    expect(signalSnapshot(record)).toEqual(before);
    await expect(broker.killJob(record.job, 0)).resolves.toBeUndefined();
    expect(signalSnapshot(record)).toEqual(before);
    expect(wakes).toBe(0);
    await expect(broker.kill(99999, 0)).rejects.toMatchObject({ errno: ProcessErrno.SRCH });
    await expect(broker.killJob(99999, 0)).rejects.toMatchObject({ errno: ProcessErrno.SRCH });
    expect(wakes).toBe(0);
    expect(launches).toBe(0);
  } finally {
    await broker.dispose();
  }
});

test("worker kill_job(job, 0) never assists sealed collection, never wakes, and isolates foreign roots", () => {
  const identities = new ProcessIdentityAllocator();
  const messagesA: WorkerProcessMessage[] = [];
  const messagesB: WorkerProcessMessage[] = [];
  const rootATransport = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const rootBTransport = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  const rootA = createWorkerClient(rootATransport, messagesA, () => {});
  const rootB = createWorkerClient(rootBTransport, messagesB, () => {});
  const childTransport = spawnWorkerChild(rootA.client, messagesA);
  const childState = directoryState(childTransport);
  const childJob = childState.job;

  try {
    // Live job in another root sharing the identity allocator must answer ESRCH, not ECHILD.
    expect(rootA.abi.imports.kill_job!(rootB.client.job, 0)).toBe(-ProcessErrno.SRCH);
    expectProcessError(() => rootA.client.killJob(rootB.client.job, 0), ProcessErrno.SRCH);

    // Complete child and simulate a paused collector right after its consuming CAS on pending.
    claimOutcome(childState.signals.outcome, { kind: "exited", code: 0 });
    controlStore(childState.confirmed, 0, 1);
    confirmDirectoryProcess(childTransport);
    const group = findDirectoryJob(rootATransport.directory, childJob)!;
    const rawPending = new BigInt64Array(group.pending.buffer, group.pending.byteOffset, 1);
    expect(
      Atomics.compareExchange(
        rawPending,
        0,
        packedControl(childJob, 0),
        packedControl(childJob, -1),
      ),
    ).toBe(packedControl(childJob, 0));

    const wakeBefore = Atomics.load(rootA.client.wake, 0);
    // Probing an unrelated missing job or the sealed job must return ESRCH without finishing
    // the sealed job or advancing the directory wake word.
    expect(rootA.abi.imports.kill_job!(99999, 0)).toBe(-ProcessErrno.SRCH);
    expect(rootA.abi.imports.kill_job!(childJob, 0)).toBe(-ProcessErrno.SRCH);
    expect(Atomics.load(rootA.client.wake, 0)).toBe(wakeBefore);
    // Sealed row stays unfinalized until a real wait lookup assists it.
    expect(Atomics.load(rawPending, 0)).toBe(packedControl(childJob, -1));
    // Wait lookup still preserves its ECHILD contract and collection assistance.
    expect(rootA.abi.imports.wait_job!(childJob, 1, 64)).toBe(-ProcessErrno.CHILD);
    expect(Atomics.load(rootA.client.wake, 0)).toBeGreaterThan(wakeBefore);
    // Collected job continues to answer ESRCH to signal 0 probes.
    expect(rootA.abi.imports.kill_job!(childJob, 0)).toBe(-ProcessErrno.SRCH);
  } finally {
    rootB.descriptors.dispose();
    rootA.descriptors.dispose();
  }
});

test("signal 0 probes racing with caller exit do not retire pending executable access requests", () => {
  const messages: WorkerProcessMessage[] = [];
  const rootTransport = createWorkerProcessTransport();
  const root = createWorkerClient(rootTransport, messages, () => {});
  try {
    const requestId = root.client.accessStart(root.client.pid, "/bin/fixture", "/");
    expect(requestId).toBeGreaterThan(0);
    const accessMsg = messages.find((message) => message.operation === "access");
    if (!accessMsg || accessMsg.operation !== "access") throw new Error("expected access message");
    const completion = new Int32Array(accessMsg.request.completion);
    expect(Atomics.load(completion, 0)).toBe(0);

    // Select caller exit without running teardown yet.
    claimOutcome(root.client.signals.outcome, { kind: "exited", code: 0 });
    expect(root.abi.imports.kill!(root.client.pid, 0)).toBe(-ProcessErrno.SRCH);
    expect(root.abi.imports.kill_job!(root.client.job, 0)).toBe(-ProcessErrno.SRCH);
    expect(root.abi.imports.probe_process!(root.client.processIdentity.pid)).toBe(
      -ProcessErrno.SRCH,
    );
    // Access completion word must remain pending (0), not retired (2).
    expect(Atomics.load(completion, 0)).toBe(0);
  } finally {
    root.descriptors.dispose();
  }

  // Supervisor-backed path: selecting the caller's exit outcome makes probes return ESRCH
  // without mutating outcome, revoking the caller, or waking/retiring pending access queries,
  // while a live caller still observes same-root zombies as existing.
  const f = createSupervisorFixture();
  try {
    const child = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const sibling = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const rootAbi = f.abiFor(f.root);
    const childAbi = f.abiFor(child);
    const siblingAbi = f.abiFor(sibling);

    // Exited child zombie: live root sees 0, live sibling sees EPERM, exited child sees ESRCH.
    f.supervisor.exit(child, 0);
    expect(rootAbi.imports.kill!(child, 0)).toBe(0);
    expect(rootAbi.imports.probe_process!(child)).toBe(0);
    expect(siblingAbi.imports.probe_process!(child)).toBe(-ProcessErrno.PERM);
    expect(childAbi.imports.kill!(child, 0)).toBe(-ProcessErrno.SRCH);
    expect(childAbi.imports.kill_job!(f.supervisor.jobOf(child), 0)).toBe(-ProcessErrno.SRCH);
    expect(childAbi.imports.probe_process!(child)).toBe(-ProcessErrno.SRCH);

    // Select caller exit outcome without running teardown yet; pending access stays untouched.
    const accessWake = new Int32Array(new SharedArrayBuffer(4));
    const accessId = f.supervisor.accessStart(f.root, "/bin/fixture", "/", accessWake);
    expect(accessId).toBeGreaterThan(0);
    const rootRecord = f.supervisor.get(f.root)!;
    claimOutcome(rootRecord.outcome, { kind: "exited", code: 0 });
    expect(rootAbi.imports.kill!(f.root, 0)).toBe(-ProcessErrno.SRCH);
    expect(rootAbi.imports.kill_job!(f.supervisor.jobOf(f.root), 0)).toBe(-ProcessErrno.SRCH);
    expect(rootAbi.imports.probe_process!(f.root)).toBe(-ProcessErrno.SRCH);
    expect(readOutcome(rootRecord.outcome)).toMatchObject({ kind: "exited", code: 0 });
    expect(rootRecord.result).toBeNull();
    expect(rootRecord.revoked).toBe(false);
    expect(Atomics.load(accessWake, 0)).toBe(0);
  } finally {
    f.supervisor.dispose();
  }
});

function createBrokerFixture(onActivate?: () => void) {
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const filesystem: ProcessFilesystem = {
    connect() {
      throw new Error("unused");
    },
    revoke() {},
    reap() {},
    async quiesce() {},
  };
  const registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    interruptible: true,
  });
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table,
    registry,
    filesystem,
    ...(onActivate
      ? {
          activate: async () => {
            onActivate();
            return await import("../proc/index.js");
          },
        }
      : {}),
    launch() {
      return { terminate() {} };
    },
  });
  return { identities, table, broker };
}

test("broker signal 0 probes use authoritative directory state and never lazily activate on a cold miss", async () => {
  let activations = 0;
  const { identities, table, broker } = createBrokerFixture(() => {
    activations++;
  });
  try {
    // Cold miss must reject with ESRCH directly without activating the supervisor.
    await expect(broker.kill(99999, 0)).rejects.toMatchObject({ errno: ProcessErrno.SRCH });
    await expect(broker.killJob(99999, 0)).rejects.toMatchObject({ errno: ProcessErrno.SRCH });
    expect(activations).toBe(0);

    // Adopt a directory-backed root and spawn a child, then activate and admit it into table.
    const rootTransport = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    rootTransport.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(rootTransport, { memory: [] });
    expect(activations).toBe(0);

    // Still cold: probe root succeeds, cold miss still does not activate.
    await expect(broker.kill(rootTransport.pid, 0)).resolves.toBeUndefined();
    await expect(broker.killJob(directoryState(rootTransport).job, 0)).resolves.toBeUndefined();
    await expect(broker.kill(99999, 0)).rejects.toMatchObject({ errno: ProcessErrno.SRCH });
    await expect(broker.killJob(99999, 0)).rejects.toMatchObject({ errno: ProcessErrno.SRCH });
    expect(activations).toBe(0);

    // Now activate supervisor and admit a worker child into the page table.
    const messages: WorkerProcessMessage[] = [];
    const rootClient = createWorkerClient(rootTransport, messages, () => {});
    try {
      const childTransport = spawnWorkerChild(rootClient.client, messages);
      childTransport.data = { filesystem: createFilesystemIdentity() };
      const spawnMsg = messages.find((m) => m.operation === "spawn")!;
      await broker.runtimeMessage(spawnMsg, rootTransport.pid);
      const supervisor = await broker.ready();
      const childState = directoryState(childTransport);
      expect(table.get(childState.pid)).toBeDefined();
      expect(table.job(childState.job)).toBeDefined();
      const rootRecord = supervisor.get(rootTransport.pid)!;
      const rootSupervisorAbi = new ProcessABI({
        processIdentity: rootRecord.processIdentity,
        memory: new WebAssembly.Memory({ initial: 1 }),
        descriptors: rootRecord.image.descriptors,
        fs: new MemFS(),
        pid: rootRecord.pid,
        service: supervisor,
        signals: rootRecord,
      });

      // Complete child through supervisor: while uncollected zombie, supervisor ABI sees 0.
      const completion = supervisor.waitForExit(rootClient.client.pid, childState.pid);
      supervisor.exit(childState.pid, 0);
      await completion;
      expect(rootSupervisorAbi.imports.kill!(childState.pid, 0)).toBe(0);
      expect(rootSupervisorAbi.imports.probe_process!(childState.pid)).toBe(0);
      expect(rootSupervisorAbi.imports.kill_job!(childState.job, 0)).toBe(0);

      // Simulate a sealed job (consuming CAS on pending) before finalization: supervisor ABI
      // must return ESRCH without finalizing the sealed row or advancing the wake word.
      const sealedChild = spawnWorkerChild(rootClient.client, messages);
      sealedChild.data = { filesystem: createFilesystemIdentity() };
      await broker.runtimeMessage(messages.at(-1)!, rootTransport.pid);
      const sealedState = directoryState(sealedChild);
      const sealedCompletion = supervisor.waitForExit(rootClient.client.pid, sealedState.pid);
      supervisor.exit(sealedState.pid, 0);
      await sealedCompletion;
      const sealedGroup = findDirectoryJob(rootTransport.directory, sealedState.job)!;
      const sealedPending = new BigInt64Array(
        sealedGroup.pending.buffer,
        sealedGroup.pending.byteOffset,
        1,
      );
      expect(
        Atomics.compareExchange(
          sealedPending,
          0,
          packedControl(sealedState.job, 0),
          packedControl(sealedState.job, -1),
        ),
      ).toBe(packedControl(sealedState.job, 0));
      const wakeBeforeSealed = Atomics.load(rootClient.client.wake, 0);
      expect(rootSupervisorAbi.imports.kill!(sealedState.pid, 0)).toBe(-ProcessErrno.SRCH);
      expect(rootSupervisorAbi.imports.probe_process!(sealedState.pid)).toBe(-ProcessErrno.SRCH);
      expect(rootSupervisorAbi.imports.kill_job!(sealedState.job, 0)).toBe(-ProcessErrno.SRCH);
      expect(Atomics.load(rootClient.client.wake, 0)).toBe(wakeBeforeSealed);
      expect(Atomics.load(sealedPending, 0)).toBe(packedControl(sealedState.job, -1));

      // Collect the first job locally in the worker while holding back its reap-job notice.
      expect(rootClient.client.waitJob(rootClient.client.pid, childState.job)).toMatchObject({
        kind: "exited",
        code: 0,
      });

      // Page table still holds the stale child and job until the reap notice is delivered.
      expect(table.get(childState.pid)).toBeDefined();
      expect(table.job(childState.job)).toBeDefined();
      // Both broker and supervisor-backed ABI probes must consult the authoritative directory.
      await expect(broker.kill(childState.pid, 0)).rejects.toMatchObject({
        errno: ProcessErrno.SRCH,
      });
      await expect(broker.killJob(childState.job, 0)).rejects.toMatchObject({
        errno: ProcessErrno.SRCH,
      });
      expect(rootSupervisorAbi.imports.kill!(childState.pid, 0)).toBe(-ProcessErrno.SRCH);
      expect(rootSupervisorAbi.imports.probe_process!(childState.pid)).toBe(-ProcessErrno.SRCH);
      expect(rootSupervisorAbi.imports.kill_job!(childState.job, 0)).toBe(-ProcessErrno.SRCH);
      expectProcessError(() => supervisor.kill(childState.pid, 0), ProcessErrno.SRCH);
      expectProcessError(() => supervisor.killJob(childState.job, 0), ProcessErrno.SRCH);
    } finally {
      rootClient.descriptors.dispose();
    }
  } finally {
    await broker.dispose();
  }
});

test("runtime_proc.probe_process resolves logical PIDs without exposing private thread execution handles", () => {
  const f = createSupervisorFixture();
  try {
    const thread = f.supervisor.reserveSpawn(f.root, spawnRequest(-1, { processKind: "thread" }));
    const child = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const childThread = f.supervisor.reserveSpawn(
      child,
      spawnRequest(-1, { processKind: "thread" }),
    );
    const sibling = f.supervisor.reserveSpawn(f.root, spawnRequest());
    const rootAbi = f.abiFor(f.root);
    const threadAbi = f.abiFor(thread);
    const childAbi = f.abiFor(child);
    const siblingAbi = f.abiFor(sibling);

    // Logical PID 1 (root + thread) succeeds for root and thread, EPERM for child.
    expect(rootAbi.imports.probe_process!(f.root)).toBe(0);
    expect(threadAbi.imports.probe_process!(f.root)).toBe(0);
    expect(childAbi.imports.probe_process!(f.root)).toBe(-ProcessErrno.PERM);
    // Private thread execution handles are NOT logical PIDs: probe_process answers ESRCH,
    // while raw execution-handle kill(handle, 0) keeps its execution-handle contract.
    expect(rootAbi.imports.probe_process!(thread)).toBe(-ProcessErrno.SRCH);
    expect(threadAbi.imports.probe_process!(thread)).toBe(-ProcessErrno.SRCH);
    expect(rootAbi.imports.probe_process!(childThread)).toBe(-ProcessErrno.SRCH);
    expect(rootAbi.imports.kill!(thread, 0)).toBe(0);
    expect(rootAbi.imports.kill!(childThread, 0)).toBe(0);

    // Child's logical PID stays alive while its thread survives leader collection.
    const childJob = f.supervisor.jobOf(child);
    expect(rootAbi.imports.probe_process!(child)).toBe(0);
    expect(siblingAbi.imports.probe_process!(child)).toBe(-ProcessErrno.PERM);
    f.supervisor.exit(child, 0);
    expect(f.supervisor.wait(f.root, child)).toMatchObject({ kind: "exited", code: 0 });
    expect(rootAbi.imports.probe_process!(child)).toBe(0);
    expect(siblingAbi.imports.probe_process!(child)).toBe(-ProcessErrno.PERM);
    f.supervisor.exit(childThread, 0);
    expect(f.supervisor.waitJob(f.root, childJob)).toMatchObject({ kind: "exited", code: 0 });
    expect(rootAbi.imports.probe_process!(child)).toBe(-ProcessErrno.SRCH);
    expect(siblingAbi.imports.probe_process!(child)).toBe(-ProcessErrno.SRCH);
  } finally {
    f.supervisor.dispose();
  }

  // Same logical-PID probe contract in shared worker directory.
  const messages: WorkerProcessMessage[] = [];
  const rootTransport = createWorkerProcessTransport();
  const root = createWorkerClient(rootTransport, messages, () => {});
  const threadTransport = spawnWorkerChild(root.client, messages, -1, { processKind: "thread" });
  const childTransport = spawnWorkerChild(root.client, messages);
  const thread = createWorkerClient(threadTransport, messages, () => {});
  const child = createWorkerClient(childTransport, messages, () => {});
  try {
    const beforeWake = Atomics.load(root.client.wake, 0);
    const beforeMessages = messages.length;
    expect(root.abi.imports.probe_process!(root.client.processIdentity.pid)).toBe(0);
    expect(thread.abi.imports.probe_process!(root.client.processIdentity.pid)).toBe(0);
    expect(child.abi.imports.probe_process!(root.client.processIdentity.pid)).toBe(
      -ProcessErrno.PERM,
    );
    expect(root.abi.imports.probe_process!(thread.client.pid)).toBe(-ProcessErrno.SRCH);
    expect(root.abi.imports.kill!(thread.client.pid, 0)).toBe(0);
    expect(root.abi.imports.probe_process!(child.client.processIdentity.pid)).toBe(0);
    expect(root.abi.imports.probe_process!(99999)).toBe(-ProcessErrno.SRCH);
    expect(Atomics.load(root.client.wake, 0)).toBe(beforeWake);
    expect(messages.length).toBe(beforeMessages);
  } finally {
    child.descriptors.dispose();
    thread.descriptors.dispose();
    root.descriptors.dispose();
  }
});

test("supervisor signal 0 probes isolate foreign roots sharing one ProcessTable", () => {
  const f = createSupervisorFixture();
  try {
    const rootA = f.root;
    const rootB = f.supervisor.createRoot();
    const foreignChild = f.supervisor.reserveSpawn(rootB, spawnRequest());
    const foreignThread = f.supervisor.reserveSpawn(
      foreignChild,
      spawnRequest(-1, { processKind: "thread" }),
    );
    const foreignSibling = f.supervisor.reserveSpawn(rootB, spawnRequest());
    const foreignJob = f.supervisor.jobOf(foreignChild);
    const rootBJob = f.supervisor.jobOf(rootB);

    const abiA = f.abiFor(rootA);
    const abiB = f.abiFor(rootB);
    const abiForeignSibling = f.abiFor(foreignSibling);

    // Every process and job in rootB is invisible (ESRCH, never EPERM) from rootA.
    expect(abiA.imports.kill!(rootB, 0)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.kill!(foreignChild, 0)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.kill!(foreignThread, 0)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.probe_process!(rootB)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.probe_process!(foreignChild)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.kill_job!(rootBJob, 0)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.kill_job!(foreignJob, 0)).toBe(-ProcessErrno.SRCH);

    // Reap foreignChild while foreignThread stays alive: rootA still sees ESRCH for all probes,
    // while rootB sees 0 and foreignSibling sees EPERM for same-root targets.
    f.supervisor.exit(foreignChild, 0);
    expect(f.supervisor.wait(rootB, foreignChild)).toMatchObject({ kind: "exited", code: 0 });
    expect(abiA.imports.kill!(foreignChild, 0)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.probe_process!(foreignChild)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.kill!(foreignThread, 0)).toBe(-ProcessErrno.SRCH);
    expect(abiA.imports.kill_job!(foreignJob, 0)).toBe(-ProcessErrno.SRCH);

    expect(abiB.imports.probe_process!(foreignChild)).toBe(0);
    expect(abiB.imports.kill!(foreignThread, 0)).toBe(0);
    expect(abiB.imports.kill_job!(foreignJob, 0)).toBe(0);
    expect(abiForeignSibling.imports.probe_process!(foreignChild)).toBe(-ProcessErrno.PERM);
    expect(abiForeignSibling.imports.kill_job!(foreignJob, 0)).toBe(-ProcessErrno.PERM);
  } finally {
    f.supervisor.dispose();
  }
});

test("nonzero supervisor signals keep table authority for transferred jobs and standalone children under directory-backed roots", async () => {
  const { identities, table, broker } = createBrokerFixture();
  const rootTransport = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  rootTransport.data = { filesystem: createFilesystemIdentity() };
  const messages: WorkerProcessMessage[] = [];
  const rootClient = createWorkerClient(rootTransport, messages, () => {});
  let parentClient: ReturnType<typeof createWorkerClient> | undefined;
  try {
    await broker.adoptRuntimeRoot(rootTransport, { memory: [] });

    // Case 1: directory-backed tree where parent exits (uncollected) and supervisor transfers
    // grandchild's independent job to grandparent while directory still names the exited parent.
    const parentTransport = spawnWorkerChild(rootClient.client, messages);
    parentTransport.data = { filesystem: createFilesystemIdentity() };
    await broker.runtimeMessage(messages.at(-1)!, rootTransport.pid);
    parentClient = createWorkerClient(parentTransport, messages, () => {});
    const grandTransport = spawnWorkerChild(parentClient.client, messages);
    grandTransport.data = { filesystem: createFilesystemIdentity() };
    await broker.runtimeMessage(messages.at(-1)!, parentTransport.pid);

    const supervisor = await broker.ready();
    const grandJob = directoryState(grandTransport).job;
    const rootRecord = supervisor.get(rootTransport.pid)!;
    const rootAbi = new ProcessABI({
      processIdentity: rootRecord.processIdentity,
      memory: new WebAssembly.Memory({ initial: 1 }),
      descriptors: rootRecord.image.descriptors,
      fs: new MemFS(),
      pid: rootRecord.pid,
      service: supervisor,
      signals: rootRecord,
    });

    // Parent exits without being collected; supervisor transfers grandJob ownership to root.
    const parentDone = supervisor.waitForExit(rootTransport.pid, parentTransport.pid);
    supervisor.exit(parentTransport.pid, 0);
    await parentDone;
    expect(table.job(grandJob)?.controlParent).toBe(rootTransport.pid);
    expect(rootAbi.imports.kill_job!(grandJob, 0)).toBe(0);
    expect(rootAbi.imports.kill_job!(grandJob, Signal.SIGINT)).toBe(0);

    // Case 2: standalone supervisor-created child under a directory-backed root.
    const standalone = supervisor.reserveSpawn(rootTransport.pid, spawnRequest());
    const standaloneJob = supervisor.jobOf(standalone);
    expect(rootAbi.imports.kill!(standalone, 0)).toBe(0);
    expect(rootAbi.imports.probe_process!(standalone)).toBe(0);
    expect(rootAbi.imports.kill_job!(standaloneJob, 0)).toBe(0);
    expect(rootAbi.imports.kill!(standalone, Signal.SIGINT)).toBe(0);

    const standaloneForJob = supervisor.reserveSpawn(rootTransport.pid, spawnRequest());
    const standaloneForJobId = supervisor.jobOf(standaloneForJob);
    expect(rootAbi.imports.kill_job!(standaloneForJobId, Signal.SIGINT)).toBe(0);
  } finally {
    parentClient?.descriptors.dispose();
    rootClient.descriptors.dispose();
    await broker.dispose();
  }
});
