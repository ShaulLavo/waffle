// Changes and notifies the word every 1 to 3 ms until the stop cell is set, so notifies keep
// racing the waiter's timeouts.
self.onmessage = ({ data }: MessageEvent<{ word: SharedArrayBuffer; stop: SharedArrayBuffer }>) => {
  const word = new Int32Array(data.word);
  const stop = new Int32Array(data.stop);
  let step = 0;
  while (Atomics.load(stop, 0) === 0) {
    Atomics.add(word, 0, 1);
    Atomics.notify(word, 0);
    Atomics.wait(stop, 0, 0, 1 + (step++ % 3));
  }
  self.postMessage("stopped");
  self.close();
};
