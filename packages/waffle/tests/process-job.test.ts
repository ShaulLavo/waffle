import { controlLoad } from "../proc/control.js";
import { expect, test } from "bun:test";
import { ProcessABI } from "../proc/abi.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { DescriptorTable } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import type { SpawnRequest } from "../proc/types.js";

const request = (job = 0): SpawnRequest => ({
  executable: "controlled",
  argv: [],
  env: {},
  cwd: "/",
  job,
  fds: [],
});
function fixture(wait?: (milliseconds: number, word: Int32Array, expected: number) => void) {
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("not launched");
    },
  });
  const descriptors = new DescriptorTable(),
    shell = supervisor.createRoot({ descriptors });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const abi = new ProcessABI({
    memory,
    descriptors,
    fs: new MemFS(),
    pid: shell,
    service: supervisor,
    signals: supervisor.get(shell)!,
    wake,
    wait:
      wait ??
      (() => {
        throw new Error("nonblocking observation slept");
      }),
  });
  const leader = supervisor.reserveSpawn(shell, request());
  const job = supervisor.jobOf(leader),
    child = supervisor.reserveSpawn(leader, request(job));
  const sub = () => {
    const view = new DataView(memory.buffer);
    view.setUint32(256, 4, true);
    view.setUint32(260, job, true);
    view.setBigUint64(264, 77n, true);
  };
  sub();
  return { supervisor, shell, memory, wake, abi, leader, job, child, sub };
}

test("job wait retains the leader outcome after direct reap and waits for descendants' released capabilities", () => {
  const f = fixture();
  try {
    f.supervisor.exit(f.leader, 23);
    f.supervisor.reap(f.shell, f.leader);
    expect(f.abi.imports.wait_job!(f.job, 1, 64)).toBe(-6);
    expect(f.abi.imports.poll!(256, 1, 0, 512)).toBe(0);
    f.supervisor.registerRevocation(f.child, () => {
      expect(f.abi.imports.wait_job!(f.job, 1, 64)).toBe(-6);
      expect(f.abi.imports.poll!(256, 1, 0, 512)).toBe(0);
    });
    f.supervisor.get(f.child)!.descriptors.open(
      {
        kind: "terminal",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: true, writable: false, hangup: true }),
        close() {
          expect(f.abi.imports.wait_job!(f.job, 1, 64)).toBe(-6);
        },
      },
      0n,
      0n,
    );
    f.supervisor.kill(f.child, 9);
    expect(f.abi.imports.poll!(256, 1, 0, 512)).toBe(1);
    expect(f.abi.imports.wait_job!(f.job, 0, 64)).toBe(0);
    expect(new DataView(f.memory.buffer).getInt32(68, true)).toBe(23);
    expect(f.supervisor.get(f.child)).toBeUndefined();
    expect(f.abi.imports.wait_job!(f.job, 1, 64)).toBe(-12);
    expect(f.abi.imports.poll!(256, 1, 0, 512)).toBe(-12);
  } finally {
    f.supervisor.dispose();
  }
});

test("blocking wait captures publication before sleeping and reacquires grown memory", () => {
  let calls = 0;
  const f: ReturnType<typeof fixture> = fixture((_milliseconds, word, expected) => {
    expect(controlLoad(word, 0)).toBe(expected);
    calls++;
    f.memory.grow(1);
    f.supervisor.exit(f.leader, 0);
    f.supervisor.exit(f.child, 42);
    expect(controlLoad(word, 0)).not.toBe(expected);
  });
  try {
    expect(f.abi.imports.wait_job!(f.job, 0, 64)).toBe(0);
    expect(calls).toBe(1);
    expect(new DataView(f.memory.buffer).getInt32(68, true)).toBe(0);
  } finally {
    f.supervisor.dispose();
  }
});

test("job authority follows retained owner ancestors, not unrelated members or siblings", () => {
  const f = fixture();
  try {
    const separate = f.supervisor.reserveSpawn(f.child, request(-1));
    const separateJob = f.supervisor.jobOf(separate);
    expect(f.supervisor.jobEmpty(f.shell, separateJob)).toBe(false);
    expect(() => f.supervisor.jobEmpty(f.leader, f.job)).toThrow("owner chain");
    const sibling = f.supervisor.reserveSpawn(f.shell, request(-1));
    expect(() => f.supervisor.jobEmpty(sibling, separateJob)).toThrow("owner chain");
    f.supervisor.exit(f.child, 0);
    f.supervisor.reap(f.leader, f.child);
    f.supervisor.exit(f.leader, 0);
    f.supervisor.reap(f.shell, f.leader);
    f.supervisor.exit(separate, 4);
    expect(f.supervisor.waitJob(f.shell, separateJob)?.status).toBe(4);
    expect(f.supervisor.waitJob(f.shell, f.job)?.status).toBe(0);
    expect(f.supervisor.get(sibling)!.result).toBeNull();
  } finally {
    f.supervisor.dispose();
  }
});

