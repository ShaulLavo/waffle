import { expect, test } from "bun:test";
import { pages } from "../memory/reservations.js";
import { inspectThreadSource } from "../memory/declarations.js";
import { guestModule, wait32 } from "./threads-guest-module.js";

const source = () =>
  guestModule({
    imports: [{ module: "wasi", name: "thread-spawn", params: [0x7f] }],
    initial: wait32(0),
  });
test("source declaration chooses native initial size and one compatible full ceiling", () => {
  expect(inspectThreadSource(source())).toEqual({
    initialPages: pages(2),
    actualMaximumPages: pages(512),
    sourceMaximumPages: pages(512),
  });
  expect(inspectThreadSource(guestModule())).toBeUndefined();
  expect(() =>
    inspectThreadSource(
      guestModule({ imports: [{ module: "wasi", name: "thread-spawn", params: [0x7e] }] }),
    ),
  ).toThrow("signature");
});
for (const selected of ["join", "child-exit", "kill-start", "cpu", "wait32", "wait64"]) {
  test(`real Runtime ${selected} exits and retires its service and guest aliases`, async () => {
    const process = Bun.spawn(
      ["bun", new URL("./threads-runtime-control.ts", import.meta.url).pathname, selected],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const output = await new Response(process.stdout).text();
      const errors = await new Response(process.stderr).text();
      expect(await process.exited, errors).toBe(0);
      const report = JSON.parse(output.trim());
      expect(report.exit).toEqual(
        selected === "join" || selected === "child-exit"
          ? { kind: "exited", code: 0, status: 0 }
          : { kind: "signaled", code: 9, status: 137 },
      );
      expect(report.sharedGuests.length).toBeLessThanOrEqual(1);
      for (const backing of report.sharedGuests) expect(backing.phase).toBe("awaiting-collection");
      if (selected === "kill-start") expect(report.guestReady).toBe(0);
      else if (selected === "cpu" || selected === "wait32" || selected === "wait64")
        expect(report.registered).toBe(selected === "cpu" ? 0 : 1);
      else expect(report.guestReady).toBe(2);
    } finally {
      process.kill();
      await process.exited;
    }
  }, 30000);
}

test("actual guest realm replacements cannot observe immutable argument bytes or terminal timer closures", async () => {
  const { compileThreadGuest } = await import("../thread/guest-module.js");
  const { outcomeWord, serializeOutcome, readOutcome } = await import("../proc/outcome.js");
  const { i32, call } = await import("./threads-guest-module.js");
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 512, shared: true });
  const outcome = outcomeWord();
  const source = guestModule({
    imports: ["args_sizes_get", "args_get", "environ_sizes_get", "environ_get"].map((name) => ({
      name,
      params: [0x7f, 0x7f],
    })),
    initial: i32(0).concat(
      i32(4),
      call(0),
      [0x1a],
      i32(16),
      i32(64),
      call(1),
      [0x1a],
      i32(128),
      i32(132),
      call(2),
      [0x1a],
      i32(144),
      i32(160),
      call(3),
      [0x1a],
    ),
  });
  const module = await compileThreadGuest(source);
  const channel = new MessageChannel();
  const worker = new Worker(new URL("./threads-runtime-authority-worker.ts", import.meta.url).href);
  const done = Promise.withResolvers<void>();
  let canaries = 0;
  worker.onmessage = ({ data }) => {
    if (data.kind === "canaries") canaries = data.count;
    if (data.kind === "ready") worker.postMessage({ kind: "enter" });
    if (data.kind === "host-idle") done.resolve();
  };
  worker.onerror = (event) => {
    event.preventDefault();
    done.reject(event.error ?? new Error(event.message));
  };
  try {
    worker.postMessage(
      {
        module,
        memory,
        thread: { directory: "authority", pid: 1, tid: 1 },
        entry: { kind: "initial" },
        outcome: serializeOutcome(outcome),
        signal: new SharedArrayBuffer(4),
        waits: new SharedArrayBuffer(12),
        lane: { reply: new SharedArrayBuffer(64), port: channel.port2 },
        args: ["private-args"],
        env: { TEST: "private-env" },
      } satisfies import("../thread/guest-worker.js").GuestWorkerRequest,
      [channel.port2],
    );
    await done.promise;
    expect(canaries).toBe(6);
    expect(readOutcome(outcome)).toMatchObject({ kind: "exited", code: 0 });
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 64, 13))).toBe("private-args\0");
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 160, 17))).toBe(
      "TEST=private-env\0",
    );
  } finally {
    channel.port1.close();
    channel.port2.close();
    await worker.terminate();
  }
}, 10000);

test("Runtime browser runner refuses a missing opt-in artifact without compiling one", async () => {
  const child = Bun.spawn(
    ["bun", new URL("./threads-runtime-browser-runner.ts", import.meta.url).pathname, "chromium"],
    { env: { ...process.env, THREAD_FIXTURE_DIR: "" }, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const errors = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    expect(errors).toContain("set THREAD_FIXTURE_DIR");
  } finally {
    child.kill();
    await child.exited;
  }
});
