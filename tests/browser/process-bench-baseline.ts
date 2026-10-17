// Compiled against a frozen main snapshot by browser-process.ts, not against the edited source.
// This intentionally uses main's pre-registry contract; it is a measurement, not a compatibility path.
import { SharedFilesystem } from "../src/shared-fs";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost } from "../src/subprocess.js";
import { createFilesystemIdentity } from "../../runtime/fs";
import { measureProcessStarts } from "./process-benchmark";
const fs = new SharedFilesystem();
const decoder = new TextDecoder();
try {
  await fs.mkdirp("/home/user"); await fs.flush();
  const benchmark = await measureProcessStarts(async (module, started) => {
    const broker = new SubprocessBroker(new URL("./worker.js", location.href).href, fs);
    const host = new SubprocessHost({ output() {}, launch(meta, child) {
      const filesystem = createFilesystemIdentity(fs.client.connection);
      broker.spawn({ engine: "quickjs", module, args: meta.argv, env: { PWD: "/home/user" }, filesystem, child, net: null, moduleCache: null, trace: false, spawnBroker: true });
      return { revoke() { fs.revoke(filesystem); }, terminate() {} };
    } });
    try {
      const handle = host.spawn(JSON.stringify({ argv: ["bun", "-e", "console.log('ready')"] }));
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
    } finally { broker.dispose(); host.dispose(); }
  });
  Object.assign(globalThis, { processBaselineResult: { ok: true, benchmark } });
} catch (error) { Object.assign(globalThis, { processBaselineResult: { ok: false, error: error instanceof Error ? error.stack : String(error) } }); }
finally { fs.dispose(); }
