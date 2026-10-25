import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { PipeController, PipeEndpoint, PipeErrno, attachPipeEndpoint } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import type { ProcessContext } from "../proc/types.js";
import { fixtureSpawnRequest } from "./fixtures/spawn-request.js";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const byte = new Uint8Array([120]);

function fixture() {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  const descriptors = new DescriptorTable();
  descriptors.open(reader, 0n, 0n);
  descriptors.open(writer, 0n, 0n);
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  let context: ProcessContext | undefined;
  const supervisor = new ProcessSupervisor({
    registry,
    launch(value) {
      context = value;
      value.started();
      return { terminate() {} };
    },
  });
  const root = supervisor.createRoot({ pid: 1, descriptors });
  return {
    pipe,
    reader,
    writer,
    supervisor,
    root,
    context: () => context,
    dispose() {
      supervisor.dispose();
      descriptors.dispose();
      pipe.dispose();
    },
  };
}

test("one parent-held default pipe survives repeated inherited child writers through the supervisor", async () => {
  const f = fixture();
  const attachedReader = attachPipeEndpoint(structuredClone(f.reader.handle()));
  let stale: PipeEndpoint | undefined;
  try {
    for (let index = 0; index < 3001; index++) {
      const pid = f.supervisor.reserveSpawn(
        f.root,
        fixtureSpawnRequest({ fds: [{ parent: 1, child: 1 }] }),
      );
      const job = f.supervisor.get(pid)!.job;
      await f.supervisor.start(pid);
      const context = f.context()!;
      const inherited = context.descriptors.get(1)!.resource;
      expect(inherited).toBeInstanceOf(PipeEndpoint);
      if (!(inherited instanceof PipeEndpoint)) throw new Error("missing child writer");
      stale ??= attachPipeEndpoint(structuredClone(inherited.handle()));
      expect(inherited.tryWrite([byte])).toBe(1);
      const output = new Uint8Array(1);
      expect(attachedReader.tryRead([output])).toBe(1);
      expect(output[0]).toBe(120);
      context.exit(0);
      expect((await f.supervisor.waitForExit(f.root, pid)).kind).toBe("exited");
      expect(f.supervisor.wait(f.root, pid)?.status).toBe(0);
      expect(f.supervisor.waitJob(f.root, job)?.status).toBe(0);
      expect(f.supervisor.get(pid)).toBeUndefined();
      expect(f.pipe.resourceUsage).toMatchObject({
        backingBytes: 4982576,
        activeReaders: 1,
        activeWriters: 1,
      });
      if ([15, 99, 3000].includes(index))
        console.log(JSON.stringify({ children: index + 1, ...f.pipe.resourceUsage }));
      expect(stale.tryWrite([byte])).toBe(-PipeErrno.BADF);
      expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
    }
    expect(f.writer.tryWrite([byte])).toBe(1);
    expect(attachedReader.tryRead([new Uint8Array(1)])).toBe(1);
    f.writer.close();
    expect(attachedReader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    f.dispose();
  }
}, 20_000);

test("one parent-held pipe reuses inherited reader membership after normal exit and SIGKILL", async () => {
  const f = fixture();
  let stale: PipeEndpoint | undefined;
  try {
    for (let index = 0; index < 100; index++) {
      const pid = f.supervisor.reserveSpawn(
        f.root,
        fixtureSpawnRequest({ fds: [{ parent: 0, child: 0 }] }),
      );
      const job = f.supervisor.get(pid)!.job;
      await f.supervisor.start(pid);
      const context = f.context()!;
      const inherited = context.descriptors.get(0)!.resource;
      if (!(inherited instanceof PipeEndpoint)) throw new Error("missing child reader");
      stale ??= attachPipeEndpoint(structuredClone(inherited.handle()));
      expect(inherited.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
      expect(f.writer.tryWrite([byte])).toBe(1);
      f.pipe.pumpRelay();
      const output = new Uint8Array(1);
      expect(inherited.tryRead([output])).toBe(1);
      expect(output[0]).toBe(120);
      if (index % 2) f.supervisor.kill(pid, 9);
      else context.exit(0);
      const result = await f.supervisor.waitForExit(f.root, pid);
      expect(result.kind).toBe(index % 2 ? "signaled" : "exited");
      expect(f.supervisor.wait(f.root, pid)).not.toBeNull();
      expect(f.supervisor.waitJob(f.root, job)).not.toBeNull();
      expect(f.supervisor.get(pid)).toBeUndefined();
      expect(stale.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.BADF);
      expect(f.pipe.resourceUsage).toMatchObject({
        backingBytes: 4982576,
        activeReaders: 1,
        activeWriters: 1,
      });
    }
    expect(f.writer.tryWrite([byte])).toBe(1);
    expect(f.reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    f.pipe.pumpRelay();
    expect(f.reader.tryRead([new Uint8Array(1)])).toBe(1);
  } finally {
    f.dispose();
  }
});
