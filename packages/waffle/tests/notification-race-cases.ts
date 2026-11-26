const yieldChannel = new MessageChannel();
/** One task turn, without the timer clamp a setTimeout loop would add. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    yieldChannel.port2.onmessage = () => resolve();
    yieldChannel.port1.postMessage(0);
  });
}

async function forward(
  state: Int32Array,
  word: Int32Array,
  iteration: number,
  park: () => void,
): Promise<number> {
  const before = Atomics.load(state, 0);
  park();
  // Odd handoffs give the relay time to block in its waiter first, so the notify below lands
  // on an idle relay; even ones race the park message.
  if (iteration % 2) for (let turn = 0; turn < 3; turn++) await nextTask();
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
export async function notificationRelayRaceCase(helperUrl: string) {
  const worker = new Worker(helperUrl, { type: "module" });
  const channel = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(8));
  const words = Array.from({ length: 3 }, () => new Int32Array(new SharedArrayBuffer(4)));
  try {
    const ready = armed(channel.port2);
    worker.postMessage({ id: 1, port: channel.port1, state }, [channel.port1]);
    channel.port2.postMessage({ type: "arm", words: words.map((cells) => ({ cells, index: 0 })) });
    await ready;
    // Each handoff parks like a guest about to block on the values it observed.
    const park = () =>
      channel.port2.postMessage({
        type: "park",
        values: words.map((cells) => Atomics.load(cells, 0)),
      });
    const iterations = 200_000;
    let blocked = 0;
    for (let iteration = 0; iteration < iterations; iteration++)
      if (await forward(state, words[iteration % words.length]!, iteration, park)) blocked++;
    // The notify must have found a blocked waiter often, or the idle path went untested.
    if (blocked < iterations / 50) throw Error(`only ${blocked} handoffs reached a blocked waiter`);
    return { iterations, blocked };
  } finally {
    Atomics.store(state, 1, 1);
    channel.port2.close();
    worker.terminate();
  }
}
