import { expect, test } from "bun:test";
import {
  attachPipeEndpoint,
  PipeController,
  PipeErrno,
  PipePublicationRegistry,
} from "../proc/pipes.js";

test("registry-backed inherited readers reuse fully recovered slots", () => {
  const registry = new PipePublicationRegistry();
  registry.registerProcess(1);
  const pipe = new PipeController({ registry, relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  const allocated = new Int32Array(registry.handle().buffer, 0, 1);
  const initial = Atomics.load(allocated, 0);
  let stale: ReturnType<typeof attachPipeEndpoint> | undefined;
  try {
    for (let pid = 2; pid < 102; pid++) {
      registry.registerProcess(pid);
      const child = attachPipeEndpoint(structuredClone(reader.forProcess(pid).handle()));
      stale ??= child;
      expect(writer.tryWrite([new Uint8Array([pid])])).toBe(1);
      const output = new Uint8Array(1);
      expect(child.tryRead([output])).toBe(-PipeErrno.AGAIN);
      pipe.pumpRelay();
      expect(child.tryRead([output])).toBe(1);
      expect(output[0]).toBe(pid);
      if (pid % 2) child.close();
      else registry.revoke(pid);
      registry.collectProcess(pid);
      expect(stale.tryRead([output])).toBe(-PipeErrno.BADF);
      expect(Atomics.load(allocated, 0)).toBe(initial + (pid - 1) * 2);
    }
    expect(writer.tryWrite([new Uint8Array([123])])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    pipe.pumpRelay();
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    writer.close();
    pipe.pumpRelay();
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    registry.collectProcess(1);
    pipe.dispose();
  }
});
