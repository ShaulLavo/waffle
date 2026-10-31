import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import {
  PipeController,
  PipeEndpoint,
  PipeErrno,
  PipePublicationRegistry,
  attachPipeEndpoint,
} from "../proc/pipes.js";
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
      await f.supervisor.start(pid);
      const context = f.context()!;
      const inherited = context.descriptors.get(1)!.resource;
      expect(inherited).toBeInstanceOf(PipeEndpoint);
      if (!(inherited instanceof PipeEndpoint)) throw new Error("missing child writer");
      stale ??= attachPipeEndpoint(structuredClone(inherited.handle()));
      expect(inherited.handle().id).toBe(f.writer.handle().id);
      expect(inherited.handle().buffer.byteLength).toBe(2622760);
      expect(inherited.tryWrite([byte])).toBe(1);
      const output = new Uint8Array(1);
      expect(attachedReader.tryRead([output])).toBe(1);
      expect(output[0]).toBe(120);
      context.exit(0);
      expect((await f.supervisor.waitForExit(f.root, pid)).kind).toBe("exited");
      expect(f.supervisor.wait(f.root, pid)?.status).toBe(0);
      expect(f.supervisor.get(pid)).toBeUndefined();
      expect(stale.tryWrite([byte])).toBe(-PipeErrno.BADF);
      expect(stale.readiness().hangup).toBe(true);
      expect(() => stale!.forProcess(99999)).toThrow();
      stale.close();
      expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
    }
    expect(f.writer.tryWrite([byte])).toBe(1);
    expect(attachedReader.tryRead([new Uint8Array(1)])).toBe(1);
    f.writer.close();
    expect(attachedReader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    f.dispose();
  }
});

test("one registry-backed worker pipe survives 3001 inherited writer identities", () => {
  const registry = new PipePublicationRegistry();
  registry.registerProcess(1);
  const pipe = new PipeController({ registry, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  const backing = registry.handle().buffer;
  const allocated = new Int32Array(backing, 0, 1);
  const initialCells = Atomics.load(allocated, 0);
  const initialBytes = backing.byteLength;
  let stale: PipeEndpoint | undefined;
  try {
    for (let index = 0; index < 3001; index++) {
      const pid = index + 2;
      registry.registerProcess(pid);
      const child = writer.forProcess(pid);
      const attached = attachPipeEndpoint(structuredClone(child.handle()));
      stale ??= attached;
      expect(attached.tryWrite([byte])).toBe(1);
      expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
      if (index % 2 === 0) attached.close();
      else registry.revoke(pid);
      registry.collectProcess(pid);
      expect(stale.tryWrite([byte])).toBe(-PipeErrno.BADF);
      expect(attached.handle().buffer.byteLength).toBe(2622760);
      expect(backing.byteLength).toBe(initialBytes);
      // One publication cell per child. A fresh direct writer also binds a reader lease.
      const fresh = Math.min(index + 1, 15);
      expect(Atomics.load(allocated, 0)).toBe(initialCells + index + 1 + fresh);
      expect(registry.processCount).toBe(1);
    }
    expect(writer.tryWrite([byte])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    writer.close();
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    registry.collectProcess(1);
    pipe.dispose();
  }
});
