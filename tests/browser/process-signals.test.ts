import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createNodeSignalController } from "../scripts/node-signals.ts";

const eventsSource = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/events.js", import.meta.url), "utf8");
const processSource = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/process.js", import.meta.url), "utf8");

class GuestExit extends Error {
  constructor(readonly code: number) { super(`guest exit ${code}`); }
}

function fixture() {
  const dispositions = new Map<number, number>();
  const pending = new Set<number>();
  const changes: number[][] = [];
  const ticks: (() => void)[] = [];
  const writes: unknown[][] = [];
  let writeError: Error | undefined;
  let selected: { status: number; signal: number } | undefined;
  const context = createContext({ TextEncoder, TextDecoder, Uint8Array, Error });
  const internal = {
    native: {
      platformInfo: { version: "test", revision: "test", arch: "wasm32" },
      env: () => ({}), argv: () => ["bun"], cwd: () => "/", isatty: () => false,
      writeStdout(...args: unknown[]) { writes.push(args); if (writeError) throw writeError; }, writeStderr() {},
      exit(code: number): never { throw new GuestExit(code); },
      hostSignal(signal: number, mode: number) {
        if (signal === 0) {
          const next = pending.values().next();
          if (next.done) return 0;
          pending.delete(next.value);
          return next.value;
        }
        // The JS runtime publishes Node's SIGPIPE=IGNORE default during construction;
        // keep the mutation log focused on test actions below.
        if (!(signal === 13 && mode === 1 && !dispositions.has(signal))) changes.push([signal, mode]);
        if (mode === 3) {
          const disposition = signal === 9 ? 0 : dispositions.get(signal) ?? 0;
          if (disposition === 2) pending.add(signal);
          else if (disposition === 0) {
            selected = { status: 128 + signal, signal };
            throw new GuestExit(128 + signal);
          }
          return 0;
        }
        if (signal === 9) return -22;
        dispositions.set(signal, mode);
        if (mode !== 2 && pending.delete(signal) && mode === 0) selected = { status: 128 + signal, signal };
        return 0;
      },
    },
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]) { ticks.push(() => callback(...args)); },
    emitExit() {},
    traceExit() {},
    require(name: string) {
      if (name === "events") return events;
      throw new Error(`unexpected polyfill ${name}`);
    },
    pumpSignals: undefined as undefined | (() => boolean),
  };
  const events = runInContext(eventsSource, context)(internal);
  const process = runInContext(processSource, context)(internal);
  context.process = process;
  return {
    process, events, internal, changes, dispositions, pending, context, writes,
    writeFails(error: Error) { writeError = error; },
    ticks() { while (ticks.length) ticks.shift()!(); },
    selected: () => selected,
    send(signal: number) {
      const mode = dispositions.get(signal) ?? 0;
      if (mode === 2) pending.add(signal);
      else if (mode === 0) selected = { status: 128 + signal, signal };
    },
    pump() { return internal.pumpSignals!(); },
  };
}

test("JS guests start with SIGPIPE ignored like Node and Bun", () => {
  const f = fixture();
  expect(f.dispositions.get(13)).toBe(1);
  expect(f.process.kill(f.process.pid, "SIGPIPE")).toBe(true);
  expect(f.selected()).toBeUndefined();
});

test("unrelated removeAllListeners preserves the initial SIGPIPE ignore", () => {
  const f = fixture();
  f.process.on("SIGINT", () => {});
  f.process.removeAllListeners();
  expect(f.dispositions.get(13)).toBe(1);
  f.send(13);
  expect(f.selected()).toBeUndefined();
});

test("generic Node controllers retain preview1 SIGPIPE default", () => {
  const controller = createNodeSignalController();
  expect(Atomics.load(new Int32Array(controller.buffers.signalState), 13)).toBe(0);
});

for (const [name, signal] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGPIPE", 13]] as const) {
  for (const method of ["on", "addListener", "prependListener", "once", "prependOnceListener"] as const) {
    test(`process.${method} publishes ${name} before returning and delivers its name`, () => {
      const f = fixture();
      const calls: unknown[] = [];
      const handler = (value: unknown) => calls.push(value);
      expect(f.process[method](name, handler)).toBe(f.process);
      expect(f.dispositions.get(signal)).toBe(2);
      f.send(signal);
      expect(calls).toEqual([]);
      expect(f.pump()).toBe(true);
      expect(calls).toEqual([name]);
      expect(f.pump()).toBe(false);
      if (method === "once" || method === "prependOnceListener") expect(f.dispositions.get(signal)).toBe(0);
      expect(f.selected()).toBeUndefined();
    });
  }

  test(`last ${name} removal restores its runtime default synchronously`, () => {
    const f = fixture();
    const handler = () => {};
    f.process.on(name, handler);
    f.process.off(name, handler);
    expect(f.dispositions.get(signal)).toBe(0);
    f.send(signal);
    expect(f.selected()).toEqual({ status: 128 + signal, signal });
  });

  test(`pending ${name} removal applies its runtime default without losing unrelated state`, () => {
    const f = fixture();
    const handler = () => {};
    f.process.on(name, handler);
    f.send(signal);
    f.process.removeListener(name, handler);
    expect(f.selected()).toEqual({ status: 128 + signal, signal });
    expect(f.pending.size).toBe(0);
  });
}

