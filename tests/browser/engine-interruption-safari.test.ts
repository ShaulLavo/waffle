import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allocateSafariDriverPort, assertSafariDriverAlive, assertSafariDriverOwnership, ownSafariDriver, parseSafariProcessTable, safariDriverOwnershipDiagnostic, stopSafariDriver,
  type SafariDriverIdentity, type SafariInspection, type SafariProcessIdentity } from "./engine-interruption-safari";

function driver(): SafariDriverIdentity { return { pid: 41, exitCode: null, signalCode: null }; }
function row(pid = 41, ppid = 1, group = 7, started = 1_000): SafariProcessIdentity { return { pid, ppid, group, started }; }
function inspect(listeners: number[], processes = [row()]): SafariInspection {
  return { listeners: async () => listeners, processes: async () => processes };
}
function scope() { return ownSafariDriver(driver(), 1_000); }

function fixtureSpawnThreshold(wallTime: number, linux?: { stat: string; uptime: string }): number {
  if (!linux) return wallTime;
  // Linux ps uses integer btime + integer elapsed seconds, not floor(wall time).
  // Capture that same independent clock BEFORE spawning; no candidate birth or
  // arbitrary grace period is used. Darwin retains the wall-clock boundary.
  const boot = /^btime (\d+)$/m.exec(linux.stat);
  const bootSeconds = boot ? Number(boot[1]) : NaN;
  const elapsed = Number(linux.uptime.trim().split(/\s+/)[0]);
  const threshold = (bootSeconds + Math.floor(elapsed)) * 1_000;
  if (!Number.isSafeInteger(bootSeconds) || !linux.uptime.trim() || !Number.isFinite(elapsed)
    || elapsed < 0 || !Number.isSafeInteger(threshold)) throw new Error("invalid Linux fixture process clock");
  return threshold;
}

test("Linux listener fixture aligns its pre-spawn threshold with ps rather than relaxing Safari birth checks", async () => {
  // Boot epoch 1000.800s + elapsed 10.300s is wall time 1011.100s, but
  // Linux ps reconstructs lstart as 1000s + floor(10.300s) = 1010s.
  const wallTime = 1_011_050;
  const threshold = fixtureSpawnThreshold(wallTime, { stat: "cpu 1 2 3\nbtime 1000\n", uptime: "10.25 100.00\n" });
  expect(threshold).toBe(1_010_000);
  expect(fixtureSpawnThreshold(wallTime)).toBe(wallTime);
  const processes = [row(41, 1, 7, 1_010_000), row(42, 41, 7, 1_010_000)];
  await expect(assertSafariDriverOwnership(ownSafariDriver(driver(), threshold), 43186, inspect([42], processes))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(ownSafariDriver(driver(), wallTime), 43186, inspect([42], processes))).rejects.toThrow("process identity changed");
  await expect(assertSafariDriverOwnership(ownSafariDriver(driver(), threshold), 43186, inspect([42], [row(41, 1, 7, threshold - 1_000)]))).rejects.toThrow("process identity changed");
});
test("Linux listener fixture rejects malformed boot clocks rather than silently widening ownership", () => {
  for (const linux of [
    { stat: "cpu 1 2 3\n", uptime: "10.25 100.00\n" },
    { stat: "btime 1000\n", uptime: "" },
    { stat: "btime 1000\n", uptime: "NaN 100.00\n" },
    { stat: "btime 1000\n", uptime: "-1.25 100.00\n" },
  ]) expect(() => fixtureSpawnThreshold(1_011_050, linux)).toThrow("invalid Linux fixture process clock");
});

const appleHttpService = "/System/Library/PrivateFrameworks/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService";

