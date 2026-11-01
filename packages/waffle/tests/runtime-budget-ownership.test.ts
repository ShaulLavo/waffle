import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("rejected construction cannot disable the active bounded platform or its admission", () => {
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const source = `
    import assert from "node:assert/strict";
    import {createRuntime} from ${url("../runtime.ts")};
    import {declareSharedMemoryPlatform,bytes,pages} from ${url("../memory/index.ts")};
    import {FilesystemService} from ${url("../fs/service.ts")};
    import {MemoryBackend} from ${url("../fs/backend.ts")};
    const ports=[];
    globalThis.Worker=class {
      service=new FilesystemService(new MemoryBackend());
      addEventListener(){}
      postMessage({connect}){ports.push(connect.port);this.service.connect(connect)}
      terminate(){this.service.dispose()}
    };
    const platform=declareSharedMemoryPlatform({kind:"bounded",budgetBytes:bytes(3*1024**3),counts:{fixedBuffer:true,sharedMemory:true,privateMemory:true}});
    const runtime=createRuntime({sharedMemory:platform,filesystem:{mode:"memory",workerURL:"fixture"}});
    const plan={pid:2,executable:"large",guest:{kind:"declared",memories:[{kind:"private",origin:"defined",maximumPages:pages(65536)}]},group:"none",connection:true,controls:true};
    try {
      assert.equal(runtime.sharedMemory.check(plan).kind,"refused");
      assert.throws(()=>createRuntime({sharedMemory:declareSharedMemoryPlatform({kind:"unbounded"})}),/live page runtime/);
      assert.deepEqual(runtime.sharedMemory.snapshot().platform,platform);
      assert.equal(runtime.sharedMemory.check(plan).kind,"refused");
    } finally {await runtime.dispose();for(const port of ports)port.close()}
    assert.throws(()=>createRuntime({sharedMemory:declareSharedMemoryPlatform({kind:"unbounded"}),hostIdentity:{uid:-1}}));
    assert.deepEqual(runtime.sharedMemory.snapshot().platform,platform);
  `;
  const result = spawnSync(process.execPath, ["--eval", source], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
