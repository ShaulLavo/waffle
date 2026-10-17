// A safaridriver-shaped process tree, without starting a browser. The test owns
// both PIDs and installs teardown before spawning this fixture.
if (process.argv.includes("--listener")) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned child") });
  const parentPid = process.ppid;
  // If startup fails before the test receives our PID, losing the parent must
  // still close this fixture-owned listener rather than leave an orphan.
  const parentWatch = setInterval(() => { if (process.ppid !== parentPid) stop(); }, 25);
  function stop(): void { clearInterval(parentWatch); server.stop(true); process.exit(0); }
  process.on("SIGTERM", stop);
  console.log(JSON.stringify({ pid: process.pid, port: server.port }));
} else {
  const listener = Bun.spawn([process.execPath, import.meta.path, "--listener"], { stdout: "inherit", stderr: "inherit" });
  // Deliberately do not forward SIGTERM: production teardown must stop the
  // verified listener itself, not assume that terminating its parent does so.
  await listener.exited;
}
