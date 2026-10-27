import { expect, test } from "bun:test";
import { PipeController, attachPipeEndpoint } from "../proc/pipes.js";

test("pipe open-description flags survive inheritance, duplication and structured cloning", () => {
  const pipe = new PipeController({ relay: "manual" });
  try {
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(1, "write");
    const inherited = writer.forProcess(2),
      duplicate = pipe.duplicate(writer);
    const transferred = attachPipeEndpoint(structuredClone(inherited.handle()));
    writer.fdflags = 4;
    expect(reader.fdflags).toBe(0);
    expect(inherited.fdflags).toBe(4);
    expect(duplicate.fdflags).toBe(4);
    expect(transferred.fdflags).toBe(4);
    transferred.fdflags = 0;
    expect(writer.fdflags).toBe(0);
    duplicate.fdflags = 4;
    expect(writer.fdflags).toBe(4);
    expect(inherited.fdflags).toBe(4);
    inherited.close();
    duplicate.close();
    writer.close();
    reader.close();
  } finally {
    pipe.dispose();
  }
});
