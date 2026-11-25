import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import { MemFS } from "../fs/memory";
import { BrowserProcessBroker, type ProcessFilesystem } from "../browser/process-broker";
import { controlLoad, controlStore } from "../proc/control";
import { confirmDirectoryProcess, directoryState, wakeDirectory } from "../proc/directory";
import { ProcessIdentityAllocator } from "../proc/identity";
import { claimOutcome, readOutcome } from "../proc/outcome";
import { requestSignal, setSignalDisposition, type SignalTransport } from "../proc/signals";
import { ProcessABI } from "../proc/abi";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { ProcessTable } from "../proc/table";
import { ProcessErrno, ProcessError, Signal, checkedSignal } from "../proc/types";
import {
  WorkerProcessClient,
  createWorkerProcessTransport,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client";
import { testReservations } from "./fixtures/shared-memory-platform";

const spawnRequest = (job = 0) => ({
  executable: "fixture",
  argv: [],
  env: {},
  cwd: "/",
  job,
  fds: [],
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
): WorkerProcessTransport {
  const before = messages.length;
  parent.spawn(parent.pid, spawnRequest(job));
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
