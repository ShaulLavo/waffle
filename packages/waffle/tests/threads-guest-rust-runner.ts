import { verifiedThreadFixture } from "../scripts/build-thread-fixture.ts";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { readOutcome } from "../proc/outcome.ts";
import { guestFixture } from "./threads-guest-fixture.ts";

/** Compiler-free, opt-in low-level embedding, not Runtime or browser qualification. */
export async function runThreadRust(directory: string, mode: "pair" | "repeat" | "nested") {
  const bytes = verifiedThreadFixture(directory);
  const module = await compileThreadGuest(bytes);
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 512, shared: true });
  const fixture = await guestFixture(memory);
  let nextTid = 1;
  let live = 0;
  let peak = 0;
  let returned = 0;
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error("Rust guest deadline exceeded")), 10000);
  try {
    fixture.descriptors.renumber(fixture.writerFd, 1);
    fixture.descriptors.inherit(2, fixture.descriptors.get(1)!);
    const follow = (guest: ReturnType<typeof fixture.launch>) => {
      live++;
      peak = Math.max(peak, live);
      void guest.idle.then(
        () => {
          if (guest.events.some((event) => event.kind === "thread-returned")) returned++;
          guest.worker.terminate();
          live--;
        },
        () => {},
      );
      return guest;
    };
    fixture.setSpawn(async (startArg) => {
      if (live === 4) return -6;
      const tid = ++nextTid;
      const guest = follow(fixture.launch(module, { kind: "secondary", tid, startArg }));
      await guest.ready;
      guest.enter();
      return tid;
    });
    const main = follow(fixture.launch(module, { kind: "initial" }, ["threads", mode]));
    await Promise.race([main.ready, deadline.promise]);
    main.enter();
    await Promise.race([main.idle, deadline.promise]);
    await Promise.race([Promise.all(fixture.guests.map((guest) => guest.idle)), deadline.promise]);
    const outcome = readOutcome(fixture.outcome);
    const output: number[] = [];
    const chunk = new Uint8Array(4096);
    for (;;) {
      const size = fixture.reader.tryRead([chunk]);
      if (size <= 0) break;
      for (let i = 0; i < size; i++) output.push(chunk[i]!);
    }
    const stdout = new TextDecoder().decode(new Uint8Array(output));
    const expected = `threads-ok mode=${mode} main-static=1369948382 main-tls=901\n`;
    if (
      outcome?.kind !== "exited" ||
      outcome.code !== 0 ||
      stdout !== expected ||
      fixture.failures.length
    )
      throw new Error(
        `Rust ${mode} failed: ${JSON.stringify({ outcome, stdout, failures: fixture.failures.length, spawned: nextTid - 1, events: fixture.guests.map((guest) => guest.events), requests: fixture.requests.map((entry) => entry.request) })}`,
      );
    return {
      mode,
      outcome,
      stdout,
      spawned: nextTid - 1,
      returned,
      peakGuestWorkers: peak,
      fixedGuestBytes: memory.buffer.byteLength,
      receiptVerified: true,
      compilerInvoked: false,
    };
  } finally {
    clearTimeout(timer);
    await fixture.dispose();
  }
}
if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error("usage: threads-guest-rust-runner.ts RECEIPT_DIRECTORY");
  for (const mode of ["pair", "repeat", "nested"] as const) {
    try {
      console.log(JSON.stringify(await runThreadRust(directory, mode)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
