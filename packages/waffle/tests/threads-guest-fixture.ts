import {
  claimOutcome,
  outcomeWord,
  readOutcome,
  serializeOutcome,
  processOutcome,
} from "../proc/outcome.ts";
import {
  createThreadLaneOwner,
  THREAD_LANE_BYTES,
  type ThreadDispatcher,
  type ThreadRequest,
  ThreadWaitOwner,
} from "../thread/lane.ts";
import type { CapturedWaitRegistration } from "../interrupt/wait.ts";
import type { GuestFixtureEvent, GuestFixtureRequest } from "./threads-guest-worker.ts";
import type { CallKey } from "../thread/protocol.ts";
import type { GuestEntry } from "../thread/entry.ts";
import { serviceFixture } from "./threads-service-fixture.ts";

type GuestLogEvent =
  | Exclude<GuestFixtureEvent, { kind: "wait-registered" }>
  | {
      kind: "wait-registered";
      thread: CallKey["thread"];
      registration: { generation: number; address: number; width: 4 | 8; bytes: number };
    };
function logEvent(event: GuestFixtureEvent): GuestLogEvent {
  if (event.kind !== "wait-registered") return event;
  const { generation, address, width, buffer } = event.registration;
  return {
    kind: event.kind,
    thread: event.thread,
    registration: { generation, address, width, bytes: buffer.byteLength },
  };
}
interface Guest {
  worker: Worker;
  owner: ReturnType<typeof createThreadLaneOwner>;
  waits: Int32Array;
  waitOwner: ThreadWaitOwner;
  events: GuestLogEvent[];
  ready: Promise<void>;
  idle: Promise<void>;
  enter(): void;
}

export async function guestFixture(
  memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }),
) {
  const fixture = await serviceFixture("cold", memory);
  const outcome = outcomeWord();
  const guests: Guest[] = [];
  const requests: { call: CallKey; request: ThreadRequest }[] = [];
  const failures: unknown[] = [];
  const retainedWaits = new Set<CapturedWaitRegistration>();
  let afterDispatch: (() => void) | undefined;
  let spawn: (startArg: number) => Promise<number> = async () => -6;
  const dispatcher: ThreadDispatcher = {
    async dispatch(call, request) {
      requests.push({ call, request });
      if (request.kind !== "spawn") {
        const result = await fixture.service.submit(call, request);
        afterDispatch?.();
        return result;
      }
      const tid = await spawn(request.startArg);
      return tid > 0 ? { kind: "ok", value: tid } : { kind: "error", errno: -tid };
    },
  };
  function launch(
    module: WebAssembly.Module,
    entry: GuestEntry,
    args: readonly string[] = ["fixture"],
    env: Readonly<Record<string, string>> = {},
    poison = false,
  ): Guest {
    const tid = entry.kind === "initial" ? 1 : entry.tid;
    const thread = { directory: "test", pid: 1, tid };
    const worker = new Worker(new URL("./threads-guest-worker.ts", import.meta.url).href);
    const channel = new MessageChannel();
    const reply = new SharedArrayBuffer(THREAD_LANE_BYTES);
    const owner = createThreadLaneOwner({
      thread,
      lane: { port: channel.port1, reply },
      dispatcher,
      terminal: () => readOutcome(outcome) !== null,
      failed: (error) => {
        failures.push(error);
        terminal();
      },
    });
    const waitBuffer = new SharedArrayBuffer(12);
    const waits = new Int32Array(waitBuffer);
    const waitOwner = new ThreadWaitOwner({
      thread,
      memory,
      waits,
      terminal: () => readOutcome(outcome) !== null,
      retain: (registration) => {
        retainedWaits.add(registration);
        return () => {
          retainedWaits.delete(registration);
        };
      },
      failed: (error) => {
        failures.push(error);
      },
    });
    const events: GuestLogEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    // A negative startup test may never publish ready.
    void ready.promise.catch(() => {});
    worker.onmessage = ({ data }: MessageEvent<GuestFixtureEvent>) => {
      waitOwner.receive(data);
      events.push(logEvent(data));
      if (data.kind === "ready") ready.resolve();
      if (data.kind === "process-terminal") terminal();
      if (data.kind === "host-idle") {
        ready.reject(new Error("guest idled before ready"));
        idle.resolve();
      }
    };
    worker.onerror = (error) => {
      ready.reject(new Error(error.message));
      idle.reject(new Error(error.message));
    };
    const request: GuestFixtureRequest = {
      poison,
      module,
      memory,
      thread,
      entry,
      args,
      env,
      lane: { port: channel.port2, reply },
      outcome: serializeOutcome(outcome),
      signal: new SharedArrayBuffer(4),
      waits: waitBuffer,
    };
    worker.postMessage(request, [channel.port2]);
    const guest = {
      worker,
      owner,
      waits,
      waitOwner,
      events,
      ready: ready.promise,
      idle: idle.promise,
      enter: () => worker.postMessage({ kind: "enter" }),
    };
    guests.push(guest);
    return guest;
  }
  function terminal() {
    if (!readOutcome(outcome)) claimOutcome(outcome, processOutcome({ kind: "exited", code: 1 }));
    fixture.service.cancelAll();
    for (const guest of guests) {
      void guest.owner.retire();
      guest.worker.postMessage({ kind: "close" });
      guest.waitOwner.beginTerminal();
    }
  }
  async function dispose() {
    terminal();
    const timedOut = Promise.withResolvers<never>();
    const deadline = setTimeout(
      () => timedOut.reject(new Error("guest teardown did not idle")),
      1000,
    );
    try {
      await Promise.race([Promise.all(guests.map((guest) => guest.idle)), timedOut.promise]);
      await Promise.all(guests.map((guest) => guest.owner.retire()));
    } catch (error) {
      for (const guest of guests) guest.waitOwner.fail(error);
      throw error;
    } finally {
      clearTimeout(deadline);
      for (const guest of guests) guest.worker.terminate();
      await fixture.dispose();
    }
  }
  return {
    ...fixture,
    outcome,
    launch,
    guests,
    requests,
    failures,
    retainedWaits,
    terminal,
    dispose,
    setAfterDispatch: (handler: () => void) => {
      afterDispatch = handler;
    },
    setSpawn: (handler: typeof spawn) => {
      spawn = handler;
    },
  };
}