function darwinProbe() {
  // Actual driver-only Mac probe: root34128 -> launchd-associated HTTPService34130,
  // not a PPID descendant. Both were born at 15:13:35; ps sess was redacted to 0.
  const started = Date.parse("Sat Oct 17 15:13:35 2026");
  const owned = ownSafariDriver({ pid: 34128, exitCode: null, signalCode: null }, started + 864, 51265);
  let processes = [row(34128, 34119, 34128, started), row(34130, 1, 34130, started)];
  const inspection: SafariInspection = { listeners: async () => [34130], processes: async () => processes,
    executable: async pid => pid === 34130 ? appleHttpService : "/usr/bin/safaridriver" };
  return { owned, inspection, replace: (rows: SafariProcessIdentity[]) => { processes = rows; }, rows: processes };
}

test("Safari rejection captures only the spawn, driver and listener identities needed to diagnose an ineligible candidate", async () => {
  const f = darwinProbe();
  const root = f.rows[0]!, candidate = { ...f.rows[1]!, ppid: root.pid };
  f.replace([root, candidate, row(99)]);
  const message = await assertSafariDriverOwnership(f.owned, 51265, f.inspection).then(() => "", error => String(error));
  expect(message).toContain(`; identity=${JSON.stringify({
    spawnedAfter: f.owned.spawnedAfter, allocatedPort: 51265, root, associated: null,
    listeners: [{ pid: candidate.pid, process: candidate, owned: false }],
  })}`);
  expect(message).not.toContain('"pid":99');
  expect(f.owned.observed.size).toBe(0);
  expect(f.owned.associated).toBeUndefined();
  expect(f.owned.verified.has(candidate.pid)).toBe(false);
});

