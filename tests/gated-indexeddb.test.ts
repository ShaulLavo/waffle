import { expect, test } from "bun:test";
import { gatedIndexedDB } from "./gated-indexeddb.js";

for (const type of ["error", "blocked"] as const) {
  test(`gated IndexedDB readiness rejects on native ${type}`, async () => {
    const failure = new DOMException("native open failed", "QuotaExceededError");
    const request = Object.assign(new EventTarget(), { error: failure }) as IDBOpenDBRequest;
    const factory = { open: () => request } as unknown as IDBFactory;
    const gate = gatedIndexedDB(factory);
    const result = gate.ready.catch(error => error);
    gate.factory.open("failed");
    request.dispatchEvent(new Event(type));
    if (type === "error") expect(await result).toBe(failure);
    else expect((await result).message).toContain("blocked");
  });
}
