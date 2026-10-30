import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { openWorkspaceRead } from "../fs/workspace-stream.js";
import { publicReadFixture } from "./fixtures/workspace-read.js";

const CHUNK = 65536;

function memory(size = CHUNK * 3 + 17) {
  const seed = new MemFS();
  seed.writeFile("/file", Uint8Array.from({ length: size }, (_, index) => index % 251));
  return publicReadFixture(new MemoryBackend(seed));
}

test("a stream pulls exact owned chunks and never prefetches", async () => {
  const fixture = memory();
  try {
    const opened = await openWorkspaceRead(fixture.workspace, "/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    const sizes: number[] = [];
    for (;;) {
      const step = await opened.value.next();
      if (step.kind === "end") break;
      if (step.kind !== "chunk") throw new Error(step.kind);
      expect(step.bytes.buffer.byteLength).toBe(step.bytes.length);
      sizes.push(step.bytes.length);
    }
    expect(sizes).toEqual([CHUNK, CHUNK, CHUNK, 17]);
    await opened.value.close();
    expect(fixture.service.resources().readerLeases).toBe(0);
  } finally {
    await fixture.close();
  }
});
