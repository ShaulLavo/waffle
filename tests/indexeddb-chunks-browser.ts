import { IndexedDBStorage } from "../fs/indexeddb.js";
import { assert, batch } from "./indexeddb-storage-browser.js";

export async function indexedDBChunkControls() {
  const name = `waffle-indexeddb-chunks-${crypto.randomUUID()}`;
  const owned: IndexedDBStorage[] = [];
  const open = async () => {
    const storage = await IndexedDBStorage.open(name, { compactEvery: 2 });
    owned.push(storage);
    return storage;
  };
  const physical: number[] = [];
  const get = IDBObjectStore.prototype.get;
  try {
    const storage = await open();
    const input = new Uint8Array(64 * 1024 * 1024);
    for (let i = 0; i < input.length; i++) input[i] = i % 251;
    const saved = batch(1);
    saved.upserts[1]!.size = input.length;
    saved.upserts[1]!.data = "large";
    saved.data = new Map([["large", input]]);
    await storage.persist(saved);
    await storage.close();
    const cold = await open();
    await cold.load();
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, key);
      if (this.name === "data") request.addEventListener("success", () => {
        const value: unknown = request.result;
        if (value instanceof Uint8Array) physical.push(value.byteLength);
        else if (value && typeof value === "object" && "bytes" in value && value.bytes instanceof Uint8Array)
          physical.push(value.bytes.byteLength);
        else physical.push(0);
      });
      return request;
    };
    const whole = await cold.read("large");
    const result = whole.slice(17, 17 + 4096);
    assert(result.length === 4096 && result.every((byte, i) => byte === (i + 17) % 251), "range bytes match");
    assert(Math.max(...physical) <= 65536, `Physical get cloned ${Math.max(...physical)} bytes for a 4 KiB range`);
    return { physical, logicalBytes: result.length };
  } finally {
    IDBObjectStore.prototype.get = get;
    for (const storage of owned) await storage.close();
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase(name);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error("Owned test database cleanup blocked"));
    });
  }
}
