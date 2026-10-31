import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const nativeWorker = globalThis.Worker;
const workers: Worker[] = [];
const body = { textContent: "" };
Object.assign(globalThis, { document: { body } });
globalThis.Worker = new Proxy(nativeWorker, {
  construct(target, args) {
    const requested = String(args[0]);
    assert(requested.endsWith("/fs-worker.js"));
    assert(existsSync(fileURLToPath(requested)));
    const worker = Reflect.construct(target, args);
    workers.push(worker);
    return worker;
  },
});
let startup: Promise<void> | undefined;
try {
  await import(process.argv[2]!);
  startup = Reflect.get(globalThis, "documentedStartup");
  assert(startup instanceof Promise);
  await startup;
  assert.equal(body.textContent, "hello from Waffle");
  assert.equal(workers.length, 1);
  assert.deepEqual(Reflect.get(globalThis, "documentedPlatform"), {
    kind: "unbounded",
    source: "profile",
    profile: "desktop",
  });
} finally {
  await startup?.catch(() => {});
  await Promise.all(workers.map((worker) => worker.terminate()));
}