test("unknown jobs, invalid flags and output faults do not consume completed jobs", () => {
  const f = fixture();
  try {
    expect(f.abi.imports.wait_job!(999999, 1, 64)).toBe(-71);
    expect(f.abi.imports.wait_job!(f.job, 3, 64)).toBe(-28);
    f.supervisor.exit(f.leader, 0);
    f.supervisor.exit(f.child, 0);
    expect(f.abi.imports.wait_job!(f.job, 1, 65535)).toBe(-21);
    expect(f.abi.imports.wait_job!(f.job, 1, 64)).toBe(0);
  } finally {
    f.supervisor.dispose();
  }
});

test("completed jobs cannot be reopened and individual reap preserves job completion", () => {
  const f = fixture();
  try {
    f.supervisor.exit(f.leader, 3);
    f.supervisor.exit(f.child, 0);
    expect(f.supervisor.get(f.child)).toBeUndefined();
    f.supervisor.reap(f.shell, f.leader);
    expect(() => f.supervisor.reserveSpawn(f.shell, request(f.job))).toThrow("completed job");
    expect(f.supervisor.waitJob(f.shell, f.job)?.status).toBe(3);
  } finally {
    f.supervisor.dispose();
  }
});

test("process and job confirmation await filesystem fences before individual reap", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("not launched");
    },
    quiesce: () => pending,
  });
  const shell = supervisor.createRoot(),
    leader = supervisor.reserveSpawn(shell, request());
  const job = supervisor.jobOf(leader),
    wake = new Int32Array(new SharedArrayBuffer(4));
  const unregister = supervisor.registerJobWake(shell, job, wake);
  try {
    let confirmed = false;
    const exit = supervisor.waitForExit(shell, leader).then((result) => {
      confirmed = true;
      return result;
    });
    supervisor.exit(leader, 7);
    expect(supervisor.wait(shell, leader)).toBeNull();
    expect(() => supervisor.reap(shell, leader)).toThrow("has not exited");
    expect(supervisor.jobEmpty(shell, job)).toBe(false);
    expect(controlLoad(wake, 0)).toBe(0);
    await Promise.resolve();
    expect(confirmed).toBe(false);
    release();
    await pending;
    await Promise.resolve();
    expect((await exit).status).toBe(7);
    expect(supervisor.wait(shell, leader)?.status).toBe(7);
    expect(() => supervisor.wait(shell, leader)).toThrow("not a child");
    expect(controlLoad(wake, 0)).toBe(1);
    expect(supervisor.waitJob(shell, job)?.status).toBe(7);
  } finally {
    unregister();
    supervisor.dispose();
  }
});

test("completion racing registration is immediately ready and does not sleep", () => {
  const f = fixture();
  const register = f.supervisor.registerJobWake.bind(f.supervisor);
  f.supervisor.registerJobWake = (caller, job, wake) => {
    f.supervisor.exit(f.leader, 11);
    f.supervisor.exit(f.child, 0);
    return register(caller, job, wake);
  };
  try {
    expect(f.abi.imports.poll!(256, 1, -1, 512)).toBe(1);
    expect(f.abi.imports.wait_job!(f.job, 0, 64)).toBe(0);
    expect(new DataView(f.memory.buffer).getInt32(68, true)).toBe(11);
  } finally {
    f.supervisor.dispose();
  }
});

test("handled signal interrupts blocking job wait without consuming delivery or job", () => {
  const f = fixture();
  try {
    expect(f.abi.imports.signal!(2, 2)).toBe(0);
    f.supervisor.kill(f.shell, 2);
    expect(f.abi.imports.wait_job!(f.job, 0, 64)).toBe(-27);
    expect(f.abi.imports.interrupted!()).toBe(2);
    expect(f.abi.imports.wait_job!(f.job, 1, 64)).toBe(-6);
    f.supervisor.exit(f.leader, 0);
    f.supervisor.exit(f.child, 0);
    expect(f.abi.imports.wait_job!(f.job, 0, 64)).toBe(0);
  } finally {
    f.supervisor.dispose();
  }
});

