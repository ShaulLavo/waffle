import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { rewriteInterrupts } from "../interrupt/rewriter.js";
import {
  createSupervisedWaitImports,
  readWaitRegistration,
  WAIT_REGISTRATION_WORDS,
} from "../interrupt/wait.js";
import { claimOutcome, outcomeWord } from "../proc/outcome.js";
import { interruptWaitFixture } from "./fixtures/interrupt-wait-wasm.js";
import type { WaitWorkerInput } from "./fixtures/interrupt-wait-worker.js";
import {
  interruptFixtureMemory,
  interruptLoopFixture,
} from "./fixtures/interrupt-browser-loops.js";

type Reply =
  | { kind: "returned"; result: number; checks: number }
  | { kind: "trapped"; native: boolean; checks: number };
function input(width: 4 | 8 = 4, offset = 0): WaitWorkerInput {
  return {
    bytes: rewriteInterrupts(interruptWaitFixture({ width, offset }), {
      profile: "supervised-thread",
      interval: 1,
    }),
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
    registration: new Int32Array(new SharedArrayBuffer(WAIT_REGISTRATION_WORDS * 4)),
    outcome: outcomeWord(),
    gate: new Int32Array(new SharedArrayBuffer(8)),
    address: 8,
    expected: width === 4 ? 0 : 0n,
    timeout: -1n,
    entry: "run",
  };
}

async function withWorker(
  config: WaitWorkerInput,
  use?: (reply: Promise<Reply>) => Promise<void>,
): Promise<Reply> {
  let child: Worker | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let exited: Promise<number> | undefined;
  let completed = false;
  try {
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("owned wait Worker deadline")), 5000);
    });
    child = new Worker(new URL("./fixtures/interrupt-wait-worker.ts", import.meta.url), {
      workerData: config,
    });
    const worker = child;
    exited = new Promise((resolve) => worker.once("exit", resolve));
    const reply = Promise.race([
      expired,
      new Promise<Reply>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      }),
    ]);
    if (use) await Promise.race([use(reply), expired]);
    const result = await reply;
    completed = true;
    return result;
  } finally {
    clearTimeout(deadline);
    Atomics.store(config.gate, 1, 1);
    Atomics.notify(config.gate, 1);
    if (!completed) claimOutcome(config.outcome, { kind: "signaled", code: 9 });
    const wake = () => {
      const registration = readWaitRegistration(config.registration);
      if (registration)
        Atomics.notify(new Int32Array(config.memory.buffer), registration.address / 4);
    };
    const notifier = setInterval(wake, 10);
    try {
      wake();
      if (child) await child.terminate();
      if (exited) await exited;
      if (child) expect(child.threadId).toBe(-1);
    } finally {
      clearInterval(notifier);
    }
  }
}
async function until<T>(read: () => T | null, reply: Promise<unknown>): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== null) return value;
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 1)),
      reply.then(() => {
        throw new Error("Worker returned before registration");
      }),
    ]);
  }
}
function notify(config: WaitWorkerInput): (address: number, count: number) => number {
  const native = new WebAssembly.Instance(new WebAssembly.Module(interruptWaitFixture()), {
    env: { memory: config.memory, value: () => 17 },
  });
  const fn = native.exports.notify;
  if (typeof fn !== "function") throw new Error("missing native notify");
  return (address, count) => fn(address, count);
}

