import "../browser/fs-worker.js";

const key = new URL(location.href).searchParams.get("freezeKey");
if (key) {
  const channel = new BroadcastChannel(`multitab-test-freeze:${key}`);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  channel.onmessage = (event) => {
    const ms = typeof event.data?.ms === "number" ? event.data.ms : 0;
    if (ms > 0) {
      channel.postMessage({ freezing: true });
      Atomics.wait(cell, 0, 0, ms);
      channel.postMessage({ thawed: true });
    }
  };
}
