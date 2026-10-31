import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import type { ExecutableRegistry } from "waffle/proc/registry";
import { installEnv } from "../src/utilities/env";

test("env alias admission uses the caller's real Waffle filesystem and registry", async (context) => {
  // Load the existing Node worker shim outside the in-memory unit-test bundle so
  // its worker bootstrap keeps its own file URL. No guest is built or launched.
  const workers: typeof import("../scripts/node-worker-host.ts") = await import(
    new URL("../scripts/node-worker-host.ts", import.meta.url).href
  );
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  let runtime: ReturnType<typeof createRuntime> | undefined;
  context.after(async () => {
    try {
      await runtime?.dispose();
    } finally {
      await workers.stopNodeWorkers();
      restoreGlobal("Worker", previousWorker);
      restoreGlobal("crossOriginIsolated", previousIsolation);
      assert.equal(workers.liveNodeWorkers(), 0);
    }
  });
  workers.installNodeWorkers();
  let registry: ExecutableRegistry | undefined;
  runtime = createRuntime({
    filesystem: {
      workerURL: new URL("../dist/fs-worker.js", import.meta.url),
      mode: "memory",
    },
    processHost(options) {
      registry = options.registry;
      return new BrowserProcessBroker(options);
    },
  });
  await runtime.filesystem.mkdirp("/usr/bin");
  const marker = new TextEncoder().encode("bash-web utility: env\n");
  await runtime.filesystem.writeFile("/usr/bin/env", marker);
  await runtime.filesystem.drain();
  await runtime.processes();
  assert.ok(registry);
  await assert.rejects(registry.check("/usr/bin/env"), /not a registered executable/);
  let loads = 0;
  const installation = await installEnv(runtime, {
    source: () => {
      loads++;
      throw new Error("admission must not load the guest");
    },
  });
  assert.equal(installation.executable, "/bin/env");
  const canonical = await registry.check("/bin/env");
  const alias = await registry.check("/usr/bin/env");
  assert.equal(canonical.adapter, alias.adapter);
  assert.equal(alias.interruptible, true);
  assert.equal(loads, 0);
  await installation.dispose();
  assert.equal(await runtime.filesystem.lookup("/bin/env"), undefined);
  assert.deepEqual(await runtime.filesystem.readFile("/usr/bin/env"), marker);
  await assert.rejects(registry.check("/usr/bin/env"), /not a registered executable/);
  assert.equal(loads, 0);
});

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
