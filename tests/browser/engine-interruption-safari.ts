import { createServer } from "node:net";

export interface SafariDriverIdentity { pid: number; exitCode: number | null; signalCode: string | number | null; }
export interface SafariProcessIdentity { pid: number; ppid: number; group: number; started: number; }
export interface SafariDriverOwnership {
  driver: SafariDriverIdentity;
  spawnedAfter: number;
  root?: SafariProcessIdentity;
  allocatedPort?: number;
  associated?: SafariProcessIdentity;
  confirmed: boolean;
  observed: Map<number, SafariProcessIdentity>;
  verified: Map<number, SafariProcessIdentity>;
}
export interface SafariInspection {
  listeners(port: number, deadline?: number): Promise<number[]>;
  processes(deadline?: number): Promise<SafariProcessIdentity[]>;
  executable?(pid: number, deadline?: number): Promise<string | undefined>;
}

export function ownSafariDriver(driver: SafariDriverIdentity, spawnedAfter: number, allocatedPort?: number): SafariDriverOwnership {
  // ps lstart has one-second precision. A child spawned in that second is valid.
  return { driver, spawnedAfter: Math.floor(spawnedAfter / 1_000) * 1_000, allocatedPort, confirmed: false, observed: new Map(), verified: new Map() };
}

// Reserve a private random port until the child is about to bind. As in step9,
// preflight excludes already occupied ports but cannot close the release/bind
// race. Apple's launchd listener attribution is diagnostic, not session admission.
export async function allocateSafariDriverPort(requested = 0): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: requested, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Safari driver port allocation failed");
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export function assertSafariDriverAlive(driver: SafariDriverIdentity): void {
  if (driver.exitCode !== null || driver.signalCode !== null) throw new Error(`owned Safari driver ${driver.pid} exited (${driver.exitCode ?? driver.signalCode})`);
}

async function inspectCommand(args: string[], allowEmpty = false, deadline = Infinity): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Safari ownership inspection exceeded shutdown deadline");
  const command = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: Math.min(2_000, remaining), killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } });
  const stdout = new Response(command.stdout).text(), stderr = new Response(command.stderr).text();
  const status = await command.exited;
  const output = (await stdout).trim(), errors = (await stderr).trim();
  if (status !== 0 && !(allowEmpty && status === 1 && !output && !errors)) throw new Error(`Safari ownership inspection failed (${status}): ${errors}`);
  return output;
}

async function listenerPids(port: number, deadline?: number): Promise<number[]> {
  const output = await inspectCommand([process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], true, deadline);
  if (!output) return [];
  const pids = output.split(/\s+/).map(Number);
  if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error("invalid Safari listener process identity");
  return Array.from(new Set(pids));
}

async function processIdentities(deadline?: number): Promise<SafariProcessIdentity[]> {
  return parseSafariProcessTable(await inspectCommand(["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart="], false, deadline));
}

