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

test("a pending yield keeps Node alive and an idle one does not", async () => {
  const module = new URL("../browser/yield-task.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `const { yieldTask } = await import(${JSON.stringify(module)});
       for (let index = 0; index < 3; index++) await yieldTask();
       console.log("done");`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: "done", stderr: "" });
});

test("yieldTask lets a timer due now run between yields", async () => {
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 0);
  for (let index = 0; index < 10_000 && !fired; index++) await yieldTask();
  expect(fired).toBe(true);
});
