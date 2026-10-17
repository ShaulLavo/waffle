import { expect, spyOn, test } from "bun:test";
import { SharedPipe, createProcessBudget } from "../src/subprocess.ts";

test("a final write racing an empty read cannot publish EOF before its bytes", () => {
  const pipe = new SharedPipe(undefined, createProcessBudget());
  const data = new TextEncoder().encode("last bytes");
  const load = Atomics.load;
  let published = false;
  // Schedule the writer immediately after the reader snapshots the write index.
  const loads = spyOn(Atomics, "load").mockImplementation((cells, index) => {
    const value = load(cells, index);
    if (cells === pipe.cells && index === 1 && !published) {
      published = true;
      pipe.write(data);
      pipe.close();
    }
    return value;
  });
  let first;
  try { first = pipe.read(); }
  finally { loads.mockRestore(); }
  expect(first).not.toBe(0);
  expect(first === -2 ? pipe.read() : first).toEqual(data);
  expect(pipe.read()).toBe(0);
});