export function parseSafariProcessTable(output: string): SafariProcessIdentity[] {
  return output.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error(`invalid Safari process identity: ${line}`);
    const started = Date.parse(match[4]!);
    if (!Number.isFinite(started)) throw new Error(`invalid Safari process start time: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), started };
  });
}
const appleHttpService = "/System/Library/PrivateFrameworks/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService";

async function executablePath(pid: number, deadline = Infinity): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  if (Date.now() >= deadline) throw new Error("Safari executable inspection exceeded shutdown deadline");
  // ps comm/command comes from argv[0], not the kernel's executable path.
  // Public libproc gives the latter; no private responsibility APIs or grants.
  const { dlopen, ptr } = await import("bun:ffi");
  if (Date.now() >= deadline) throw new Error("Safari executable inspection exceeded shutdown deadline");
  const library = dlopen("/usr/lib/libproc.dylib", { proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" } });
  try {
    const buffer = new Uint8Array(4_096);
    const count = library.symbols.proc_pidpath(pid, ptr(buffer), buffer.byteLength);
    if (Date.now() >= deadline) throw new Error("Safari executable inspection exceeded shutdown deadline");
    if (count <= 0) return undefined;
    const end = buffer.indexOf(0);
    return new TextDecoder().decode(end < 0 ? buffer : buffer.subarray(0, end));
  } finally { library.close(); }
}

const inspection: SafariInspection = { listeners: listenerPids, processes: processIdentities, executable: executablePath };

function sameProcess(left: SafariProcessIdentity, right: SafariProcessIdentity): boolean {
  // Process groups can change during a process's lifetime. They constrain initial
  // adoption, but cannot make a verified or observed process disappear at exit.
  return left.pid === right.pid && left.started === right.started;
}

function rememberTree(owned: SafariDriverOwnership, processes: readonly SafariProcessIdentity[]): Map<number, SafariProcessIdentity> {
  const root = processes.find(row => row.pid === owned.driver.pid);
  const tree = new Map<number, SafariProcessIdentity>();
  if (!root) return tree;
  if (root.started < owned.spawnedAfter || owned.root && !sameProcess(owned.root, root)) throw new Error("owned Safari driver process identity changed");
  owned.root ??= root;
  tree.set(root.pid, root);
  // Follow parents, not merely matching process groups. Unlike Darwin's redacted
  // ps sess pointer, pgid identifies a real group; siblings are still not ours.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of processes) {
      const parent = tree.get(row.ppid), verified = owned.verified.get(row.pid);
      const knownLifetime = verified !== undefined && sameProcess(verified, row);
      if (!tree.has(row.pid) && parent && (row.group === root.group || knownLifetime)
        && row.started >= owned.spawnedAfter && row.started >= parent.started) {
        tree.set(row.pid, row); changed = true;
      }
    }
  }
  for (const row of tree.values()) owned.verified.set(row.pid, row);
  return tree;
}

export async function assertSafariDriverOwnership(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection, deadline?: number): Promise<void> {
  assertSafariDriverAlive(owned.driver);
  const pids = await inspect.listeners(port, deadline);
  const rows = await inspect.processes(deadline);
  const tree = rememberTree(owned, rows);
  let accepted = pids.length > 0 && pids.every(pid => tree.has(pid));
  const root = tree.get(owned.driver.pid);
  if (!accepted && pids.length === 1 && owned.allocatedPort === port && root) {
    const candidate = rows.find(row => row.pid === pids[0]);
    // Real Safari launches HTTPService through launchd (PPID 1, separate group),
    // not as our child. Only associate this exact system executable on the free
    // port we allocated and passed to our live driver; never claim its ownership.
    if (candidate && candidate.ppid === 1 && candidate.started >= owned.spawnedAfter && candidate.started >= root.started
      && (!owned.associated || sameProcess(owned.associated, candidate))) {
      // A failed asynchronous inspection must not erase a possible consumer.
      // Observed candidates are never owned or signalled; only watched at exit.
      if (!owned.associated) owned.observed.set(candidate.pid, candidate);
      if (await inspect.executable?.(candidate.pid, deadline) === appleHttpService) {
        const confirmedRows = await inspect.processes(deadline);
        const confirmedTree = rememberTree(owned, confirmedRows);
        const confirmed = confirmedRows.find(row => row.pid === candidate.pid);
        const confirmedListeners = await inspect.listeners(port, deadline);
        if (confirmedTree.has(owned.driver.pid) && confirmed?.ppid === 1 && sameProcess(candidate, confirmed)
          && confirmedListeners.length === 1 && confirmedListeners[0] === candidate.pid) {
          owned.associated = confirmed;
          owned.observed.delete(candidate.pid);
          accepted = true;
        }
      }
    }
  }
  assertSafariDriverAlive(owned.driver);
  if (!accepted) {
    // Preserve the initial ownership snapshot: teardown may remove these processes
    // before the coordinator can inspect them. Never dump unrelated host rows.
    const identity = { spawnedAfter: owned.spawnedAfter, allocatedPort: owned.allocatedPort ?? null,
      root: root ?? null, associated: owned.associated ?? null,
      listeners: pids.map(pid => ({ pid, process: rows.find(row => row.pid === pid) ?? null, owned: tree.has(pid) })) };
    throw new Error(`Safari driver port ${port} not owned or associated with task-created driver ${owned.driver.pid}: ${pids.join(",") || "no listener"}; identity=${JSON.stringify(identity)}`);
  }
  owned.confirmed = true;
}

export async function safariDriverOwnershipDiagnostic(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection): Promise<string | undefined> {
  try { await assertSafariDriverOwnership(owned, port, inspect); }
  catch (error) { return String(error); }
}

// Reuse step9's session-first lifecycle: stop only our spawned driver, never an
// Apple XPC service. Strict association is diagnostic, not session admission.
// Owned PID+birth identities and port closure independently prove this teardown;
// the outer host controller additionally checks task paths before deleting roots.
export async function stopSafariDriver(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection, signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void = (pid, signal) => process.kill(pid, signal)): Promise<void> {
  const shutdownDeadline = Date.now() + 12_000;
  let rows = await inspect.processes(shutdownDeadline);
  const initialTree = rememberTree(owned, rows);
  if (!initialTree.has(owned.driver.pid) && owned.driver.exitCode === null && owned.driver.signalCode === null) {
    throw new Error("owned Safari driver process identity unavailable");
  }
  function remaining(): SafariProcessIdentity[] {
    return rows.filter(row => {
      const verified = owned.verified.get(row.pid);
      return verified !== undefined && sameProcess(verified, row);
    });
  }
  let listeners: number[] = [];
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    if (kind === "SIGKILL") {
      rows = await inspect.processes(shutdownDeadline);
      rememberTree(owned, rows);
    }
    const deadline = Math.min(Date.now() + 2_000, shutdownDeadline);
    // A verified descendant can be an Apple XPC service: never signal it, even
    // if its parent/group happens to match. Signal the original root only.
    if (remaining().some(row => row.pid === owned.driver.pid)) {
      try { signal(owned.driver.pid, kind); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
    do {
      rows = await inspect.processes(shutdownDeadline);
      // Retain known children across reparenting/group changes, and notice new
      // children while the original parent still proves their ancestry.
      rememberTree(owned, rows);
      listeners = await inspect.listeners(port, shutdownDeadline);
      if (!remaining().length && !listeners.length) return;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
  }
  throw new Error(`Safari driver shutdown unproved: processes=${remaining().map(row => row.pid).join(",") || "none"}; listeners=${listeners.join(",") || "none"}`);
}
