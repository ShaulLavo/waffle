import { createSupervisedWaitImports } from "../interrupt/wait.js";
import { terminalInterrupt } from "../interrupt/check.js";
import { outcomeWord, readOutcome } from "../proc/outcome.js";
import { GuestTerminal, type GuestReport } from "../thread/entry.js";
import { compileThreadGuest } from "../thread/guest-module.js";
import { guestImports } from "../thread/guest-imports.js";
import { ThreadLane, THREAD_LANE_BYTES } from "../thread/lane.js";
import { guestFixture } from "./threads-guest-fixture.js";

function importResolution(module: WebAssembly.Module, memory: WebAssembly.Memory) {
  const channel = new MessageChannel();
  const outcome = outcomeWord();
  const terminal = () => terminalInterrupt(outcome);
  const lane = new ThreadLane(
    { port: channel.port1, reply: new SharedArrayBuffer(THREAD_LANE_BYTES) },
    terminal,
  );
  const events: GuestReport[] = [];
  try {
    const imports = guestImports(module, {
      memory,
      lane,
      terminal: new GuestTerminal({
        thread: { directory: "c-imports", pid: 1, tid: 1 },
        outcome,
        signal: new Int32Array(new SharedArrayBuffer(4)),
        report: (event) => events.push(event),
      }),
      args: ["c-threads", "pair"],
      env: {},
      interrupt: {
        ...createSupervisedWaitImports(memory, new Int32Array(new SharedArrayBuffer(12)), terminal),
        __waffle_fatal: terminal,
      },
    });
    return { kind: "resolved", imports: Object.keys(imports) };
  } catch (error) {
    return { kind: "rejected", error: String(error) };
  } finally {
    lane.close();
    channel.port2.close();
  }
}

/** Uses the existing real service and guest Worker fixture, with no replacement imports. */
export async function runCThreadsEmbedding(source: Uint8Array<ArrayBuffer>) {
  const module = await compileThreadGuest(source);
  const memory = new WebAssembly.Memory({ initial: 17, maximum: 512, shared: true });
  const resolution = importResolution(module, memory);
  const fixture = await guestFixture(memory);
  const main = fixture.launch(module, { kind: "initial" }, ["c-threads", "pair"]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("C embedding smoke deadline")), 10_000);
    });
    const readiness = await Promise.race([
      main.ready.then(
        () => "ready",
        (error: unknown) => String(error),
      ),
      expired,
    ]);
    if (readiness === "ready") main.enter();
    await Promise.race([main.idle, expired]);
    return {
      resolution,
      readiness,
      outcome: readOutcome(fixture.outcome),
      events: main.events,
      requests: fixture.requests.length,
      guestWorkers: fixture.guests.length,
      guestBytes: memory.buffer.byteLength,
      initialPages: 17,
      maximumPages: 512,
      failures: fixture.failures.map(String),
      compilerInvoked: false,
      runtimeQualification: false,
    };
  } finally {
    clearTimeout(timer);
    await fixture.dispose();
  }
}