test("process listener publication precedes removeListener observers", () => {
  const f = fixture();
  const handler = () => {};
  f.process.on("SIGINT", handler);
  let observed: number | undefined;
  f.process.on("removeListener", (name: string) => {
    if (name === "SIGINT") observed = f.dispositions.get(2);
  });
  f.process.removeListener("SIGINT", handler);
  expect(observed).toBe(0);
});

test("prototype EventEmitter methods still publish process disposition", () => {
  const f = fixture();
  const handler = () => {};
  f.events.prototype.on.call(f.process, "SIGTERM", handler);
  expect(f.dispositions.get(15)).toBe(2);
  f.events.prototype.removeAllListeners.call(f.process);
  expect(f.dispositions.get(15)).toBe(0);
});

test("removeAllListeners preserves other signals then restores all defaults", () => {
  const f = fixture();
  f.process.on("SIGINT", () => {});
  f.process.on("SIGTERM", () => {});
  f.process.removeAllListeners("SIGINT");
  expect(f.dispositions.get(2)).toBe(0);
  expect(f.dispositions.get(15)).toBe(2);
  f.process.removeAllListeners();
  expect(f.dispositions.get(15)).toBe(0);
});

test("removing one of two handlers keeps the handled disposition", () => {
  const f = fixture();
  const first = () => {};
  f.process.on("SIGINT", first);
  f.process.on("SIGINT", () => {});
  f.process.removeListener("SIGINT", first);
  expect(f.dispositions.get(2)).toBe(2);
  expect(f.changes).toEqual([[2, 2]]);
});

test("once clears pending before restoring default and calling the handler", () => {
  const f = fixture();
  f.process.once("SIGINT", () => {
    expect(f.dispositions.get(2)).toBe(0);
    expect(f.pending.size).toBe(0);
    f.process.exit(0);
  });
  f.send(2);
  try { f.pump(); throw new Error("handler did not exit"); }
  catch (error) { expect(error).toBeInstanceOf(GuestExit); expect((error as GuestExit).code).toBe(0); }
  expect(f.selected()).toBeUndefined();
});

test("distinct handled INT and TERM dispatch independently", () => {
  const f = fixture();
  const seen: string[] = [];
  f.process.on("SIGINT", (name: string) => seen.push(name));
  f.process.on("SIGTERM", (name: string) => seen.push(name));
  f.send(2); f.send(15); f.send(2);
  f.pump();
  expect(seen).toEqual(["SIGINT", "SIGTERM"]);
});

test("a signal handler is not itself an event-loop keepalive", () => {
  const f = fixture();
  f.process.on("SIGINT", () => {});
  expect(f.pump()).toBe(false);
  expect(f.internal).not.toHaveProperty("pendingIo");
});

for (const [name, signal] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGPIPE", 13]] as const) {
  test(`self ${name} respects the runtime default and a real handler keeps its own exit`, () => {
    const plain = fixture();
    if (signal === 13) {
      expect(plain.process.kill(plain.process.pid, name)).toBe(true);
      expect(plain.selected()).toBeUndefined();
    } else {
      expect(() => plain.process.kill(plain.process.pid, name)).toThrow(GuestExit);
      expect(plain.selected()).toEqual({ status: 128 + signal, signal });
    }
    const handled = fixture();
    handled.process.on(name, () => handled.process.exit(0));
    expect(handled.process.kill(handled.process.pid, name)).toBe(true);
    expect(handled.selected()).toBeUndefined();
    expect(() => handled.pump()).toThrow("guest exit 0");
    expect(handled.selected()).toBeUndefined();
  });
}

test("self signal zero probes and IGNORE does not queue", () => {
  const f = fixture();
  expect(f.process.kill(f.process.pid, 0)).toBe(true);
  expect(f.changes).toEqual([]);
  f.internal.native.hostSignal(15, 1);
  expect(f.process.kill(f.process.pid, 15)).toBe(true);
  expect(f.pump()).toBe(false);
  expect(f.selected()).toBeUndefined();
});

test("SIGKILL cannot acquire a handler and self KILL remains fatal", () => {
  const f = fixture();
  f.process.on("SIGKILL", () => { throw new Error("must not dispatch"); });
  expect(f.changes).toEqual([]);
  expect(() => f.process.kill(f.process.pid, "SIGKILL")).toThrow("guest exit 137");
  expect(f.selected()).toEqual({ status: 137, signal: 9 });
});