test("disposal clears job metadata retained after all individual process records were reaped", () => {
  const f = fixture();
  f.supervisor.exit(f.leader, 0);
  f.supervisor.exit(f.child, 0);
  expect(f.supervisor.get(f.child)).toBeUndefined();
  f.supervisor.reap(f.shell, f.leader);
  expect(f.supervisor.job(f.job)).toBeDefined();
  f.supervisor.dispose();
  expect(f.supervisor.job(f.job)).toBeUndefined();
});

test("an accepted independent spawn can arrive after its parent's job was reaped", () => {
  const f = fixture(),
    retained = new DescriptorTable();
  try {
    const source = retained.open(
      {
        kind: "terminal",
        read: () => 0,
        write: (chunks) => chunks.reduce((n, c) => n + c.length, 0),
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      },
      64n,
      0n,
    );
    f.supervisor.exit(f.leader, 0);
    f.supervisor.exit(f.child, 0);
    expect(f.supervisor.waitJob(f.shell, f.job)?.status).toBe(0);
    const accepted = f.supervisor.reserveAdmittedSpawn(
      f.child,
      { ...request(-1), fds: [{ child: 19, parent: source }] },
      { controlParent: f.shell, rootPid: f.shell },
      retained,
    );
    expect(f.supervisor.get(accepted)!.parentPid).toBe(f.child);
    expect(f.supervisor.get(accepted)!.descriptors.get(19)).toBeDefined();
    const independent = f.supervisor.jobOf(accepted);
    f.supervisor.exit(accepted, 4);
    expect(f.supervisor.waitJob(f.shell, independent)?.status).toBe(4);
  } finally {
    retained.dispose();
    f.supervisor.dispose();
  }
});

test("safe exit confirmation does not wait for physical worker termination", async () => {
  const registry = new ExecutableRegistry();
  registry.register("controlled", {
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    adapter: "preview1",
  });
  let releaseFence!: () => void,
    releaseTermination!: () => void,
    terminateCalls = 0;
  const fence = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const terminated = new Promise<void>((resolve) => {
    releaseTermination = resolve;
  });
  const supervisor = new ProcessSupervisor({
    registry,
    quiesce: () => fence,
    launch: () => ({
      terminate() {
        terminateCalls++;
        return terminated;
      },
    }),
  });
  const shell = supervisor.createRoot(),
    leader = supervisor.reserveSpawn(shell, request());
  const job = supervisor.jobOf(leader);
  try {
    await supervisor.start(leader);
    supervisor.kill(leader, 9);
    expect(terminateCalls).toBe(0);
    expect(supervisor.wait(shell, leader)).toBeNull();
    releaseFence();
    await fence;
    await Promise.resolve();
    expect(terminateCalls).toBe(1);
    expect(supervisor.wait(shell, leader)?.status).toBe(137);
    expect(supervisor.waitJob(shell, job)?.status).toBe(137);
  } finally {
    releaseFence();
    releaseTermination();
    supervisor.dispose();
    await terminated;
  }
});

test("a launch resolving during quiescence retains its revoked handle until the fence passes", async () => {
  const registry = new ExecutableRegistry();
  registry.register("controlled", {
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    adapter: "preview1",
  });
  let releaseFence!: () => void, finishLaunch!: (handle: { terminate(): void }) => void;
  let enteredLaunch!: () => void,
    terminated = 0;
  const entered = new Promise<void>((resolve) => {
    enteredLaunch = resolve;
  });
  const fence = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const launching = new Promise<{ terminate(): void }>((resolve) => {
    finishLaunch = resolve;
  });
  const supervisor = new ProcessSupervisor({
    registry,
    quiesce: () => fence,
    launch() {
      enteredLaunch();
      return launching;
    },
  });
  const shell = supervisor.createRoot(),
    leader = supervisor.reserveSpawn(shell, request());
  try {
    const starting = supervisor.start(leader);
    await entered;
    supervisor.kill(leader, 9);
    const handle = {
      terminate() {
        terminated++;
      },
    };
    finishLaunch(handle);
    await starting;
    expect(terminated).toBe(0);
    expect(supervisor.get(leader)!.revoked).toBe(true);
    expect(supervisor.get(leader)!.handle).toBe(handle);
    expect(supervisor.wait(shell, leader)).toBeNull();
    releaseFence();
    await fence;
    await Promise.resolve();
    expect(terminated).toBe(1);
    expect(supervisor.get(leader)!.handle).toBeUndefined();
    expect(supervisor.wait(shell, leader)?.status).toBe(137);
  } finally {
    releaseFence();
    supervisor.dispose();
  }
});

