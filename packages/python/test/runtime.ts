import assert from "node:assert/strict";
import { createRuntime } from "waffle";
import { serveTestFiles } from "./assets-server.ts";
import { qualifyPython } from "./qualification.ts";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";

// The public Node root locates this package's generated Node worker modules.
const nodeRoot = new URL(".", import.meta.resolve("waffle"));
const server = await serveTestFiles(new URL("..", import.meta.url).pathname);
installNodeWorkers();
const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("browser/fs-worker.js", nodeRoot) },
});
try {
  const result = await qualifyPython(runtime, {
    workerUrl: new URL(import.meta.resolve("waffle/browser/preview1-worker")),
    wasmUrl: new URL("/assets/python.wasm", server.origin),
    payloadUrl: new URL("/assets/python-stdlib.json", server.origin),
  });
  console.log(JSON.stringify({ engine: "Node", node: process.version, result }));
} finally {
  await runtime.dispose();
  await stopNodeWorkers();
  await server.close();
}
assert.equal(runtime.disposed, true);
assert.equal(liveNodeWorkers(), 0);
console.log(
  JSON.stringify({ cleanup: { runtimeDisposed: true, liveNodeWorkers: 0, serverClosed: true } }),
);
