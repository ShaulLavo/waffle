import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import {
  assertWorkspaceQuiescent,
  workspaceEnduranceFixture,
  workspaceOwnership,
} from "./fixtures/workspace-endurance";

const CYCLES = 16;

test(`bounded public range reads release ownership after ${CYCLES} cycles`, async () => {
  const value = await workspaceEnduranceFixture();
  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const offset = cycle % PAGE;
      const read = await value.workspace.read("/file", { offset, length: PAGE + 17 });
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") {
        expect(read.value.range).toEqual({ offset, length: PAGE + 17 });
        expect(read.value.bytes).toEqual(new Uint8Array(PAGE + 17).fill(65));
      }
      assertWorkspaceQuiescent(value, value.baseline);
    }
  } finally {
    await value.close();
  }
});

test(`bounded public leases release retained ownership after ${CYCLES} cycles`, async () => {
  const value = await workspaceEnduranceFixture();
  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const opened = await value.workspace.pin("/file");
      expect(opened.kind).toBe("ok");
      if (opened.kind !== "ok") continue;
      const read = await opened.value.read({ offset: cycle % PAGE, length: PAGE + 17 });
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") {
        expect(read.value.range).toEqual({ offset: cycle % PAGE, length: PAGE + 17 });
        expect(read.value.bytes).toEqual(new Uint8Array(PAGE + 17).fill(65));
      }
      await opened.value.close();
      assertWorkspaceQuiescent(value, value.baseline);
    }
  } finally {
    await value.close();
  }
});

test(`bounded public cancellation releases ownership after ${CYCLES} cycles`, async () => {
  const value = await workspaceEnduranceFixture();
  const submit = value.client.submit;
  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let chunkHeld = false;
      value.client.submit = function (...args) {
        const completion = submit.apply(this, args);
        if (chunkHeld || args[0] !== "publicationReadChunk") return completion;
        chunkHeld = true;
        const deliver = completion.value.bind(completion);
        completion.value = async () => {
          const bytes: unknown = await deliver();
          entered.resolve();
          await gate.promise;
          return bytes;
        };
        return completion;
      };
      const controller = new AbortController();
      const reading = value.workspace.read(
        "/file",
        { offset: cycle % PAGE, length: PAGE + 17 },
        undefined,
        controller.signal,
      );
      try {
        await entered.promise;
        const active = workspaceOwnership(value);
        expect(active.readerOperations).toBe(0);
        expect(active.readerTickets).toBe(1);
        expect(active.readerLeases).toBe(0);
        expect(active.readerPinBytes).toBe(PAGE * 2);
        expect(active.readerResultBytes).toBeGreaterThan(0);
        controller.abort();
        gate.resolve();
        expect(await reading).toEqual({ kind: "cancelled" });
        assertWorkspaceQuiescent(value, value.baseline);
      } finally {
        gate.resolve();
        await reading;
        value.client.submit = submit;
      }
    }
  } finally {
    value.client.submit = submit;
    await value.close();
  }
});
