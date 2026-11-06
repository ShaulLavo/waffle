import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { RuntimeOptions } from "../runtime.js";
import type { SharedMemoryDeclaration, SharedMemorySnapshot } from "../memory/index.js";

test("explicit input types accept issued application declarations only", () => {
  // Type control, checked by tsc: default provenance is never an explicit declaration.
  const inputs = (
    snapshot: SharedMemorySnapshot,
    declared: SharedMemoryDeclaration,
  ): readonly RuntimeOptions[] => [
    // @ts-expect-error A snapshot platform may carry default provenance.
    { sharedMemory: snapshot.platform },
    // @ts-expect-error Null is not omission.
    { sharedMemory: null },
    // @ts-expect-error An unissued literal is not a declaration.
    { sharedMemory: { kind: "unbounded", source: "default" } },
    { sharedMemory: declared },
    { sharedMemory: undefined },
    {},
  ];
  expect(inputs).toBeFunction();
});

test("only omission selects the default; recovered, null and foreign inputs are refused", () => {
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const source = `
    import assert from "node:assert/strict";
    import {createRuntime} from ${url("../runtime.ts")};
    import {declareSharedMemoryPlatform} from ${url("../memory/index.ts")};
    import {FilesystemService} from ${url("../fs/service.ts")};
    import {MemoryBackend} from ${url("../fs/backend.ts")};
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      get() { throw new Error("shared-memory selection read navigator"); },
    });
    const ports=[];
    globalThis.Worker=class {
      service=new FilesystemService(new MemoryBackend());
      addEventListener(){}
      postMessage({connect}){ports.push(connect.port);this.service.connect(connect)}
      terminate(){this.service.dispose()}
    };
    const filesystem={mode:"memory",workerURL:"fixture"};
    const omitted=createRuntime({filesystem});
    const recovered=omitted.sharedMemory.snapshot().platform;
    assert.deepEqual(recovered,{kind:"unbounded",source:"default"});
    assert(Object.isFrozen(recovered));
    await omitted.dispose();
    const before=omitted.sharedMemory.snapshot();
    const explicit=declareSharedMemoryPlatform({kind:"unbounded"});
    const refused=[recovered,null,{...explicit},{kind:"unbounded",source:"application"},{kind:"unbounded",source:"default"}];
    for (const sharedMemory of refused)
      assert.throws(()=>createRuntime({sharedMemory,filesystem}),TypeError);
    let reentered=false;
    assert.throws(()=>createRuntime({filesystem,get sharedMemory(){
      assert.throws(()=>createRuntime({filesystem}),/live page runtime/);
      reentered=true;
      return recovered;
    }}),TypeError);
    assert(reentered);
    assert.deepEqual(omitted.sharedMemory.snapshot(),before);
    const application=createRuntime({sharedMemory:explicit,filesystem});
    assert.equal(application.sharedMemory.snapshot().platform,explicit);
    assert.equal(application.sharedMemory.snapshot().platform.source,"application");
    await application.dispose();
    const again=createRuntime({sharedMemory:undefined,filesystem});
    assert.equal(again.sharedMemory.snapshot().platform,recovered);
    await again.dispose();
    for(const port of ports)port.close();
  `;
  const result = spawnSync(process.execPath, ["--eval", source], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
