import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import { NetHost } from "../../browser/net/host.js";
import { watchGuest, type WatchRecord } from "./watch-guest.js";

export interface GuestWatchRuntimeRequest extends RuntimeWorkerRequest {
  ring: SharedArrayBuffer;
  port: number;
  /** Commits with no socket byte: only the filesystem counter can end the wait. */
  quiet: number;
  /** Each commit is followed, once its call returned, by one byte to the listener. */
  iterations: number;
}

export type GuestWatchNotice =
  | { type: "watch-listening"; listener: number }
  | { type: "watch-seen"; name: string; wakes: number }
  | { type: "watch-byte"; index: number; early: boolean }
  | { type: "watch-done"; early: number; late: number; wakes: number; polls: number }
  | { type: "watch-failed"; message: string };

const RECURSIVE = 1;
const CHANGE = 1;
const RENAME = 2;
const OVERFLOW = 3;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Bun's #176 turn: wait in NetHost.poll, drain every watch until EAGAIN, then step sockets. */
function prove(data: GuestWatchRuntimeRequest, network: NetHost, instance: WebAssembly.Instance) {
  const post = (notice: GuestWatchNotice) => globalThis.postMessage(notice);
  const guest = watchGuest(instance);
  const watch = guest.open(3, RECURSIVE);
  check(watch.errno === 0, `watch_open errno ${watch.errno}`);
  const listener = network.listen("127.0.0.1", data.port);
  check(listener > 0, "listen failed");
  post({ type: "watch-listening", listener });
  let recent: WatchRecord[] = [];
  let polls = 0;
  const turn = () => {
    polls++;
    check(network.poll(60000) === 1, "poll(60000) returned without news");
    drain();
  };
  const drain = () => {
    const result = guest.drain(watch.id);
    check(result.errno === 0 && !result.ended, `watch drain ${result.errno} ended=${result.ended}`);
    check(!result.records.some((record) => record.type === OVERFLOW), "watch overflowed");
    recent = recent.concat(result.records);
  };
  const seen = (name: string, type: number) =>
    recent.some((record) => record.name === name && record.type === type);
  for (let index = 0; index < data.quiet; index++) {
    const name = `w/q${index}`;
    let wakes = 0;
    while (!seen(name, RENAME)) {
      turn();
      wakes++;
    }
    recent = [];
    post({ type: "watch-seen", name, wakes });
  }
  let conn = 0;
  let early = 0;
  let late = 0;
  let wakes = 0;
  for (let index = 0; index < data.iterations;) {
    turn();
    wakes++;
    if (!conn) conn = Math.max(0, network.accept(listener));
    if (!conn) continue;
    for (;;) {
      const chunk = network.read(conn, 1);
      if (typeof chunk === "number") break;
      check(chunk[0] === (index & 0xff), `byte ${chunk[0]} out of order at ${index}`);
      const name = index % 2 ? `w/p${index}` : `w/d${index}`;
      const type = index % 2 ? RENAME : CHANGE;
      const before = seen(name, type);
      // The byte was sent after M returned: a drain that starts now must report M (property 6).
      if (!before) drain();
      check(seen(name, type), `property 6: drain after byte ${index} lacks ${type} ${name}`);
      if (before) early++;
      else late++;
      recent = [];
      post({ type: "watch-byte", index, early: before });
      index++;
    }
  }
  check(guest.close(watch.id) === 0, "watch_close failed");
  post({ type: "watch-done", early, late, wakes, polls });
}

globalThis.onmessage = ({ data }: MessageEvent<GuestWatchRuntimeRequest>) => {
  let network: NetHost | undefined;
  void bootstrap(data, {
    async instantiated(context) {
      check(context.notifications, "notification connection missing");
      network = new NetHost(data.ring, () => {});
      const set = await context.notifications.arm({ network });
      network.attachNotifications(set, () => context.wasi.filesystemWatches);
    },
    run(context) {
      try {
        prove(data, network!, context.instance);
        return 0;
      } catch (error) {
        globalThis.postMessage({ type: "watch-failed", message: String(error) });
        return 1;
      } finally {
        network?.dispose();
      }
    },
  });
};