for (const width of [4, 8] as const) {
  test(`wait${width * 8} preserves not-equal and timeout semantics`, async () => {
    for (const timeout of [0n, 1n, 2_000_000n, 9_223_372_036_854_775_807n, -1n]) {
      const config = input(width);
      config.timeout = timeout;
      config.expected = width === 4 ? -2147483648 : -9223372036854775808n;
      expect(await withWorker(config)).toMatchObject({ kind: "returned", result: 1 });
      if (timeout < 0n || timeout > 2_000_000n) continue;
      config.expected = width === 4 ? 0 : 0n;
      expect(await withWorker(config)).toMatchObject({ kind: "returned", result: 2 });
    }
  });

  test(`native Wasm notify wakes tracked wait${width * 8} at the effective address`, async () => {
    const config = input(width, width);
    const value = width === 4 ? -2147483648 : -9223372036854775808n;
    const effective = config.address + width;
    if (width === 4)
      Atomics.store(new Int32Array(config.memory.buffer), effective / 4, Number(value));
    else Atomics.store(new BigInt64Array(config.memory.buffer), effective / 8, BigInt(value));
    config.expected = value;
    config.timeout = -9223372036854775808n;
    const wake = notify(config);
    const result = await withWorker(config, async (reply) => {
      const registered = await until(() => readWaitRegistration(config.registration), reply);
      expect(registered).toEqual({ generation: 1, address: effective, width });
      expect(wake(effective, 0)).toBe(0);
      await until(() => (wake(effective, 1) === 1 ? true : null), reply);
    });
    expect(result).toMatchObject({ kind: "returned", result: 0 });
    expect(readWaitRegistration(config.registration)).toBeNull();
  });

  test(`wait${width * 8} traps bounds, alignment and unsigned address overflow in Wasm`, async () => {
    const cases: readonly [number, number][] = [
      [1, 0],
      [65536, 0],
      [-1, 1],
      [1, 0xffffffff],
      [65536 - width + 1, 0],
    ];
    for (const [address, offset] of cases) {
      const config = input(width, offset);
      config.address = address;
      config.timeout = 0n;
      expect(await withWorker(config)).toMatchObject({ kind: "trapped", native: true });
      expect(readWaitRegistration(config.registration)).toBeNull();
    }
  });

  test(`terminal races around wait${width * 8} cannot return to guest code`, async () => {
    const config = input(width);
    const wake = notify(config);
    config.race = "before-native";
    expect(
      await withWorker(config, async (reply) => {
        await until(() => (Atomics.load(config.gate, 0) === 1 ? true : null), reply);
        claimOutcome(config.outcome, { kind: "exited", code: 0 });
        expect(wake(config.address, 1)).toBe(0);
        Atomics.store(config.gate, 1, 1);
        Atomics.notify(config.gate, 1);
        await until(() => (wake(config.address, 1) === 1 ? true : null), reply);
      }),
    ).toMatchObject({ kind: "trapped", native: true });
    expect(readWaitRegistration(config.registration)).toBeNull();

    const returned = input(width);
    returned.timeout = 0n;
    returned.race = "after-native";
    expect(await withWorker(returned)).toMatchObject({ kind: "trapped", native: true });
    expect(readWaitRegistration(returned.registration)).toBeNull();
  });
}

test("start section, direct calls, indirect calls and ref.func remap past all private imports", async () => {
  const config = input(8);
  config.bytes = rewriteInterrupts(interruptWaitFixture({ width: 8, start: true }), {
    profile: "supervised-thread",
  });
  config.expected = 1n;
  for (const entry of ["run", "direct", "indirect"]) {
    config.entry = entry;
    expect(await withWorker(config)).toMatchObject({ kind: "returned", result: 1, checks: 4 });
  }
  const guest = new WebAssembly.Instance(new WebAssembly.Module(config.bytes), {
    env: { memory: config.memory, value: () => 17 },
    runtime_proc: {
      __waffle_fatal: () => 0,
      ...createSupervisedWaitImports(config.memory, config.registration, () => 0),
    },
  });
  const ref = guest.exports.reference;
  expect(ref).toBeInstanceOf(WebAssembly.Global);
  if (!(ref instanceof WebAssembly.Global) || typeof ref.value !== "function")
    throw new Error("missing ref.func");
  expect(ref.value(0, 1n, 0n)).toBe(1);
  expect(typeof guest.exports.value === "function" && guest.exports.value()).toBe(17);
});