test("Safari accepts the actual Darwin launchd XPC shape as associated, never as an owned descendant", async () => {
  const f = darwinProbe();
  await expect(assertSafariDriverOwnership(f.owned, 51265, f.inspection)).resolves.toBeUndefined();
  expect(f.owned.associated?.pid).toBe(34130);
  expect(f.owned.verified.has(34130)).toBe(false);
  expect(f.owned.verified.has(34128)).toBe(true);
});
test("Safari XPC association requires the exact allocated port, executable and post-spawn birth", async () => {
  const f = darwinProbe();
  await expect(assertSafariDriverOwnership(f.owned, 51266, f.inspection)).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(ownSafariDriver(f.owned.driver, f.owned.spawnedAfter), 51265, f.inspection)).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(f.owned, 51265, { ...f.inspection, executable: async () => "/tmp/com.apple.WebDriver.HTTPService" })).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(f.owned, 51265, { listeners: f.inspection.listeners, processes: f.inspection.processes })).rejects.toThrow("not owned");
  f.replace([f.rows[0]!, { ...f.rows[1]!, started: f.owned.spawnedAfter - 1_000 }]);
  await expect(assertSafariDriverOwnership(f.owned, 51265, f.inspection)).rejects.toThrow("not owned");
});
test("Safari rejects an extra or replacement listener after associating Apple's HTTPService", async () => {
  const f = darwinProbe();
  await assertSafariDriverOwnership(f.owned, 51265, f.inspection);
  await expect(assertSafariDriverOwnership(f.owned, 51265, { ...f.inspection, listeners: async () => [34130, 99] })).rejects.toThrow("not owned");
  f.replace([f.rows[0]!, { ...f.rows[1]!, pid: 34131 }]);
  await expect(assertSafariDriverOwnership(f.owned, 51265, { ...f.inspection, listeners: async () => [34131], executable: async () => appleHttpService })).rejects.toThrow("not owned");
});
test("Safari refuses an XPC port takeover during asynchronous executable inspection", async () => {
  const f = darwinProbe();
  let listeners = [34130];
  await expect(assertSafariDriverOwnership(f.owned, 51265, { ...f.inspection, listeners: async () => listeners,
    executable: async () => { listeners = [99]; return appleHttpService; } })).rejects.toThrow("not owned");
});
test("Safari rechecks driver health and XPC identity after asynchronous executable inspection", async () => {
  const f = darwinProbe();
  await expect(assertSafariDriverOwnership(f.owned, 51265, { ...f.inspection, executable: async () => {
    f.owned.driver.exitCode = 1; return appleHttpService;
  } })).rejects.toThrow("exited");
  const g = darwinProbe();
  await expect(assertSafariDriverOwnership(g.owned, 51265, { ...g.inspection, executable: async () => {
    g.replace([g.rows[0]!, { ...g.rows[1]!, started: g.owned.spawnedAfter + 1_000 }]); return appleHttpService;
  } })).rejects.toThrow("not owned");
});
test("Safari cleanup uses independent driver and port absence even when strict startup association was never confirmed", async () => {
  const f = darwinProbe(), signalled: number[] = [];
  await expect(stopSafariDriver(f.owned, 51265, { ...f.inspection, listeners: async () => [] }, pid => {
    signalled.push(pid); f.replace([f.rows[1]!]);
  })).resolves.toBeUndefined();
  expect(signalled).toEqual([34128]);
});
test("Safari teardown signals only the driver and waits for verified descendants to exit independently", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  await stopSafariDriver(owned, 43186, { processes: async () => {
    if (signalled.length) processes = [];
    return processes;
  }, listeners: async () => [] }, pid => { signalled.push(pid); });
  expect(signalled).toEqual([41]);
});
test("Safari logs strict association failure without blocking the live owned-driver lifecycle", async () => {
  const f = darwinProbe();
  f.replace([f.rows[0]!, { ...f.rows[1]!, ppid: f.rows[0]!.pid }]);
  expect(await safariDriverOwnershipDiagnostic(f.owned, 51265, f.inspection)).toContain("not owned or associated");
  expect(() => assertSafariDriverAlive(f.owned.driver)).not.toThrow();
  f.owned.driver.exitCode = 1;
  expect(() => assertSafariDriverAlive(f.owned.driver)).toThrow("exited");
});
test("Safari failed executable diagnostics do not prevent root shutdown or require signalling an observed XPC", async () => {
  const f = darwinProbe(), signalled: number[] = [];
  expect(await safariDriverOwnershipDiagnostic(f.owned, 51265, { ...f.inspection, executable: async () => {
    throw new Error("executable inspection failed");
  } })).toContain("executable inspection failed");
  const moved = { ...f.rows[1]!, group: 34131 };
  f.replace([f.rows[0]!, moved]);
  await stopSafariDriver(f.owned, 51265, { ...f.inspection, listeners: async () => [] }, pid => {
    signalled.push(pid); f.replace([moved]);
  });
  expect(signalled).toEqual([34128]);
});
test("Safari teardown does not spend termination time discovering an XPC association", async () => {
  const f = darwinProbe(), signalled: number[] = [];
  let executableInspected = false;
  await stopSafariDriver(f.owned, 51265, { ...f.inspection, listeners: async () => signalled.length ? [] : [34130],
    executable: async () => { executableInspected = true; throw new Error("not needed for teardown"); } }, pid => {
    signalled.push(pid); f.replace([f.rows[1]!]);
  });
  expect(signalled).toEqual([34128]);
  expect(executableInspected).toBe(false);
});
test("Safari stops only its driver and waits for its allocated port to close", async () => {
  const f = darwinProbe(), signalled: number[] = [];
  await assertSafariDriverOwnership(f.owned, 51265, f.inspection);
  let listening = true, checks = 0;
  await stopSafariDriver(f.owned, 51265, { ...f.inspection, listeners: async () => {
    if (++checks === 2) listening = false;
    return listening ? [34130] : [];
  } }, pid => { signalled.push(pid); f.replace([f.rows[1]!]); });
  expect(checks).toBe(2);
  expect(signalled).toEqual([34128]);
});
test("Safari never signals an associated XPC that closes its port and changes its process group", async () => {
  const f = darwinProbe(), signalled: number[] = [];
  await assertSafariDriverOwnership(f.owned, 51265, f.inspection);
  const moved = { ...f.rows[1]!, group: 34131 };
  f.replace([f.rows[0]!, moved]);
  await stopSafariDriver(f.owned, 51265, { ...f.inspection, listeners: async () => [] }, pid => {
    signalled.push(pid); f.replace([moved]);
  });
  expect(signalled).toEqual([34128]);
});

