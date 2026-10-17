import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { defaultSignalGuest, handledSignalGuest, idleSignalGuest } from "./engine-interruption-guests";

// Throw at the actual synchronous readiness write. Only an already-entered
// protected frame can catch it and execute all three diagnostic markers. Keep
// execution bounded so moving an infinite spin before try fails, not hangs.
function assertProtectedReadiness(source: string, nested: boolean): void {
  const ready = nested ? "handler-ready\n" : "ready\n";
  const writes: string[] = [];
  let handler: (() => void) | undefined;
  runInNewContext(source + (nested ? "\nprocess.emit('SIGINT');" : ""), {
    require(name: string) {
      if (name !== "node:fs") throw Error(`unexpected import ${name}`);
      return { writeSync(fd: number, text: string) {
        expect(fd).toBe(2);
        writes.push(text);
        if (text === ready) throw Error("readiness write sentinel");
      } };
    },
    process: {
      on(signal: string, callback: () => void) { expect(signal).toBe("SIGINT"); handler = callback; },
      emit(signal: string) { expect(signal).toBe("SIGINT"); handler!(); },
    },
    setTimeout() { return 1; },
    clearTimeout() {},
  }, { timeout: 100 });
  const prefix = nested ? ["ready\n", "loop-finished\n"] : [];
  expect(writes).toEqual(prefix.concat([ready, "CATCH-RAN\n", "FINALLY-RAN\n", "AFTER-RAN\n"]));
}

for (const fixture of [
  { name: "default/native", source: defaultSignalGuest(), nested: false, ready: "ready" },
  { name: "nested handler", source: handledSignalGuest(true, 0), nested: true, ready: "handler-ready" },
]) {
  test(`${fixture.name} readiness causally proves entry into its protected try`, () => {
    assertProtectedReadiness(fixture.source, fixture.nested);
  });

  const write = `fs.writeSync(2,'${fixture.ready}\\n');`;
  const guardedReady = `try { ${write}`;
  for (const preTry of [write, `${write} while (true) {}`]) {
    test(`${fixture.name} rejects readiness${preTry === write ? "" : " and spin"} moved before try`, () => {
      const mutated = fixture.source.replace(guardedReady, `${preTry} try {`);
      expect(mutated).not.toBe(fixture.source);
      expect(() => assertProtectedReadiness(mutated, fixture.nested)).toThrow("readiness write sentinel");
    });
  }

  test(`${fixture.name} rejects a spin before the protected try`, () => {
    const mutated = fixture.source.replace(guardedReady, `while (true) {} ${guardedReady}`);
    expect(mutated).not.toBe(fixture.source);
    expect(() => assertProtectedReadiness(mutated, fixture.nested)).toThrow("timed out");
  });
}

// Each reference run owns one native Node process and its pipes, with no files or
// listeners. Arm bounded teardown before spawning; never leave a looping handler.
async function nodeReference(nested: boolean, source = handledSignalGuest(nested)) {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const deadline = setTimeout(() => child?.kill("SIGKILL"), 5_000);
  try {
    child = Bun.spawn(["node", "-e", source], { stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    let stderr = "", sentInterrupt = false, sentTerminate = false;
    for await (const bytes of child.stderr as ReadableStream<Uint8Array>) {
      stderr += new TextDecoder().decode(bytes);
      if (!sentInterrupt && stderr.includes("ready\n")) { sentInterrupt = true; child.kill("SIGINT"); }
      if (nested && !sentTerminate && stderr.includes("handler-ready\n")) { sentTerminate = true; child.kill("SIGTERM"); }
    }
    return { stdout: await stdout, stderr, status: await child.exited, signal: child.signalCode };
  } finally {
    clearTimeout(deadline);
    if (child) { child.kill("SIGKILL"); await child.exited; }
  }
}

test("Node queues handled SIGINT until finite synchronous CPU work yields", async () => {
  const result = await nodeReference(false);
  expect(result.status).toBe(23);
  expect(result.stderr).toBe("ready\nloop-finished\nhandled\n");
  expect(result.stdout).toBe("continued 1 true\n");
}, 10_000);

test("Node enters a queued handler after yielding and default SIGTERM kills its CPU loop", async () => {
  const result = await nodeReference(true);
  expect(result.signal).toBe("SIGTERM");
  expect(result.stderr).toBe("ready\nloop-finished\nhandler-ready\n");
  expect(result.stdout).toBe("");
}, 10_000);
test("Node wakes an interval-kept idle loop for handled SIGINT and retains ordinary23", async () => {
  const result = await nodeReference(false, idleSignalGuest);
  expect(result.status).toBe(23);
  expect(result.stderr).toBe("ready\nidle-handled\n");
  expect(result.stdout).toBe("");
}, 10_000);
