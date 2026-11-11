import { expect, test } from "bun:test";
import { PipeController, attachPipeEndpoint } from "../proc/pipes.js";
import { createSharedControlAllocator, consumedControlBytes } from "../memory/control.js";
import { ProcessError } from "../proc/errors.js";

test("the real pipe constructor and inherited endpoint controls enforce their realm byte grant", () => {
  const grant = { kind: "bounded" as const, state: new SharedArrayBuffer(8), limit: 900 };
  const allocateShared = createSharedControlAllocator(grant, () => {});
  const controller = new PipeController({
    capacity: 8,
    maxReaders: 2,
    maxWriters: 2,
    relay: "manual",
    allocateShared,
  });
  const read = controller.retain(1, "read"),
    write = controller.retain(1, "write");
  const inherited = attachPipeEndpoint(structuredClone(write.handle()), { allocateShared });
  const duplicate = inherited.forProcess(2);
  expect(consumedControlBytes(grant)).toBeGreaterThan(744);
  expect(
    () =>
      new PipeController({
        capacity: 8,
        maxReaders: 2,
        maxWriters: 2,
        relay: "manual",
        allocateShared,
      }),
  ).toThrow(ProcessError);
  expect(consumedControlBytes(grant)).toBeLessThanOrEqual(grant.limit);
  duplicate.close();
  inherited.close();
  write.close();
  read.close();
  controller.dispose();
});
