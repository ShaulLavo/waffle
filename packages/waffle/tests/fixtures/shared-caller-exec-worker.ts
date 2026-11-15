import assert from "node:assert/strict";
import { bootstrap, type WorkerExecutionContext } from "../../browser/worker.ts";
import { linkedWorkerHooks, type LinkedWorkerRequest } from "../../link/index.ts";

const release = Promise.withResolvers<void>();
const execGate = Promise.withResolvers<void>();
const post = globalThis.postMessage.bind(globalThis);
let entered = false;
let actualMemory: WebAssembly.Memory | undefined;
const hooks = linkedWorkerHooks();

function execDescriptors(context: WorkerExecutionContext) {
  if (context.request.env.DESCRIPTORS !== "1") return [{ parent: 3, child: 3 }];
  const table = context.wasi.descriptors;
  const root = table.get(4);
  assert(root?.resource.kind === "directory" && root.preopen === "/");
  root.rightsBase = 17n;
  root.rightsInheriting = 19n;
  table.inherit(21, root);
  const pipe = table.get(3);
  assert(pipe?.resource.kind === "pipe");
  pipe.resource.fdflags = 4;
  table.inherit(22, pipe);
  const path = context.fs.resolve(root.resource.handle, "still-usable");
  assert(typeof path !== "number" && path.node !== undefined);
  const node = path.node;
  context.fs.retain(node);
  const resource = {
    kind: "file",
    handle: node,
    offset: 0,
    append: true,
    fdflags: 5,
  } satisfies import("../../core/descriptors.js").Resource;
  table.openAt(7, resource, 3n, 0n, () => context.fs.release(node));
  table.inherit(11, { ...table.get(7)!, rightsBase: 1n });
  const bytes = new Uint8Array(3);
  resource.offset += context.fs.read(node, [bytes], resource.offset);
  assert.equal(new TextDecoder().decode(bytes), "ori");
  assert.equal(context.fs.removePath(path, false), 0);
  return [
    { parent: 4, child: 19 },
    { parent: 21, child: 21 },
    { parent: 7, child: 7 },
    { parent: 11, child: 11 },
    { parent: 3, child: 17 },
    { parent: 22, child: 23 },
  ];
}

globalThis.onmessage = ({
  data,
}: MessageEvent<LinkedWorkerRequest | { kind: "release" | "exec" }>) => {
  if ("kind" in data && data.kind === "release") return release.resolve();
  if ("kind" in data && data.kind === "exec") return execGate.resolve();
  assert("module" in data && !entered);
  entered = true;
  void bootstrap(data, {
    ...hooks,
    namespaces: () => ({ test: { check() {} } }),
    instantiate(imports, context) {
      return hooks.instantiate!(imports, {
        ...context,
        bindMemory(memory) {
          actualMemory = memory;
          context.bindMemory(memory);
        },
      });
    },
    async run(context, exited) {
      assert(actualMemory && context.process && context.request.memoryGroup);
      assert.equal(context.instance.exports.memory, undefined);
      assert.equal(actualMemory, context.request.memoryGroup.memory);
      const generation = context.request.runtimeProcess?.generation;
      post({ type: "control-ready" });
      await execGate.promise;
      const request = {
        executable: context.request.env.TARGET ?? "/held-host",
        argv: ["held-host"],
        env: {},
        cwd: "/",
        fds: execDescriptors(context),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(request));
      const address = actualMemory.buffer.byteLength - 4096;
      new Uint8Array(actualMemory.buffer, address, bytes.length).set(bytes);
      const exec = context.process.imports.exec;
      const getpid = context.process.imports.getpid;
      assert(exec && getpid);
      const result = exec(address, bytes.length);
      assert.equal(result, Number(context.request.env.EXPECT ?? "-58"));
      context.checkActive();
      assert.equal(getpid(), context.identity?.pid);
      const root = context.wasi.descriptors.get(3);
      assert(root?.resource.kind === "directory");
      const resolved = context.fs.resolve(root.resource.handle, "still-usable");
      assert(typeof resolved !== "number" && resolved.node !== undefined);
      const contents = new Uint8Array(
        new TextEncoder().encode("original runtime filesystem").length,
      );
      assert.equal(context.fs.read(resolved.node, [contents], 0), contents.length);
      assert.equal(new TextDecoder().decode(contents), "original runtime filesystem");
      assert.equal(context.request.runtimeProcess?.generation, generation);
      post({
        type: "control-rejected",
        result,
        generation,
        pid: context.identity?.pid,
        memoryGroup: true,
        exportedMemory: false,
        filesystemUsable: true,
      });
      await release.promise;
      context.checkActive();
      post({ type: "control-completing", generation });
      return exited ?? 0;
    },
  });
};