test("Safari parses real process group IDs rather than Darwin's redacted sess pointers", () => {
  const started = "Sat Oct 17 15:13:35 2026";
  expect(parseSafariProcessTable(` 34128 34119 34128 ${started}\n 34130 1 34130 ${started}\n`)).toEqual([
    row(34128, 34119, 34128, Date.parse(started)), row(34130, 1, 34130, Date.parse(started)),
  ]);
  expect(() => parseSafariProcessTable("34128 1 34128 invalid birth")).toThrow("start time");
  expect(() => parseSafariProcessTable("34128 1 10000abc Sat Oct 17 15:13:35 2026")).toThrow("process identity");
  expect(() => parseSafariProcessTable("not a process row")).toThrow("process identity");
});
test("Safari defaults to a privately allocated ephemeral port", async () => {
  const port = await allocateSafariDriverPort();
  expect(Number.isInteger(port) && port > 1023 && port < 65536).toBe(true);
});
test("Safari refuses an occupied explicit port without touching the listener", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owner") });
  try {
    await expect(allocateSafariDriverPort(server.port!)).rejects.toThrow();
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("owner");
  } finally { server.stop(true); }
});
test("Safari accepts the task-created live driver as listener and rejects unrelated listeners", async () => {
  const owned = scope();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([41]))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42]))).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([]))).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([41, 42]))).rejects.toThrow("not owned");
});
test("Safari accepts a same-group listener descended from its driver, including deeper descendants", async () => {
  const processes = [row(43, 42), row(42, 41), row()];
  await expect(assertSafariDriverOwnership(scope(), 43186, inspect([43], processes))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(scope(), 43186, inspect([41, 42, 43], processes))).resolves.toBeUndefined();
});
for (const [name, processes] of [
  ["same-group sibling", [row(), row(42)]],
  ["different-group child", [row(), row(42, 41, 8)]],
  ["child predating spawn", [row(), row(42, 41, 7, 0)]],
  ["child predating its parent", [row(41, 1, 7, 3_000), row(42, 41, 7, 2_000)]],
  ["missing ancestor", [row(), row(42, 44)]],
  ["parent cycle", [row(), row(42, 43), row(43, 42)]],
] satisfies [string, SafariProcessIdentity[]][]) {
  test(`Safari rejects ${name} as a listener`, async () => {
    await expect(assertSafariDriverOwnership(scope(), 43186, inspect([42], processes))).rejects.toThrow("not owned");
  });
}
test("Safari rejects a root that predates spawn or changes birth identity", async () => {
  await expect(assertSafariDriverOwnership(scope(), 43186, inspect([41], [row(41, 1, 7, 0)]))).rejects.toThrow("identity changed");
  const owned = scope();
  await assertSafariDriverOwnership(owned, 43186, inspect([41]));
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([41], [row(41, 1, 7, 2_000)]))).rejects.toThrow("identity changed");
});
test("Safari keeps the same root lifetime when its process group changes", async () => {
  const owned = scope();
  await assertSafariDriverOwnership(owned, 43186, inspect([41]));
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([41], [row(41, 1, 8)]))).resolves.toBeUndefined();
});
test("Safari allows the spawn second's coarse ps timestamp but not an earlier second", async () => {
  const owned = ownSafariDriver(driver(), 1_999);
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41, 7, 0)]))).rejects.toThrow("not owned");
});
test("Safari rejects an absent root and never adopts a previously verified orphan for requests", async () => {
  const owned = scope();
  await assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]));
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(42, 1)]))).rejects.toThrow("not owned");
});
test("Safari never adopts a winning driver's session after its own driver exits", async () => {
  const owned = scope(); owned.driver.exitCode = 1;
  let inspected = false;
  await expect(assertSafariDriverOwnership(owned, 43186, { ...inspect([]), listeners: async () => { inspected = true; return [42]; } })).rejects.toThrow("exited");
  expect(inspected).toBe(false);
});
test("Safari checks child health again after asynchronous listener and process inspection", async () => {
  const owned = scope();
  await expect(assertSafariDriverOwnership(owned, 43186, { ...inspect([41]), processes: async () => {
    owned.driver.signalCode = "SIGTERM"; return [row()];
  } })).rejects.toThrow("exited");
});
test("Safari retains an owned child across group changes but never signals it or claims cleanup while it survives", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  const inspection: SafariInspection = { processes: async () => processes, listeners: async () => [] };
  await assertSafariDriverOwnership(owned, 43186, { ...inspection, listeners: async () => [42] });
  processes = [row(), row(42, 41, 42)];
  await expect(stopSafariDriver(owned, 43186, inspection, pid => {
    signalled.push(pid); processes = processes.filter(row => row.pid !== pid);
  })).rejects.toThrow("processes=42");
  expect(signalled).toEqual([41]);
  expect(processes).toEqual([row(42, 41, 42)]);
}, 8_000);
test("Safari accepts an already verified listener after its process group changes, but not an unknown child in that group", async () => {
  const owned = scope();
  await assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]));
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41, 42)]))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([43], [row(), row(42, 41, 42), row(43, 42, 42)]))).rejects.toThrow("not owned");
});
test("Safari teardown waits for a verified reparented child to exit with the root without signalling the child", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  const inspection: SafariInspection = { processes: async () => processes, listeners: async () => processes.some(row => row.pid === 42) ? [42] : [] };
  await assertSafariDriverOwnership(owned, 43186, inspection);
  processes = [row(), row(42, 1)];
  await stopSafariDriver(owned, 43186, inspection, pid => { signalled.push(pid); processes = []; });
  expect(signalled).toEqual([41]);
});
test("Safari teardown waits for a verified orphan after the root exits without signalling it", async () => {
  const owned = scope(), signalled: number[] = [];
  await assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]));
  owned.driver.exitCode = 1;
  let checks = 0;
  await stopSafariDriver(owned, 43186, { processes: async () => ++checks === 1 ? [row(42, 1)] : [], listeners: async () => [] }, pid => {
    signalled.push(pid);
  });
  expect(signalled).toEqual([]);
});
test("Safari teardown never signals a replacement or uninspectable live root", async () => {
  const owned = scope(), signalled: number[] = [];
  await assertSafariDriverOwnership(owned, 43186, inspect([41]));
  await expect(stopSafariDriver(owned, 43186, inspect([], [row(41, 1, 7, 2_000)]), pid => {
    signalled.push(pid);
  })).rejects.toThrow("process identity changed");
  await expect(stopSafariDriver(owned, 43186, inspect([], []), pid => {
    signalled.push(pid);
  })).rejects.toThrow("process identity unavailable");
  expect(signalled).toEqual([]);
});
test("Safari teardown tolerates ESRCH but does not claim success on inspection or other signal errors", async () => {
  let processes = [row()];
  const inspection = { processes: async () => processes, listeners: async () => [] };
  await expect(stopSafariDriver(scope(), 43186, inspection, () => {
    processes = []; throw Object.assign(new Error("gone"), { code: "ESRCH" });
  })).resolves.toBeUndefined();
  await expect(stopSafariDriver(scope(), 43186, inspect([], [row()]), () => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  })).rejects.toThrow("denied");
  await expect(stopSafariDriver(scope(), 43186, { ...inspection, processes: async () => { throw new Error("ps failed"); } })).rejects.toThrow("ps failed");
});
test("Safari teardown shares one bounded inspection deadline instead of leaving an inspection race running", async () => {
  const before = Date.now(), deadlines: (number | undefined)[] = [];
  let processes = [row()];
  await stopSafariDriver(scope(), 43186, { processes: async deadline => { deadlines.push(deadline); return processes; },
    listeners: async (_port, deadline) => { deadlines.push(deadline); return []; } }, () => { processes = []; });
  expect(deadlines).toHaveLength(3);
  expect(deadlines.every(deadline => deadline === deadlines[0])).toBe(true);
  expect(deadlines[0]).toBeGreaterThan(before);
  expect(deadlines[0]! - before).toBeLessThanOrEqual(12_000);
});
test("Safari teardown discovers a non-listening child forked during shutdown but signals only the root", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row()];
  let inspected = 0;
  await stopSafariDriver(owned, 43186, { processes: async () => {
    inspected++;
    if (inspected === 2) processes.push(row(42, 41));
    return processes;
  }, listeners: async () => [] }, pid => {
    signalled.push(pid);
    if (signalled.length > 1) processes = [];
  });
  expect(signalled).toEqual([41, 41]);
  expect(owned.verified.has(42)).toBe(true);
  expect(processes).toEqual([]);
});
test("Safari teardown tracks startup children but signals only the root", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  await stopSafariDriver(owned, 43186, { processes: async () => processes, listeners: async () => [] }, pid => {
    signalled.push(pid); processes = [];
  });
  expect(signalled).toEqual([41]);
  expect(owned.verified.has(42)).toBe(true);
});
test("Safari teardown never signals a reused child PID or unrelated listener, and reports an occupied port", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  const inspection: SafariInspection = { processes: async () => processes, listeners: async () => [42] };
  await assertSafariDriverOwnership(owned, 43186, inspection);
  processes = [row(), row(42, 1, 7, 2_000), row(99)];
  await expect(stopSafariDriver(owned, 43186, inspection, pid => {
    signalled.push(pid); processes = processes.filter(row => row.pid !== pid);
  })).rejects.toThrow("listeners=42");
  expect(signalled).toEqual([41]);
  expect(processes.map(row => row.pid)).toEqual([42, 99]);
});
test("Safari teardown escalates an unresponsive owned driver without signalling unrelated processes", async () => {
  const signals: string[] = [];
  let processes = [row(), row(99)];
  await stopSafariDriver(scope(), 43186, { processes: async () => processes, listeners: async () => [] }, (pid, signal) => {
    signals.push(`${pid}:${signal}`);
    if (signal === "SIGKILL") processes = processes.filter(row => row.pid !== pid);
  });
  expect(signals).toEqual(["41:SIGTERM", "41:SIGKILL"]);
  expect(processes).toEqual([row(99)]);
});

