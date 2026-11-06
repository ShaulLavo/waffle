import { LogicalAppend } from "../../../browser/gpu/transport.ts";
import { RecordRing } from "../../../browser/gpu/ring.ts";

let held: LogicalAppend | undefined;

function observeCopies(run: () => void): { positive: number; hits: number } {
  const define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply;
  const nativeBytes = Uint8Array;
  const nativeView = DataView;
  const prototype = Object.getPrototypeOf(nativeBytes.prototype);
  let hits = 0;
  const keys: readonly [object, PropertyKey][] = [
    [nativeView.prototype, "getUint32"],
    [nativeView.prototype, "setUint32"],
    [prototype, "buffer"],
    [prototype, "byteOffset"],
    [prototype, "length"],
    [prototype, "set"],
  ];
  const restore: (() => void)[] = [];
  for (const item of keys) {
    const target = item[0];
    const key = item[1];
    const original = own(target, key);
    if (!original) throw new Error("Missing observed native property");
    const method: unknown = original.value;
    const getter = original.get;
    if (typeof method === "function")
      define(target, key, {
        ...original,
        value: function (this: unknown, ...args: unknown[]) {
          hits++;
          return apply(method, this, args);
        },
      });
    if (getter)
      define(target, key, {
        ...original,
        get: function (this: unknown) {
          hits++;
          return apply(getter, this, []);
        },
      });
    restore.push(() => define(target, key, original));
  }
  try {
    new nativeView(new ArrayBuffer(8)).getUint32(0); // Positive canary really calls the observer.
    const positive = hits;
    hits = 0;
    run();
    return { positive, hits };
  } finally {
    for (const undo of restore) undo();
  }
}

onmessage = (event: MessageEvent<{ action: "hold" | "authority"; backing: SharedArrayBuffer }>) => {
  const ring = new RecordRing(event.data.backing, 8);
  const bytes = new Uint8Array(2048);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 17, true);
  header.setUint32(4, bytes.length, true);
  if (event.data.action === "hold") {
    held = new LogicalAppend(ring, bytes);
    postMessage({ kind: held.advance(), locked: ring.tryAcquireWriter().kind });
    return;
  }
  const observed = observeCopies(() => {
    const append = new LogicalAppend(ring, bytes);
    append.advance();
    append.cancel();
  });
  postMessage(observed);
};
