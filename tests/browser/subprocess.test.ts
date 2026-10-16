import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MemFS } from "../src/fs";
import { SharedPipe, SubprocessHost, childTransport, createProcessBudget, wasiPipe, type ChildTransport } from "../src/subprocess.js";
import { filesystemChanges, filesystemSync, mergeFilesystemChanges } from "../src/subprocess-fs";

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

test("host stdin reads wait without blocking and preserve EOF on both bridges", () => {
  const budget = createProcessBudget();
  const pipe = new SharedPipe(undefined, budget);
  const host = new SubprocessHost({
    budget, stdin: pipe.buffer, output() {},
    launch() { throw new Error("this test does not spawn"); },
  });
  try {
    const native = host.engineNet().natives;
    expect(native.hostRead(0, 4)).toBe(-2);
    pipe.write(encoder.encode("ping"));
    expect(native.hostRead(0, 4)).toEqual(encoder.encode("ping"));
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.attach(memory);
    const slots = host.slots();
    expect(slots.read?.(0, 32, 4)).toBe(-2);
    pipe.write(encoder.encode("pong"));
    expect(slots.read?.(0, 32, 4)).toBe(4);
    expect(new Uint8Array(memory.buffer, 32, 4)).toEqual(encoder.encode("pong"));
    pipe.close();
    expect(native.hostRead(0, 4)).toBe(0);
    expect(slots.read?.(0, 32, 4)).toBe(0);
  } finally { pipe.close(); host.dispose(); }
});

test("stdin wakes host-engine waiters without spawning another child", async () => {
  const budget = createProcessBudget();
  const pipe = new SharedPipe(undefined, budget);
  const host = new SubprocessHost({
    budget, stdin: pipe.buffer, output() {},
    launch() { throw new Error("this test does not spawn"); },
  });
  try {
    const net = host.engineNet();
    expect(net.natives.hostRead(0, 4)).toBe(-2);
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("stdin waiter was not woken")), 250);
      net.onNews(() => { clearTimeout(deadline); resolve(); });
      pipe.write(encoder.encode("ping"));
    });
    expect(net.natives.hostRead(0, 4)).toEqual(encoder.encode("ping"));
  } finally { pipe.close(); host.dispose(); }
});

test("live child filesystem changes precede stdin and stdout without waiting for exit", () => {
  const parent = new MemFS();
  parent.writeFile("/seed", "before");
  const launched: { transport: ChildTransport; fs: MemFS }[] = [];
  const host = new SubprocessHost({
    filesystem: () => filesystemSync(parent), output() {},
    launch(_meta, transport) {
      launched.push({ transport, fs: new MemFS(structuredClone(parent.root)) });
      return { terminate() {} };
    },
  });
  try {
    const id = host.spawn(childCommand);
    const info = launched[0];
    const child = childTransport(info.transport);
    const files = filesystemSync(info.fs);
    parent.writeFile("/entry.ts", "export default 42");
    host.write(host.pipe(id, 0), encoder.encode("build"));
    parent.writeFile("/next.ts", "next");
    expect(host.write(host.pipe(id, 0), encoder.encode("queued"))).toBe(-2);
    expect(child.stdin.read()).toEqual(encoder.encode("build"));
    const incoming = child.receiveFilesystem();
    if (!incoming) throw new Error("parent changes were not published");
    files.merge(incoming);
    expect(decoder.decode(info.fs.readFile("/entry.ts"))).toBe("export default 42");
    expect(host.write(host.pipe(id, 0), encoder.encode("queued"))).toBe(6);
    child.stdin.read();
    const queued = child.receiveFilesystem();
    if (!queued) throw new Error("queued changes were not published");
    files.merge(queued);
    expect(decoder.decode(info.fs.readFile("/next.ts"))).toBe("next");
    info.fs.writeFile("/out.js", "answer=42");
    const outgoing = files.capture();
    expect(child.sendFilesystem(outgoing)).toBe(true);
    files.commit(outgoing);
    child.stdout.write(encoder.encode("built"));
    expect(host.read(host.pipe(id, 1))).toEqual(encoder.encode("built"));
    expect(decoder.decode(parent.readFile("/out.js"))).toBe("answer=42");
    expect(host.wait(id)).toBe(-2);
    expect(files.capture()).toBe("");
    parent.writeFile("/entry.ts", "export default 43");
    parent.remove("/seed");
    host.write(host.pipe(id, 0), encoder.encode("rebuild"));
    child.stdin.read();
    const updated = child.receiveFilesystem();
    if (!updated) throw new Error("parent edits were not published");
    files.merge(updated);
    expect(decoder.decode(info.fs.readFile("/entry.ts"))).toBe("export default 43");
    expect(info.fs.lookup("/seed")).toBeUndefined();
    expect(files.capture()).toBe("");
    child.finish(0, files.capture());
    expect(host.wait(id)).toBe(0);
  } finally { host.dispose(); }
});

