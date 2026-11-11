import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { metadataWorker } from "./fixtures/metadata-enumeration-r173-service.js";
import type { linkLifecycle } from "./fixtures/metadata-enumeration-r173-wasi.js";

const NativeWorker = globalThis.Worker;
class ObservedMetadataWorker extends NativeWorker {
  constructor(_url: string | URL, options?: WorkerOptions) {
    super(new URL("./fixtures/metadata-completion-observer-worker.ts", import.meta.url), options);
  }
}

test("metadata Worker releases both clients before publishing the result", async () => {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/sandbox/file", "retained data");
  globalThis.Worker = ObservedMetadataWorker;
  try {
    const result = await metadataWorker<{
      value: ReturnType<typeof linkLifecycle>;
      disposedBeforeResult: number;
    }>(backend, { scenario: "links", root: "/sandbox" });
    expect(result.disposedBeforeResult).toBe(2);
    expect(result.value).not.toHaveProperty("error");
    expect(result.value.contents).toBe("retained data");
    expect(result.value.stats.map((entry) => entry.nlink)).toEqual([1n, 2n, 1n]);
  } finally {
    globalThis.Worker = NativeWorker;
  }
});