const bootstrapSource = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
function errorFixture() {
  const f = fixture();
  // Execute the actual bootstrap error-policy section against the actual process/EventEmitter.
  const start = bootstrapSource.indexOf("  internal.handleUncaught =");
  const end = bootstrapSource.indexOf("  internal.emitBeforeExit", start);
  if (start < 0 || end < 0) throw new Error("bootstrap error section missing");
  f.context.internal = f.internal;
  runInContext(`(() => {
    const native = internal.native;
    const listenerCount = name => process.listenerCount(name);
    const emitExit = internal.emitExit;
    const printFatal = () => {};
    ${bootstrapSource.slice(start, end)}
  })()`, f.context);
  return f as typeof f & { internal: typeof f.internal & {
    handleUncaught(error: unknown): boolean;
    handleRejection(error: unknown): boolean;
  }};
}
const epipe = () => Object.assign(new Error("broken pipe"), { code: "EPIPE", errno: -32, syscall: "write" });

for (const method of ["handleUncaught", "handleRejection"] as const) {
  test(`${method} escaping EPIPE reports the error under SIGPIPE's ignored Node default`, () => {
    const f = errorFixture();
    expect(f.internal[method](epipe())).toBe(false);
    expect(f.selected()).toBeUndefined();
    expect(f.changes).toEqual([]);
    expect(f.process.exitCode).toBe(method === "handleUncaught" ? 1 : undefined);
  });
  test(`${method} does not synthesize SIGPIPE or consume unrelated pending signals`, () => {
    const f = errorFixture();
    const seen: string[] = [];
    f.process.on("SIGPIPE", () => seen.push("SIGPIPE"));
    f.process.on("SIGINT", () => seen.push("SIGINT"));
    f.send(2);
    expect(f.internal[method](epipe())).toBe(false);
    expect(seen).toEqual([]);
    expect(f.pending.has(2)).toBe(true);
    expect(f.pending.has(13)).toBe(false);
    expect(f.selected()).toBeUndefined();
    expect(f.process.exitCode).toBe(method === "handleUncaught" ? 1 : undefined);
  });
  test(`${method} user error handlers can consume EPIPE`, () => {
    const f = errorFixture();
    const event = method === "handleUncaught" ? "uncaughtException" : "unhandledRejection";
    const errors: unknown[] = [];
    f.process.on(event, (error: unknown) => errors.push(error));
    const error = epipe();
    expect(f.internal[method](error)).toBe(true);
    expect(errors).toEqual([error]);
    expect(f.changes).toEqual([]);
    expect(f.selected()).toBeUndefined();
  });
}

test("stdio write callbacks can consume EPIPE without a SIGPIPE or error listener", () => {
  const f = errorFixture();
  const error = epipe();
  f.writeFails(error);
  const seen: unknown[] = [];
  expect(f.process.stdout.write("output", (err: unknown) => seen.push(err))).toBe(false);
  f.ticks();
  expect(seen).toEqual([error]);
  expect(f.writes).toEqual([["output", true]]);
  expect(f.changes).toEqual([]);
});

test("stdio callback, callback tick, and error listener retain their order and own exit", () => {
  const f = errorFixture();
  const error = epipe();
  f.writeFails(error);
  const order: string[] = [];
  f.process.stdout.on("error", (err: unknown) => {
    expect(err).toBe(error); order.push("error"); f.process.exit(42);
  });
  f.process.stdout.write("output", (err: unknown) => {
    expect(err).toBe(error); order.push("callback");
    f.internal.nextTick(() => order.push("callback tick"));
  });
  expect(() => f.ticks()).toThrow("guest exit 42");
  expect(order).toEqual(["callback", "callback tick", "error"]);
  expect(f.selected()).toBeUndefined();
});

test("unhandled stdio EPIPE reaches the ordinary uncaught-error policy after error delivery", () => {
  const f = errorFixture();
  f.writeFails(epipe());
  f.process.stdout.write("output");
  expect(f.selected()).toBeUndefined();
  let error: unknown;
  try { f.ticks(); } catch (err) { error = err; }
  expect((error as Error & { code: string }).code).toBe("EPIPE");
  expect(f.internal.handleUncaught(error)).toBe(false);
  expect(f.process.exitCode).toBe(1);
});

test("stdio error listeners do not turn Node's ignored SIGPIPE into a fatal signal", () => {
  const f = fixture();
  f.process.stdout.on("error", () => {});
  f.process.stderr.on("error", () => {});
  expect(f.changes).toEqual([]);
  f.send(13);
  expect(f.selected()).toBeUndefined();
  expect(f.process.kill(f.process.pid, "SIGPIPE")).toBe(true);
  expect(f.selected()).toBeUndefined();
});
