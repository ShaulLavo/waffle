import { FilesystemClient } from "../fs/client.js";
import { createFilesystemConnection, reapFilesystem, revokeFilesystem } from "../fs/protocol.js";
import { NOTIFICATION_STATE_BYTES, notificationParker } from "./fixtures/notification-park.js";

const yieldChannel = new MessageChannel();
/** One task turn, without the timer clamp a setTimeout loop would add. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    yieldChannel.port2.onmessage = () => resolve();
    yieldChannel.port1.postMessage(0);
  });
}

/** A real timer turn: long enough on any runner for the park to reach the relay's waiter. */
const timerTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

async function forward(
  state: Int32Array,
  word: Int32Array,
  iteration: number,
  park: () => void,
  settle: boolean,
): Promise<number> {
  const before = Atomics.load(state, 0);
  park();
  // Odd handoffs give the relay time to block in its waiter first, so the notify below lands
  // on an idle relay; even ones race the park message.
  if (iteration % 2) for (let turn = 0; turn < 3; turn++) await nextTask();
  if (iteration % 2 && settle) await timerTurn();
  Atomics.add(word, 0, 1);
  const notified = Atomics.notify(word, 0);
  // A finite native wait changes timer scheduling and can mask the lost dispatch
  // wake. Bound the test from JavaScript instead.
  const waiting = Atomics.waitAsync(state, 0, before);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Error(`Relay stalled at ${iteration}, notify=${notified}, sequence=${before}`)),
      1000,
    );
  });
  try {
    await Promise.race([waiting.value, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return notified;
}

function armed(port: MessagePort): Promise<void> {
  return new Promise((resolve, reject) => {
    port.onmessage = ({ data }) => {
      if (data.type === "armed") resolve();
      else reject(Error(data.message));
    };
  });
}

/**
 * Exercise idle-to-notified dispatch without another source waking the relay.
 * @browserEntry Loaded dynamically by the browser runner's served bundle.
 */
export async function notificationRelayRaceCase(
  helperUrl: string,
  { iterations = 200_000, floor = 4000 } = {},
) {
  const worker = new Worker(helperUrl, { type: "module" });
  const channel = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(NOTIFICATION_STATE_BYTES));
  const words = Array.from({ length: 3 }, () => new Int32Array(new SharedArrayBuffer(4)));
  try {
    const ready = armed(channel.port2);
    worker.postMessage({ id: 1, port: channel.port1, state }, [channel.port1]);
    channel.port2.postMessage({ type: "arm", words: words.map((cells) => ({ cells, index: 0 })) });
    await ready;
    // Each handoff parks like a guest about to block on the values it observed.
    const parker = notificationParker(
      state,
      (request) => channel.port2.postMessage(request),
      () => words.map((cells) => Atomics.load(cells, 0)),
    );
    const park = () => void parker.park();
    // Both orderings must each be seen at least `floor` times: a notify that found the relay
    // blocked in its waiter (the idle path) and one that ran ahead of the park (the race).
    // How the raced handoffs split depends on scheduling, so a short side is topped up with
    // more handoffs. While blocked ones are short, odd top-ups pause on a timer first.
    const cap = iterations + 8 * floor;
    let blocked = 0;
    let unblocked = 0;
    let iteration = 0;
    for (; iteration < iterations || blocked < floor || unblocked < floor; iteration++) {
      if (iteration === cap)
        throw Error(
          `of ${iteration} handoffs, ${blocked} found the relay blocked and ${unblocked} did not`,
        );
      const word = words[iteration % words.length]!;
      const settle = iteration >= iterations && blocked < floor;
      if (await forward(state, word, iteration, park, settle)) blocked++;
      else unblocked++;
    }
    return { iterations, topUp: iteration - iterations, blocked, unblocked };
  } finally {
    Atomics.store(state, 1, 1);
    channel.port2.close();
    worker.terminate();
  }
}

/** A real relay connection armed on `words`, with a guest-shaped parker. */
async function relayConnection(
  helperUrl: string,
  words: readonly { cells: Int32Array; index: number }[],
) {
  const worker = new Worker(helperUrl, { type: "module" });
  const channel = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(NOTIFICATION_STATE_BYTES));
  const ready = armed(channel.port2);
  worker.postMessage({ id: 1, port: channel.port1, state }, [channel.port1]);
  channel.port2.postMessage({ type: "arm", words });
  await ready;
  return {
    state,
    parker: (values: () => number[]) =>
      notificationParker(state, (request) => channel.port2.postMessage(request), values),
    close() {
      Atomics.store(state, 1, 1);
      channel.port2.close();
      worker.terminate();
    },
  };
}

/** Resolves true when state[0] moves past `sequence` within `ms`. */
async function published(state: Int32Array, sequence: number, ms: number): Promise<boolean> {
  const waiting = Atomics.waitAsync(state, 0, sequence, ms);
  return (waiting.async ? await waiting.value : waiting.value) !== "timed-out";
}

/**
 * A filesystem revoke or reap lands between the guest's readiness check and the relay's lazy
 * registration: the park carries values from before it, and the notify has already passed.
 * @browserEntry Loaded dynamically by the browser runner's served bundle.
 */
export async function notificationRevokeParkCase(helperUrl: string) {
  const outcomes: string[] = [];
  for (const [name, revoke] of [
    ["revoke", revokeFilesystem],
    ["reap", reapFilesystem],
  ] as const) {
    const pair = createFilesystemConnection();
    const client = new FilesystemClient(pair.client);
    const cells = client.shared.watch.cells;
    const relay = await relayConnection(helperUrl, [{ cells, index: 3 }]);
    try {
      // A reap follows a revoke; revoke first, so only the reap's own advance can wake here.
      if (name === "reap") revokeFilesystem(pair.client);
      const observed = Atomics.load(cells, 3);
      const sequence = Atomics.load(relay.state, 0);
      revoke(pair.client);
      relay.parker(() => [observed]).park();
      if (!(await published(relay.state, sequence, 1000)))
        throw Error(`${name} between readiness and registration never woke the parked guest`);
      outcomes.push(name);
    } finally {
      relay.close();
      client.dispose();
      pair.client.port.close();
      pair.server.port.close();
    }
  }
  return { outcomes };
}

/**
 * A guest's wait returns (timeout or another wake) and it runs on: its park must not publish
 * on later traffic, and a fresh park must still be woken.
 * @browserEntry Loaded dynamically by the browser runner's served bundle.
 */
export async function notificationRetiredParkCase(helperUrl: string, rounds = 50) {
  const word = new Int32Array(new SharedArrayBuffer(4));
  const relay = await relayConnection(helperUrl, [{ cells: word, index: 0 }]);
  const parker = relay.parker(() => [Atomics.load(word, 0)]);
  try {
    for (let round = 0; round < rounds; round++) {
      parker.park();
      await nextTask();
      await nextTask();
      // The blocking call returned without a publication: the guest retires its park.
      parker.retire();
      const sequence = Atomics.load(relay.state, 0);
      Atomics.add(word, 0, 1);
      Atomics.notify(word, 0);
      if (await published(relay.state, sequence, 30))
        throw Error(`round ${round}: a retired park published while the guest ran`);
      parker.park();
      Atomics.add(word, 0, 1);
      Atomics.notify(word, 0);
      if (!(await published(relay.state, sequence, 1000)))
        throw Error(`round ${round}: a fresh park after a retired one was not woken`);
    }
    return { rounds };
  } finally {
    relay.close();
  }
}
