async function forward(state: Int32Array, word: Int32Array, iteration: number): Promise<void> {
  const before = Atomics.load(state, 0);
  Atomics.add(word, 0, 1);
  const notified = Atomics.notify(word, 0);
  // A finite native wait adds a timer to the engine under investigation and masks the
  // lost timer-dispatch wake. Bound the test from JavaScript instead.
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
    const armed = new Promise<void>((resolve, reject) => {
      channel.port2.onmessage = ({ data }) => {
        if (data.type === "armed") resolve();
        else reject(Error(data.message));
      };
    });
    worker.postMessage({ port: channel.port1, state }, [channel.port1]);
    channel.port2.postMessage({ type: "arm", words: words.map((cells) => ({ cells, index: 0 })) });
    await armed;
    const iterations = 200_000;
    for (let iteration = 0; iteration < iterations; iteration++)
      await forward(state, words[iteration % words.length]!, iteration);
    return { iterations };
  } finally {
    Atomics.store(state, 1, 1);
    channel.port2.close();
    worker.terminate();
  }
}