test("Safari owns a real parent-spawned child listener and tears down both without a browser", async () => {
  // No pre-existing resources are modified. This fixture owns one parent, its
  // child listener and one ephemeral port; fallback teardown is installed first.
  let parent: ReturnType<typeof Bun.spawn> | undefined;
  let childPid: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function kill(pid: number | undefined): void {
    if (pid === undefined) return;
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }
  try {
    const spawnedAfter = fixtureSpawnThreshold(Date.now(), process.platform === "linux" ? {
      stat: readFileSync("/proc/stat", "utf8"), uptime: readFileSync("/proc/uptime", "utf8"),
    } : undefined);
    const spawned = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/safari-driver-listener.ts`], { stdout: "pipe", stderr: "inherit" });
    parent = spawned;
    deadline = setTimeout(() => { kill(childPid); if (parent?.exitCode === null) parent.kill("SIGKILL"); }, 7_000);
    const reader = spawned.stdout.getReader();
    const decoder = new TextDecoder();
    let line = "";
    try {
      while (!line.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("listener fixture exited before publishing its PID and port");
        line += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    const published: unknown = JSON.parse(line.trim());
    if (typeof published !== "object" || published === null || !("pid" in published) || !("port" in published)
      || typeof published.pid !== "number" || typeof published.port !== "number") throw new Error("invalid listener fixture identity");
    childPid = published.pid;
    const port = published.port;
    expect(childPid).not.toBe(parent.pid);
    const owned = ownSafariDriver(parent, spawnedAfter);
    await assertSafariDriverOwnership(owned, port);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("owned child");
    await stopSafariDriver(owned, port);
    await parent.exited;
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
  } finally {
    clearTimeout(deadline);
    kill(childPid);
    if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await parent?.exited;
  }
}, 10_000);
