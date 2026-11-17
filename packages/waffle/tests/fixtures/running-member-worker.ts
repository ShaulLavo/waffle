export interface RunningMemberRequest {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly base: number;
  readonly words: number;
  readonly marker: number;
  /** Held for the life of the thread; the page measures when it becomes available again. */
  readonly lock?: string;
  /** Park in an untimed wait on the first word instead of spinning in guest code. */
  readonly sleep?: boolean;
}

function spin(data: RunningMemberRequest): void {
  const instance = new WebAssembly.Instance(data.module, { env: { memory: data.memory } });
  postMessage({ event: "running" });
  (instance.exports.spin as (base: number, words: number, marker: number) => void)(
    data.base,
    data.words,
    data.marker,
  );
}

function sleep(data: RunningMemberRequest): void {
  postMessage({ event: "running" });
  Atomics.wait(new Int32Array(data.memory.buffer), data.base / 4, 0);
}

onmessage = ({ data }: MessageEvent<RunningMemberRequest>) => {
  const run = data.sleep ? sleep : spin;
  if (!data.lock) return run(data);
  void navigator.locks.request(data.lock, { ifAvailable: true }, (lock) => {
    if (!lock) return postMessage({ event: "lock-unavailable" });
    run(data);
  });
};
