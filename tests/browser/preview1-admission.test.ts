import { expect, test } from "bun:test";
import type { RuntimeFilesystem } from "@bun-wasm/runtime";
import { createFilesystemIdentity } from "@bun-wasm/runtime/fs";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost } from "../src/subprocess";
import type { RunRequest } from "../src/worker";
import { processRuntimeFixture } from "./process-runtime-fixture";

for (const admission of ["other-broker", "runtime"] as const) test(`legacy Preview1 launch uses canonical source admission from ${admission}`, async () => {
  const previousWorker = globalThis.Worker;
  const ports: MessagePort[] = [];
  let request!: RunRequest;
  globalThis.Worker = class {
    postMessage(value: RunRequest) { request = value; }
    terminate() {}
  } as unknown as typeof Worker;
  const runtime = processRuntimeFixture({
    connect(identity) { const channel = new MessageChannel(); ports.push(channel.port1, channel.port2); return { ...identity, port: channel.port1 }; },
    revoke() {}, reap() {}, async quiesce() {},
  } as RuntimeFilesystem);
  const registering = new SubprocessBroker("https://example.test/worker.js", runtime);
  const launching = new SubprocessBroker("https://example.test/worker.js", runtime, { root: { pid: runtime.identities.pid(), job: runtime.identities.job() } });
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  if (admission === "other-broker") registering.register("tool", { adapter: "preview1", bytes });
  else runtime.registerProgram("tool", { adapter: "preview1", source: bytes });
  const supervisor = await launching.ready();
  const root = Array.from(supervisor.table.values()).find(record => record.parentPid === 0)!;
  const host = new SubprocessHost({ identity: runtime.identities.buffer, pid: root.pid, jobId: root.job, output() {},
    launch(meta, child) {
      launching.spawn({ executable: "tool", argv: meta.argv, env: {}, cwd: "/", pid: child.pid,
        parentPid: root.pid, jobId: child.jobId, job: -1, filesystem: createFilesystemIdentity(), child, trace: false, spawnBroker: true });
      return { terminate() {} };
    },
  });
  try {
    const pid = host.spawn(JSON.stringify({ argv: ["tool"], job: -1 }));
    for (let turn = 0; turn < 100 && !request; turn++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(request?.pid).toBe(pid);
    expect(request.interruptible).toBe(true);
  } finally {
    host.detach(); host.dispose(); registering.dispose(); launching.dispose();
    await runtime.dispose();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
  }
});
