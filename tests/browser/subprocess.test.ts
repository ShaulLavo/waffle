import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SharedPipe, SubprocessHost, childTransport, createProcessBudget, type ChildTransport } from "../src/subprocess.js";

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
