import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";

const fixture = readFileSync(new URL("../../tests/fixtures/pipe-stdin-race/index.ts", import.meta.url), "utf8");
const definitions = new Bun.Transpiler({ loader: "ts" }).transformSync(
  fixture.slice(0, fixture.indexOf("\nconst failures = []")),
).replace(/^import .*;$/gm, "");

// Run the fixture's actual child program. The old startup sleep is virtualized:
// deliver readiness only after the child either blocks for input or exits. No
// elapsed-time assumption decides which state the parent observes.
const childRunner = `
const { workerData } = require("node:worker_threads");
const { runInNewContext } = require("node:vm");
const cells = new Int32Array(workerData.control);
const exited = {};
try {
  runInNewContext(workerData.source, {
    Buffer,
    require(name) {
      if (name !== "node:fs") throw new Error("unexpected module " + name);
      return {
        writevSync(fd, chunks) {
          if (fd !== 1 || Buffer.concat(chunks).toString() !== "ready") throw new Error("unexpected readiness write");
          Atomics.store(cells, 2, 1);
          return 5;
        },
        readSync(fd, buffer, offset, length) {
          if (fd !== 0 || length !== 1) throw new Error("unexpected input read");
          Atomics.add(cells, 4, 1);
          Atomics.store(cells, 0, 1);
          Atomics.notify(cells, 0);
          Atomics.wait(cells, 1, 0, 5000);
          if (Atomics.load(cells, 1) !== 1) throw new Error("parent did not release child");
          buffer[offset] = 33;
          return 1;
        },
      };
    },
    Bun: { sleepSync() {} },
    process: { exit(code) {
      Atomics.store(cells, 3, code);
      Atomics.store(cells, 0, 2);
      Atomics.notify(cells, 0);
      throw exited;
    } },
  });
  throw new Error("child did not exit");
} catch (error) {
  if (error !== exited) {
    Atomics.store(cells, 0, 3);
    Atomics.notify(cells, 0);
    throw error;
  }
}
`;

for (const scenario of ["bunRace", "nodeRace"] as const) {
  test(`${scenario} establishes live-child readiness before releasing completion`, async () => {
    const workers: Worker[] = [];
    const errors: unknown[] = [];
    const writes: string[] = [];
    const messages: string[] = [];
    let cells: Int32Array;
    let snapshot: { exitCode: number | null };
    function waitWhile(phase: number) {
      Atomics.wait(cells, 0, phase, 5000); // Deadlock guard, not a scheduling delay.
      assert.notEqual(Atomics.load(cells, 0), phase, "child did not reach the next protocol state");
      assert.notEqual(Atomics.load(cells, 0), 3, "child program failed");
    }
    function start(argv: string[]) {
      const control = new SharedArrayBuffer(20);
      cells = new Int32Array(control);
      const worker = new Worker(childRunner, { eval: true, workerData: { control, source: argv[2] } });
      workers.push(worker);
      worker.on("error", error => errors.push(error));
      snapshot = { exitCode: null };
    }
    function ready() {
      waitWhile(0);
      assert.equal(Atomics.load(cells, 2), 1);
      // A completed child may legally have buffered stdout. This deliberately
      // reproduces the late-readiness schedule, rather than hiding completion.
      if (Atomics.load(cells, 0) === 2) snapshot.exitCode = Atomics.load(cells, 3);
      return Buffer.from("ready");
    }
    function write(chunk: string) {
      writes.push(chunk);
      if (chunk === "!") {
        assert.equal(Atomics.load(cells, 0), 1, "release must target a live input-blocked child");
        Atomics.store(cells, 1, 1);
        Atomics.notify(cells, 1);
        return 1;
      }
      assert.equal(Atomics.load(cells, 0), 2, "racing write must follow physical completion");
      throw Object.assign(new Error("closed child stdin"), { code: "EPIPE", errno: -32, syscall: "write" });
    }
    const bun = {
      spawn(argv: string[]) {
        start(argv);
        return {
          get exitCode() { return snapshot.exitCode; },
          stdin: { write },
          stdout: { getReader: () => ({ read: async () => ({ done: false, value: ready() }), cancel: async () => {} }) },
          get exited() { snapshot.exitCode = Atomics.load(cells, 3); return Promise.resolve(snapshot.exitCode); },
          kill() {},
        };
      },
      sleepSync(ms: number) {
        assert.equal(ms, 250);
        waitWhile(1);
        assert.equal(Atomics.load(cells, 0), 2);
        assert.equal(Atomics.load(cells, 3), 0);
      },
      sleep: () => new Promise(() => {}),
    };
    function spawn(command: string, args: string[]) {
      start([command].concat(args));
      const child = new EventEmitter();
      Object.defineProperty(child, "exitCode", { get: () => snapshot.exitCode });
      const stdout = new EventEmitter();
      const stdin = new EventEmitter();
      Object.assign(stdin, { write(chunk: string, callback?: (error?: unknown) => void) {
        try { write(chunk); callback?.(); }
        catch (error) { callback?.(error); queueMicrotask(() => stdin.emit("error", error)); }
        return true;
      } });
      Object.assign(child, { stdout, stdin, kill() { snapshot.exitCode = 0; child.emit("close", 0); } });
      queueMicrotask(() => stdout.emit("data", ready()));
      return child;
    }
    // Teardown covers assertion failures as well as the old fixture's expected
    // red result; workers are the only resources this test creates.
    try {
      const scenarios = runInNewContext(`(() => { ${definitions}\nreturn { bunRace, nodeRace }; })()`, {
        assert, spawn, Bun: bun, process: { execPath: "/bun" },
        console: { log: (message: string) => messages.push(message) }, Buffer,
      }) as Record<typeof scenario, () => Promise<void>>;
      await scenarios[scenario]();
      expect(writes).toEqual(["!", "racing child exit"]);
      expect(Atomics.load(cells!, 4)).toBe(1);
      expect(messages).toEqual([scenario === "bunRace" ? "Bun stdin close race EPIPE -32 write" : "Node stdin callback, event; EPIPE -32 write"]);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  });
}
