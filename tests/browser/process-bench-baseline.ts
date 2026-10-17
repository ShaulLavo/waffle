// Compiled against a frozen main snapshot by browser-process.ts, not against the edited source.
// The selected snapshot must implement the page-owned runtime contract.
import { createRuntime } from "@bun-wasm/runtime";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost } from "../src/subprocess.js";
import { measureProcessStarts } from "./process-benchmark";
const runtime = createRuntime({ filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
const fs = runtime.filesystem;
let sample = 0;
const decoder = new TextDecoder();
let result: Record<string, unknown>;
try {
  await fs.mkdirp("/home/user"); await fs.flush();
  const benchmark = await measureProcessStarts(async (module, started) => {
    const pid = runtime.identities.pid(), job = runtime.identities.job();
    const executable = `bun-benchmark-${++sample}`;
    const broker = new SubprocessBroker(new URL("./worker.js", location.href).href, runtime, { root: { pid, job } });
    broker.register(executable, { adapter: "bun", engine: "quickjs", module });
    const host = new SubprocessHost({ pid, jobId: job, identity: runtime.identities.buffer,
      output() {}, onChildClose: childPid => broker.close(pid, childPid), launch(meta, child) {
      const filesystem = fs.createIdentity();
      broker.spawn({ executable, argv: meta.argv, pid: child.pid, parentPid: child.parentPid,
        jobId: child.jobId, cwd: "/home/user", env: {}, filesystem, child, trace: false, spawnBroker: true });
      return { revoke() { fs.revoke(filesystem); }, terminate() {} };
    } });
    try {
      const handle = host.spawn(JSON.stringify({ executable, argv: ["bun", "-e", "console.log('ready')"] }));
      if (handle < 0) throw new Error(`baseline spawn failed ${handle}`);
      let firstOutputMs: number | undefined;
      let stdout = "", stderr = "";
      for (;;) {
        for (const fd of [1, 2]) {
          const value = host.read(host.pipe(handle, fd));
          if (value instanceof Uint8Array) { if (fd === 1) { firstOutputMs ??= performance.now() - started; stdout += decoder.decode(value); } else stderr += decoder.decode(value); }
        }
        const code = host.wait(handle);
        if (code !== -2) {
          if (code !== 0 || stdout !== "ready\n" || stderr || firstOutputMs === undefined) throw new Error(`baseline invalid child ${JSON.stringify({ code, stdout, stderr })}`);
          return { firstOutputMs, exitMs: performance.now() - started };
        }
        if (performance.now() - started > 15_000) throw new Error("baseline child timed out");
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    } finally { try { await broker.rootExit(0); } finally { broker.dispose(); host.dispose(); } }
  });
  result = { ok: true, benchmark };
} catch (error) { result = { ok: false, error: error instanceof Error ? error.stack : String(error) }; }
finally {
  try { await runtime.dispose(); }
  catch (error) { result = { ...result!, ok: false, cleanupError: String(error) }; }
  Object.assign(globalThis, { processBaselineResult: result! });
}
