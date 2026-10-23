import type { ResidentGrant } from "../../fs/publication-grant";

interface Request {
  grant: ResidentGrant;
  storage: { state: SharedArrayBuffer; payload: SharedArrayBuffer };
  gate: SharedArrayBuffer;
}
self.onmessage = async ({ data }: MessageEvent<Request>) => {
  const { grant, storage } = data;
  const gate = new Int32Array(data.gate);
  const compare = Atomics.compareExchange;
  Atomics.compareExchange = ((
    array: Int32Array,
    index: number,
    expected: number,
    replacement: number,
  ) => {
    const result = compare(array, index, expected, replacement);
    if (
      array.buffer === storage.state &&
      index === 0 &&
      expected === 0 &&
      replacement === 1 &&
      result === 0
    ) {
      postMessage({ kind: "claimed" });
      Atomics.wait(gate, 0, 0);
    }
    return result;
  }) as typeof Atomics.compareExchange;
  try {
    const { ResidentGrantCell } = await import("../../fs/publication-grant");
    const cell = new ResidentGrantCell(grant, storage);
    const written = cell.tryWrite(grant.handle, [new Uint8Array([90])], grant.offset);
    postMessage({ kind: "done", written, outcome: cell.snapshot() });
  } catch (error) {
    postMessage({ kind: "failed", message: String(error) });
  } finally {
    Atomics.compareExchange = compare;
  }
};
