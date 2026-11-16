import type { MemoryGroupMemberRequest } from "../../group/protocol.ts";

export interface FutexFixtureRequest {
  request: MemoryGroupMemberRequest;
  width: 4 | 8;
  addr: number;
  mode?: "provider" | "raw" | "statuses";
  gate?: SharedArrayBuffer;
  stage?: "address" | "width" | "epoch" | "pre-wait" | "after-entry" | "exit" | "post-closed";
  throwWait?: boolean;
  /** Source-protocol control only. Never evidence of native parking or release. */
  waitControl?: "injected-ok";
  repeat?: number;
}

// Capture instrumentation before importing the production intrinsics. None is a guest hook.
const load = Atomics.load,
  store = Atomics.store,
  wait = Atomics.wait;
onmessage = async ({ data }: MessageEvent<FutexFixtureRequest>) => {
  const cells = new Int32Array(data.request.reply);
  let gated = false,
    closedReads = 0;
  const gate = (stage: FutexFixtureRequest["stage"]) => {
    if (gated || stage !== data.stage || !data.gate) return;
    gated = true;
    postMessage({
      event: "gate",
      stage,
      epoch: load(cells, 9),
      addr: load(cells, 10) >>> 0,
      width: load(cells, 11),
      closed: load(cells, 12),
      closedReads,
    });
    const control = new Int32Array(data.gate);
    while (load(control, 0) === 0) wait(control, 0, 0, 30_000);
  };
  Atomics.store = ((array: Int32Array, index: number, value: number) => {
    const result = store(array, index, value);
    if (array.buffer !== cells.buffer) return result;
    if (index === 10) gate("address");
    if (index === 11) gate("width");
    if (index === 9) {
      if (value & 1) postMessage({ event: "pending", epoch: value });
      gate(value & 1 ? "epoch" : "exit");
    }
    return result;
  }) as typeof Atomics.store;
  Atomics.load = ((array: Int32Array, index: number) => {
    const result = load(array, index);
    if (array.buffer === cells.buffer && index === 12 && ++closedReads === 2) gate("post-closed");
    return result;
  }) as typeof Atomics.load;
  Atomics.wait = ((array: Int32Array, index: number, value: number, timeout?: number) => {
    gate("pre-wait");
    if (data.throwWait) throw new Error("native wait injection");
    // This is call entry, before parking. It is not a native-queue membership receipt.
    postMessage({ event: "native-entry", timeout });
    gate("after-entry");
    if (data.waitControl === "injected-ok") {
      postMessage({ event: "injected-wait-completion", closed: load(cells, 12) });
      return "ok";
    }
    return wait(array, index, value, timeout);
  }) as typeof Atomics.wait;
  const { createGroupMember } = await import("../../group/member.ts");
  const member = createGroupMember(data.request, { checkActive() {} });
  const view =
    data.width === 4
      ? new Int32Array(data.request.memory.buffer)
      : new BigInt64Array(data.request.memory.buffer);
  const expected = data.width === 4 ? 0 : 0n;
  const invoke = (value: number | bigint, ns: bigint) =>
    data.width === 4
      ? member.imports.futex_wait32!(data.addr, value, ns)
      : member.imports.futex_wait64!(data.addr, value, ns);
  try {
    if (data.mode === "statuses") {
      postMessage({
        event: "result",
        values: [invoke(data.width === 4 ? 1 : 1n, -1n), invoke(expected, 1_000_000n)],
      });
      return;
    }
    postMessage({ event: "ready" });
    for (let index = 0; index < (data.repeat ?? 1); index++) {
      const result =
        data.mode === "raw"
          ? wait(view as never, data.addr / data.width, expected as never)
          : invoke(expected, data.stage === "exit" || data.stage === "post-closed" ? 0n : -1n);
      postMessage({ event: "result", result });
    }
  } catch (error) {
    postMessage({ event: "stopped", error: String(error) });
  } finally {
    member.dispose();
    Atomics.load = load;
    Atomics.store = store;
    Atomics.wait = wait;
  }
};
