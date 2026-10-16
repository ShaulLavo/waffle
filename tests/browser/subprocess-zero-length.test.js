import { expect, spyOn, test } from "bun:test";
import { SharedPipe, createProcessBudget } from "../src/subprocess.js";

for (const buffered of [false, true]) {
  for (const closed of [false, true]) {
    test(`zero-length pipe reads preserve state (buffered=${buffered}, closed=${closed})`, () => {
      const pipe = new SharedPipe(undefined, createProcessBudget());
      const bytes = new TextEncoder().encode("buffered bytes");
      if (buffered) pipe.write(bytes);
      if (closed) pipe.close();
      const before = Array.from(pipe.cells);
      expect(pipe.read(0)).toBe(0);
      expect(Array.from(pipe.cells)).toEqual(before);
      expect(pipe.read()).toEqual(buffered ? bytes : closed ? 0 : -2);
    });
  }
}

test("blocking zero-length pipe reads never wait", () => {
  const pipe = new SharedPipe(undefined, createProcessBudget());
  const wait = spyOn(Atomics, "wait").mockImplementation(() => { throw new Error("zero-byte read waited"); });
  try {
    expect(pipe.readBlocking(0)).toBe(0);
    expect(wait).not.toHaveBeenCalled();
  } finally {
    wait.mockRestore();
  }
});

for (const full of [false, true]) {
  test(`zero-length writes on an open pipe preserve state (full=${full})`, () => {
    const pipe = new SharedPipe(undefined, createProcessBudget());
    const bytes = new Uint8Array(pipe.bytes.length).fill(42);
    if (full) expect(pipe.write(bytes)).toBe(bytes.length);
    const before = Array.from(pipe.cells);
    expect(pipe.write(new Uint8Array())).toBe(0);
    expect(Array.from(pipe.cells)).toEqual(before);
    expect(pipe.read(bytes.length)).toEqual(full ? bytes : -2);
  });
}
