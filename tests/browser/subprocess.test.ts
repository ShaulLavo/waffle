import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MemFS } from "../src/fs";
import { SharedPipe, SubprocessHost, childTransport, createProcessBudget, type ChildTransport } from "../src/subprocess.js";
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

const childCommand = JSON.stringify({ argv: ["bun", "-e", "0"] });

function budgetHost(budget: SharedArrayBuffer, parent?: ChildTransport) {
  const launched: ChildTransport[] = [];
  const host = new SubprocessHost({
    budget, slot: parent?.slot, token: parent?.token,
    output() {},
    launch(_meta, transport) {
      launched.push(transport);
      return { terminate() {} };
    },
  });
  return { host, launched };
}

test("a terminated parent cannot spawn through a reused parent slot", () => {
  const budget = createProcessBudget();
  const root = budgetHost(budget);
  const parent = root.host.spawn(childCommand);
  const stale = budgetHost(budget, root.launched[0]);
  try {
    root.host.kill(parent, 9);
    expect(root.host.spawn(childCommand)).toBeGreaterThan(0);
    expect(root.launched[1]?.slot).toBe(root.launched[0]?.slot);
    expect(root.launched[1]?.token).not.toBe(root.launched[0]?.token);
    expect(stale.host.spawn(childCommand)).toBe(-1);
    expect(stale.launched).toHaveLength(0);
    const replacement = budgetHost(budget, root.launched[1]);
    try { expect(replacement.host.spawn(childCommand)).toBeGreaterThan(0); }
    finally { replacement.host.dispose(); }
  } finally {
    stale.host.dispose();
    root.host.dispose();
  }
});

test("late completion cannot release a reused child slot or its descendants", () => {
  const budget = createProcessBudget();
  const root = budgetHost(budget);
  const parent = root.host.spawn(childCommand);
  const stale = budgetHost(budget, root.launched[0]);
  const oldChild = stale.host.spawn(childCommand);
  try {
    root.host.kill(parent, 9);
    root.host.spawn(childCommand);
    root.host.spawn(childCommand);
    const reused = root.launched[2];
    expect(reused?.slot).toBe(stale.launched[0]?.slot);
    const replacement = budgetHost(budget, reused);
    try {
      expect(replacement.host.spawn(childCommand)).toBeGreaterThan(0);
      const old = stale.launched[0];
      if (!old) throw new Error("old child was not launched");
      childTransport(old).finish(0);
      const before = Array.from(new Int32Array(budget));
      expect(stale.host.wait(oldChild)).toBe(0);
      expect(Array.from(new Int32Array(budget))).toEqual(before);
      expect(root.host.spawn(childCommand)).toBeGreaterThan(0);
      expect(root.host.spawn(childCommand)).toBe(-1);
    } finally { replacement.host.dispose(); }
  } finally {
    stale.host.dispose();
    root.host.dispose();
  }
});

for (const replacement of [false, true]) {
  test(`child ${replacement ? "replacement" : "removal"} releases lookup-only handles and preserves open descriptions`, () => {
    const parent = new MemFS();
    parent.writeFile("/unopened", "unopened"); parent.writeFile("/opened", "original");
    const root = parent.preopen("/");
    const lookup = (name: string) => {
      const path = parent.resolve(root, name);
      if (typeof path === "number" || path.node === undefined) throw new Error("Missing fixture");
      return path.node;
    };
    const unopened = lookup("unopened"); const opened = lookup("opened");
    parent.retain(opened);
    const before = structuredClone(parent.root);
    const child = new MemFS(structuredClone(before));
    for (const path of ["/unopened", "/opened"]) {
      if (replacement) child.writeFile(path, "replacement");
      else child.remove(path);
    }
    mergeFilesystemChanges(parent, filesystemChanges(before, child.root));
    expect(() => parent.stat(unopened)).toThrow("unknown filesystem handle");
    const bytes = new Uint8Array(8);
    expect(parent.read(opened, [bytes], 0)).toBe(8);
    expect(decoder.decode(bytes)).toBe("original");
    parent.release(opened);
    expect(() => parent.stat(opened)).toThrow("unknown filesystem handle");
    if (replacement) expect(decoder.decode(parent.readFile("/opened"))).toBe("replacement");
    else expect(parent.listFiles()).toEqual([]);
  });
}

test('merged directory removal does not permit creation through a retained descendant', () => {
  const parent = new MemFS(); parent.mkdirp('/removed/descendant');
  const directory = parent.preopen('/removed/descendant'); parent.retain(directory);
  const before = structuredClone(parent.root); const child = new MemFS(structuredClone(before));
  child.remove('/removed');
  mergeFilesystemChanges(parent, filesystemChanges(before, child.root));
  const path = parent.resolve(directory, 'new');
  if (typeof path === 'number') throw new Error('Expected a resolved capability');
  expect(parent.create(path, 'file')).toEqual({ error: 44 });
  parent.release(directory);
});
