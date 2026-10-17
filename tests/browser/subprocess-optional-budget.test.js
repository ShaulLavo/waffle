import assert from "node:assert/strict";
import { test } from "bun:test";
import { SharedPipe, createProcessBudget } from "../src/subprocess.ts";

for (const budgeted of [false, true]) {
  test(`shared pipes can write, read, wrap and close (${budgeted ? "with" : "without"} process budget)`, () => {
    const budget = budgeted ? createProcessBudget() : undefined;
    const writer = new SharedPipe(undefined, budget);
    const reader = new SharedPipe(writer.buffer, budget);
    const capacity = writer.bytes.length;
    const payload = new Uint8Array(capacity).fill(42);
    assert.equal(reader.read(), -2);
    assert.equal(writer.write(payload), capacity);
    assert.equal(writer.write(new Uint8Array([1])), -2);
    assert.deepEqual(reader.read(capacity - 2), payload.subarray(0, capacity - 2));
    writer.writeAll(new Uint8Array([3, 4, 5, 6]));
    assert.deepEqual(reader.readBlocking(6), new Uint8Array([42, 42, 3, 4, 5, 6]));
    const beforeClose = Atomics.load(writer.cells, 3);
    writer.close();
    assert.equal(Atomics.load(writer.cells, 3), beforeClose + 1);
    assert.equal(reader.read(), 0);
    assert.equal(writer.write(new Uint8Array([1])), -1);
    if (budget) assert.equal(Atomics.load(new Int32Array(budget), 1), 3);
  });

  test(`closing an empty pipe wakes readers (${budgeted ? "with" : "without"} process budget)`, () => {
    const pipe = new SharedPipe(undefined, budgeted ? createProcessBudget() : undefined);
    pipe.close();
    assert.equal(pipe.readBlocking(1), 0);
    assert.equal(Atomics.load(pipe.cells, 3), 1);
  });
}
