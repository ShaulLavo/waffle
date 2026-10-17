import { expect, test } from "bun:test";
import { runForeground, stopForeground, type ForegroundPage } from "./foreground.ts";

function fixture(stopAfter: number, running = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "playground");
  const signals: string[] = [];
  const commands: string[] = [];
  const waits: number[] = [];
  let code = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let drain: Promise<void> | undefined;
  let onWait = () => {};
  const shell = {
    get running() { return running; },
    get lastExit() { return code; },
    input(data: string) {
      signals.push(data);
      if (signals.length === stopAfter && !drain) {
        running = false;
        code = stopAfter === 1 ? 130 : 137;
        finish();
      }
    },
    async submit(command: string) {
      commands.push(command);
      if (!running) return;
      await done;
    },
  };
  Object.defineProperty(globalThis, "playground", { configurable: true, value: { shell } });
  const page: ForegroundPage = {
    async evaluate(callback, argument) { return await callback(argument); },
    async waitForFunction(callback, _argument, options) {
      waits.push(options.timeout);
      onWait();
      await drain;
      if (!callback()) throw new Error("foreground is still running");
    },
  };
  return {
    page, shell, signals, commands, waits,
    delayCompletion() {
      let release!: () => void;
      drain = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { onWait = resolve; });
      return { waiting, release() { running = false; finish(); release(); } };
    },
    restore() {
      running = false;
      finish();
      if (previous) Object.defineProperty(globalThis, "playground", previous);
      else Reflect.deleteProperty(globalThis, "playground");
    },
  };
}

test("foreground teardown explicitly forces a process that ignores its first interrupt", async () => {
  const state = fixture(2);
  try {
    await stopForeground(state.page);
    expect(state.signals).toEqual(["\x03", "\x03"]);
    expect(state.shell.running).toBe(false);
    expect(state.waits).toEqual([15000]);
  } finally { state.restore(); }
});

test("foreground teardown waits for actual asynchronous completion", async () => {
  const state = fixture(2);
  const completion = state.delayCompletion();
  let settled = false;
  const stopped = stopForeground(state.page, 321).then(() => { settled = true; });
  try {
    await completion.waiting;
    expect(state.signals).toEqual(["\x03", "\x03"]);
    expect(state.shell.running).toBe(true);
    expect(settled).toBe(false);
    expect(state.waits).toEqual([321]);
  } finally {
    completion.release();
    await stopped;
    state.restore();
  }
  expect(settled).toBe(true);
});

test("foreground teardown does not signal an idle shell", async () => {
  const state = fixture(2, false);
  try {
    await stopForeground(state.page);
    expect(state.signals).toEqual([]);
  } finally { state.restore(); }
});

test("foreground teardown does not force a synchronously completed interrupt", async () => {
  const state = fixture(1);
  try {
    await stopForeground(state.page);
    expect(state.signals).toEqual(["\x03"]);
    expect(state.shell.lastExit).toBe(130);
  } finally { state.restore(); }
});

test("foreground teardown reports failure if forceful cleanup never finishes", async () => {
  const state = fixture(Infinity);
  try {
    await expect(stopForeground(state.page, 7)).rejects.toThrow("foreground is still running");
    expect(state.signals).toEqual(["\x03", "\x03"]);
    expect(state.waits).toEqual([7]);
  } finally { state.restore(); }
});

test("timed-out commands force cleanup without replacing the timeout result", async () => {
  const state = fixture(2);
  try {
    const result = await runForeground(state.page, "bun run forever.ts", 0);
    expect(result.code).toBeNull();
    expect(state.commands).toEqual(["bun run forever.ts"]);
    expect(state.signals).toEqual(["\x03", "\x03"]);
    expect(state.shell.running).toBe(false);
    expect(state.waits).toEqual([15000]);
  } finally { state.restore(); }
});

test("completed commands retain their own exit code without cleanup signals", async () => {
  const state = fixture(1);
  try {
    state.shell.input("\x03");
    state.signals.length = 0;
    const result = await runForeground(state.page, "bun run handled.ts", 1000);
    expect(result.code).toBe(130);
    expect(state.signals).toEqual([]);
    expect(state.waits).toEqual([]);
  } finally { state.restore(); }
});