test("idle host pumps publish edits and apply them without stdin", () => {
  const parent = new MemFS();
  parent.writeFile("/entry.ts", "before");
  let childHost: SubprocessHost | undefined;
  let childFS: MemFS | undefined;
  const host = new SubprocessHost({
    filesystem: () => filesystemSync(parent), output() {},
    launch(_meta, transport) {
      childFS = new MemFS(structuredClone(parent.root));
      const files = filesystemSync(childFS);
      const child = childTransport(transport);
      childHost = new SubprocessHost({
        budget: transport.budget, slot: transport.slot, token: transport.token,
        stdin: transport.pipes[0], output() {},
        syncFilesystem() {
          const snapshot = child.receiveFilesystem();
          if (snapshot) files.merge(snapshot);
        },
        launch() { throw new Error("this child does not spawn"); },
      });
      return { terminate() {} };
    },
  });
  try {
    host.spawn(childCommand);
    parent.writeFile("/entry.ts", "after");
    host.poll();
    childHost?.poll();
    expect(decoder.decode(childFS?.readFile("/entry.ts"))).toBe("after");
    parent.writeFile("/entry.ts", "newest");
    host.poll();
    parent.writeFile("/next.ts", "queued");
    host.poll();
    childHost?.poll();
    host.poll();
    childHost?.poll();
    expect(decoder.decode(childFS?.readFile("/entry.ts"))).toBe("newest");
    expect(decoder.decode(childFS?.readFile("/next.ts"))).toBe("queued");
  } finally { childHost?.dispose(); host.dispose(); }
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

test("WASI descriptors publish live filesystem changes before output", () => {
  const parent = new MemFS();
  let transport: ChildTransport | undefined;
  const host = new SubprocessHost({
    filesystem: () => filesystemSync(parent), output() {},
    launch(_meta, value) { transport = value; return { terminate() {} }; },
  });
  try {
    const id = host.spawn(childCommand);
    if (!transport) throw new Error("child was not launched");
    const child = childTransport(transport);
    const fs = new MemFS(structuredClone(parent.root));
    const files = filesystemSync(fs);
    const stdout = wasiPipe(child.stdout, "write", { beforeWrite() {
      const snapshot = files.capture();
      if (snapshot && child.sendFilesystem(snapshot)) files.commit(snapshot);
    } });
    fs.writeFile("/out.js", "answer=42");
    expect(stdout.write([encoder.encode("built")])).toBe(5);
    expect(host.read(host.pipe(id, 1))).toEqual(encoder.encode("built"));
    expect(decoder.decode(parent.readFile("/out.js"))).toBe("answer=42");
  } finally { host.dispose(); }
});

test("WASI descriptors apply queued filesystem changes after input", () => {
  const parent = new MemFS(); parent.writeFile("/entry.ts", "before");
  let transport: ChildTransport | undefined;
  const host = new SubprocessHost({
    filesystem: () => filesystemSync(parent), output() {},
    launch(_meta, value) { transport = value; return { terminate() {} }; },
  });
  try {
    const id = host.spawn(childCommand);
    if (!transport) throw new Error("child was not launched");
    const child = childTransport(transport);
    const fs = new MemFS(structuredClone(parent.root));
    const files = filesystemSync(fs);
    const stdin = wasiPipe(child.stdin, "read", { afterRead() {
      const snapshot = child.receiveFilesystem();
      if (snapshot) files.merge(snapshot);
    } });
    parent.writeFile("/entry.ts", "after");
    expect(host.write(host.pipe(id, 0), encoder.encode("read"))).toBe(4);
    const bytes = new Uint8Array(4);
    expect(stdin.read([bytes])).toBe(4);
    expect(bytes).toEqual(encoder.encode("read"));
    expect(decoder.decode(fs.readFile("/entry.ts"))).toBe("after");
  } finally { host.dispose(); }
});

for (const bridge of ["engine", "slots"]) {
  test(`closed child stdin preserves write errno metadata on ${bridge}`, () => {
    const state = budgetHost(createProcessBudget());
    try {
      const id = state.host.spawn(childCommand);
      const input = state.host.pipe(id, 0);
      childTransport(state.launched[0]).stdin.close();
      const memory = new WebAssembly.Memory({ initial: 1 });
      state.host.attach(memory);
      const natives = state.host.engineNet({ natives: { hostError: () => -3 }, caps: {}, onNews() {} }).natives;
      const slots = state.host.slots({ error: () => -3 });
      if (bridge === "engine") {
        expect(natives.hostWrite(input, encoder.encode("race"))).toBe(-1);
        expect(JSON.parse(natives.hostError(input))).toMatchObject({ code: "EPIPE", errno: -32, syscall: "write" });
      } else {
        new Uint8Array(memory.buffer, 0, 4).set(encoder.encode("race"));
        expect(slots.write?.(input, 0, 4)).toBe(-1);
        const size = slots.error?.(input, 64, 1024);
        expect(typeof size).toBe("number");
        expect(size).toBeGreaterThan(0);
        const error = JSON.parse(decoder.decode(new Uint8Array(memory.buffer, 64, size)));
        expect(error).toMatchObject({ code: "EPIPE", errno: -32, syscall: "write" });
      }
    } finally { state.host.dispose(); }
  });
}
