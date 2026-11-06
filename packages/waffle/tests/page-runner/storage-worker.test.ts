import { expect, test } from "bun:test";
import { storageCase } from "./storage-worker.js";

class ReplyWorker {
  static terminated = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(): void {
    this.onmessage?.(new MessageEvent("message", { data: { result: "serialized reply" } }));
  }
  terminate(): void {
    ReplyWorker.terminated++;
  }
}
test("the exact page-evaluate Worker wrapper has no module-scoped runtime dependencies", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { value: ReplyWorker, configurable: true });
  ReplyWorker.terminated = 0;
  try {
    const evaluate: unknown = new Function(`return (${storageCase.toString()})`)();
    if (typeof evaluate !== "function")
      throw new Error("Serialized storage wrapper is not callable");
    expect(await evaluate({ kind: "list" })).toBe("serialized reply");
    expect(ReplyWorker.terminated).toBe(1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