test("Bun-like nested spawns join job_of(0), and shell kill_job/wait_job collect inherited orphans", () => {
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("not launched");
    },
  });
  const shell = supervisor.createRoot(),
    memory = new WebAssembly.Memory({ initial: 1 });
  const abiFor = (pid: number) =>
    new ProcessABI({
      memory,
      descriptors: supervisor.get(pid)!.descriptors,
      fs: new MemFS(),
      pid,
      service: supervisor,
      signals: supervisor.get(pid)!,
    });
  const shellABI = abiFor(shell);
  try {
    const bun = supervisor.reserveSpawn(shell, request(0)),
      bunABI = abiFor(bun);
    const job = bunABI.imports.job_of!(0);
    expect(job).toBe(supervisor.jobOf(bun));
    expect(job).not.toBe(shellABI.imports.job_of!(0));
    const child = supervisor.reserveSpawn(bun, request(job)),
      childABI = abiFor(child);
    expect(childABI.imports.job_of!(0)).toBe(job);
    const grandchild = supervisor.reserveSpawn(child, request(childABI.imports.job_of!(0)));
    const detached = supervisor.reserveSpawn(bun, request(0));
    expect(supervisor.jobOf(detached)).not.toBe(job);
    // The leader may exit and be collected before its descendants. The shell's owner
    // chain and the leader's result must remain available until the whole job is safe.
    supervisor.exit(bun, 7);
    supervisor.reap(shell, bun);
    expect(shellABI.imports.wait_job!(job, 1, 64)).toBe(-6);
    const exits = new Map<number, number | null>();
    const stop = supervisor.onChildExit((event) => {
      exits.set(event.pid, event.result.status);
    });
    expect(shellABI.imports.kill_job!(job, 9)).toBe(0);
    stop();
    expect(exits.get(child)).toBe(137);
    expect(exits.get(grandchild)).toBe(137);
    expect(supervisor.get(child)).toBeUndefined();
    expect(supervisor.get(grandchild)).toBeUndefined();
    expect(supervisor.get(detached)!.result).toBeNull();
    expect(shellABI.imports.wait_job!(job, 1, 64)).toBe(0);
    expect(new DataView(memory.buffer).getInt32(68, true)).toBe(7);
    expect(supervisor.get(child)).toBeUndefined();
    expect(supervisor.get(grandchild)).toBeUndefined();
    expect(supervisor.job(job)).toBeUndefined();
  } finally {
    supervisor.dispose();
  }
});

for (const failed of ["leader", "member"] as const)
  test(`${failed} startup failure keeps the cached leader result and member cleanup fence`, () => {
    const f = fixture();
    try {
      // Both are direct children so their individual typed outcomes remain collectable.
      const member = f.supervisor.reserveSpawn(f.shell, request(f.job));
      f.supervisor.exit(f.child, 0);
      if (failed === "leader") f.supervisor.failStart(f.leader, { code: "ENOENT" });
      else f.supervisor.exit(f.leader, 127);
      expect(f.abi.imports.wait!(f.leader, 64)).toBe(0);
      const view = new DataView(f.memory.buffer);
      expect([view.getUint32(64, true), view.getInt32(68, true)]).toEqual(
        failed === "leader" ? [2, 44] : [0, 127],
      );
      expect(f.abi.imports.wait_job!(f.job, 1, 80)).toBe(-6);
      if (failed === "member") f.supervisor.failStart(member, { code: "EACCES" });
      else f.supervisor.exit(member, 126);
      expect(f.abi.imports.wait!(member, 64)).toBe(0);
      expect([view.getUint32(64, true), view.getInt32(68, true)]).toEqual(
        failed === "member" ? [2, 2] : [0, 126],
      );
      expect(f.abi.imports.wait_job!(f.job, 1, 80)).toBe(0);
      expect([view.getUint32(80, true), view.getInt32(84, true)]).toEqual(
        failed === "leader" ? [2, 44] : [0, 127],
      );
      expect(f.abi.imports.wait_job!(f.job, 1, 80)).toBe(-12);
    } finally {
      f.supervisor.dispose();
    }
  });
