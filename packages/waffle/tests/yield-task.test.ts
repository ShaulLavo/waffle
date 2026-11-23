import { expect, test } from "bun:test";
import { yieldTask } from "../browser/yield-task.js";

test("yieldTask resumes waiters in order after pending microtasks", async () => {
  const order: string[] = [];
  const first = yieldTask().then(() => order.push("first"));
  const second = yieldTask().then(() => order.push("second"));
  void Promise.resolve().then(() => order.push("microtask"));
  await Promise.all([first, second]);
  expect(order).toEqual(["microtask", "first", "second"]);
});

test("yieldTask lets a timer due now run between yields", async () => {
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 0);
  for (let index = 0; index < 10_000 && !fired; index++) await yieldTask();
  expect(fired).toBe(true);
});
