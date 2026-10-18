import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libc = dlopen("libc.so.6", {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  pidfd_send_signal: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

function parentOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return -1;
  }
}
function taskChildren(tid: string): string {
  try {
    return readFileSync(`/proc/self/task/${tid}/children`, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}
function children(): number[] {
  const pids = new Set<number>();
  for (const tid of readdirSync("/proc/self/task")) {
    const text = taskChildren(tid);
    for (const pid of text.split(/\s+/).filter(Boolean)) pids.add(Number(pid));
  }
  return Array.from(pids);
}
function killAdopted(pid: number): void {
  const fd = libc.symbols.pidfd_open(pid, 0);
  if (fd < 0) return;
  try {
    // A pidfd prevents PID reuse from turning cleanup into an unrelated-process kill.
    if (parentOf(pid) === process.pid) libc.symbols.pidfd_send_signal(fd, 9, null, 0);
  } finally {
    libc.symbols.close(fd);
  }
}
async function retireChildren(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (true) {
    while (libc.symbols.waitpid(-1, null, 1) > 0) {
      /* Reap adopted children only after the suite is reaped. */
    }
    const owned = children();
    if (!owned.length) return;
    for (const pid of owned) killAdopted(pid);
    if (Date.now() >= deadline) throw Error(`Browser descendants remain: ${owned.join(", ")}`);
    await Bun.sleep(10);
  }
}
function signalSuite(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

/** Subreaping catches even detached grandchildren whose parent exits before our first poll. */
export async function supervise(command: string[], graceMs = 65_000): Promise<number> {
  if (!command.length) throw Error("Missing browser suite command");
  if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0)
    throw Error("Cannot own detached browser descendants");
  let stopAt: number | undefined;
  const stop = () => {
    stopAt ??= Date.now();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const root = process.env.STORAGE_SCRATCH_ROOT ?? tmpdir();
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, "wb-"));
  const shm = mkdtempSync("/dev/shm/wb-");
  let retired = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    const child = Bun.spawn(command, {
      env: {
        ...process.env,
        TMPDIR: scratch,
        STORAGE_SCRATCH_ROOT: scratch,
        PROCESS_SCRATCH_ROOT: scratch,
        WAFFLE_BROWSER_SHM_ROOT: shm,
      },
      detached: true,
      stdout: "inherit",
      stderr: "inherit",
    });
    const suite = child;
    const deadline = Date.now() + Number(process.env.WAFFLE_BROWSER_TIMEOUT ?? 600_000);
    let forwarded = false;
    poll = setInterval(() => {
      if (
        parentOf(process.pid) !== Number(process.env.WAFFLE_BROWSER_PARENT ?? process.ppid) ||
        Date.now() >= deadline
      )
        stop();
      if (stopAt === undefined) return;
      if (!forwarded) {
        forwarded = true;
        signalSuite(suite.pid, "SIGTERM");
      }
      if (Date.now() - stopAt >= graceMs) signalSuite(suite.pid, "SIGKILL");
    }, 20);
    const code = await child.exited;
    clearInterval(poll);
    await retireChildren();
    retired = true;
    return stopAt === undefined ? code : 1;
  } finally {
    if (poll) clearInterval(poll);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (retired) {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(shm, { recursive: true, force: true });
    } else console.error(`Retained browser scratch until descendants retire: ${scratch}, ${shm}`);
  }
}

if (import.meta.main) process.exitCode = await supervise(process.argv.slice(2));
