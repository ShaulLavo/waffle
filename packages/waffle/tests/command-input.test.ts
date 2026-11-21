import { expect, test } from "bun:test";
import { CommandInput } from "../browser/command-input.js";
import { PipeController } from "../proc/pipes.js";

test("command stdin yields to a task while the source produces only empty chunks", async () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(2, "write");
  let pulls = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      timer ??= setTimeout(stop.resolve, 0);
      controller.enqueue(new Uint8Array(0));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const errors: unknown[] = [];
  const input = new CommandInput(writer, source, (error) => errors.push(error));
  try {
    await stop.promise;
    expect(pulls).toBeGreaterThan(1);
    await input.stop();
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
    expect(writer.live).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await input.stop();
    clearTimeout(timer);
    reader.close();
    pipe.dispose();
  }
});
