import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MemFS } from "../src/fs";
import { SharedPipe, createProcessBudget } from "../src/subprocess.js";
import { filesystemChanges, mergeFilesystemChanges } from "../src/subprocess-fs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("shared child pipes preserve bytes across wrap, capacity and EOF", () => {
  const pipe = new SharedPipe(undefined, createProcessBudget());
  const data = new Uint8Array(800000).fill(42);
  expect(pipe.write(data)).toBe(800000);
  expect(pipe.read(750000)).toEqual(data.subarray(0, 750000));
  expect(pipe.write(data)).toBe(800000);
  expect(pipe.write(data)).toBe(198576);
  expect(pipe.write(data)).toBe(-2);
  const rest = pipe.read(2000000);
  expect(rest instanceof Uint8Array && rest.length).toBe(1048576);
  expect(pipe.read()).toBe(-2);
  pipe.close();
  expect(pipe.read()).toBe(0);
  expect(pipe.write(encoder.encode("closed"))).toBe(-1);
});

test("child filesystem deltas merge created, changed and deleted paths", () => {
  const parent = new MemFS();
  parent.writeFile("/same", "initial");
  parent.writeFile("/delete", "initial");
  parent.writeFile("/changed", "initial");
  const before = structuredClone(parent.root);
  const child = new MemFS(structuredClone(before));
  child.writeFile("/changed", "child");
  child.writeFile("/new/deep/file", "new");
  child.remove("/delete");
  parent.writeFile("/same", "parent update");
  parent.writeFile("/parent-only", "parent");
  mergeFilesystemChanges(parent, filesystemChanges(before, child.root));
  expect(decoder.decode(parent.readFile("/same"))).toBe("parent update");
  expect(decoder.decode(parent.readFile("/changed"))).toBe("child");
  expect(decoder.decode(parent.readFile("/new/deep/file"))).toBe("new");
  expect(decoder.decode(parent.readFile("/parent-only"))).toBe("parent");
  expect(parent.lookup("/delete")).toBeUndefined();
});

test.skipIf(!existsSync(new URL("../../dist/bun-browser.wasm", import.meta.url)))("fresh wasm subprocess workers support pipes, exit, kill and bounds", () => {
  const result = Bun.spawnSync(["node", "--no-warnings", new URL("./subprocess.mjs", import.meta.url).pathname]);
  expect(decoder.decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(decoder.decode(result.stdout)).toBe("9 subprocess worker checks passed\n");
});