test("sentinel traps bypass guest catch_all while JS-thrown RuntimeError is catchable", () => {
  const bytes = rewriteInterrupts(interruptWaitFixture({ catchTrap: true }), {
    profile: "supervised-thread",
  });
  const config = input();
  function run(
    callback: (address: number, expected: number, timeout: bigint, offset: number) => number,
  ) {
    const guest = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
      env: { memory: config.memory, value: () => 17 },
      runtime_proc: {
        __waffle_fatal: () => 0,
        __waffle_wait32: callback,
        __waffle_wait64: callback,
      },
    });
    const fn = guest.exports.run;
    if (typeof fn !== "function") throw new Error("missing guarded wait");
    return fn(1, 0, 0n);
  }
  expect(
    run(() => {
      throw new WebAssembly.RuntimeError("host exception");
    }),
  ).toBe(99);
  expect(() => run(() => -1)).toThrow(WebAssembly.RuntimeError);
  const callbacks = createSupervisedWaitImports(config.memory, config.registration, () => 0);
  expect(() => run(callbacks.__waffle_wait32)).toThrow(WebAssembly.RuntimeError);
});

test("captured wait callbacks ignore guest replacements of native Atomics methods", async () => {
  const config = input();
  config.poison = true;
  config.timeout = 0n;
  expect(await withWorker(config)).toMatchObject({ kind: "returned", result: 2 });
});

test("CPU checkpoints stop on selected ordinary exit zero", async () => {
  const config = input();
  config.memory = interruptFixtureMemory();
  config.bytes = rewriteInterrupts(interruptLoopFixture(), {
    profile: "supervised-thread",
    interval: 1,
  });
  config.entry = "tight-backedge";
  expect(
    await withWorker(config, async (reply) => {
      await until(
        () => (Atomics.load(new Int32Array(config.memory.buffer), 0) > 0 ? true : null),
        reply,
      );
      claimOutcome(config.outcome, { kind: "exited", code: 0 });
    }),
  ).toMatchObject({ kind: "trapped", native: true });
});

test("a selected result after publication prevents entering the native wait", async () => {
  const config = input();
  config.bytes = rewriteInterrupts(interruptWaitFixture(), { profile: "supervised-thread" });
  claimOutcome(config.outcome, { kind: "exited", code: 0 });
  expect(await withWorker(config)).toEqual({ kind: "trapped", native: true, checks: 2 });
  expect(readWaitRegistration(config.registration)).toBeNull();
});

async function notifyPair(
  first: WaitWorkerInput,
  second: WaitWorkerInput,
  reply32: Promise<Reply>,
) {
  const wake = notify(first);
  await until(() => readWaitRegistration(first.registration), reply32);
  const result = await withWorker(second, async (reply64) => {
    await until(() => readWaitRegistration(second.registration), reply64);
    let woken = 0;
    await until(
      () => {
        woken += wake(first.address, 1);
        return woken === 2 ? true : null;
      },
      Promise.all([reply32, reply64]),
    );
    expect(woken).toBe(2);
  });
  expect(result).toMatchObject({ kind: "returned", result: 0 });
}

test("one native notify queue covers simultaneous wait32 and wait64 sleepers", async () => {
  const first = input(),
    second = input(8);
  second.memory = first.memory;
  const result = await withWorker(first, (reply32) => notifyPair(first, second, reply32));
  expect(result).toMatchObject({ kind: "returned", result: 0 });
});

test("registration generations advance and clear before the final terminal recheck", () => {
  const config = input();
  const observed: (number | null)[] = [];
  const imports = createSupervisedWaitImports(config.memory, config.registration, () => {
    observed.push(readWaitRegistration(config.registration)?.generation ?? null);
    return 0;
  });
  expect(imports.__waffle_wait32(0, 0, 0n, 0)).toBe(2);
  expect(imports.__waffle_wait64(0, 0n, 0n, 8)).toBe(2);
  expect(observed).toEqual([1, null, 2, null]);
  expect(readWaitRegistration(config.registration)).toBeNull();
  expect(() =>
    createSupervisedWaitImports(config.memory, new Int32Array(config.memory.buffer, 0, 3), () => 0),
  ).toThrow(/guest-writable/);
});

for (const width of [4, 8] as const) {
  test(`a huge positive wait${width * 8} timeout stays parked until native notify`, async () => {
    const config = input(width);
    config.timeout = 9223372036854775807n;
    const wake = notify(config);
    expect(
      await withWorker(config, async (reply) => {
        await until(() => readWaitRegistration(config.registration), reply);
        await until(() => (wake(config.address, 1) === 1 ? true : null), reply);
      }),
    ).toMatchObject({ kind: "returned", result: 0 });
  });
}
