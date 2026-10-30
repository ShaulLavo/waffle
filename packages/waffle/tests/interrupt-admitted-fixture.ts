import {
  sha256Hex,
  type AdmittedEntry,
  type AdmittedModuleStore,
} from "../interrupt/admitted-store.js";

export const emptyWasm = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
export const tickWasm = () =>
  new Uint8Array(
    Array.from(emptyWasm()).concat([
      1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 116, 105, 99, 107, 0, 0, 10, 4, 1, 2, 0, 0x0b,
    ]),
  );

export class MemoryAdmittedStore implements AdmittedModuleStore {
  readonly entries = new Map<string, { bytes: Uint8Array<ArrayBuffer>; digest: string }>();
  opens = 0;
  puts = 0;
  evictions = 0;
  stored: Promise<void> = Promise.resolve();

  async open(hash: string): Promise<AdmittedEntry | undefined> {
    this.opens++;
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    return {
      response: new Response(entry.bytes, { headers: { "content-type": "application/wasm" } }),
      admittedSha256: entry.digest,
    };
  }

  put(hash: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.puts++;
    this.stored = sha256Hex(bytes).then((digest) => {
      this.entries.set(hash, { bytes, digest });
    });
    return this.stored;
  }

  async evict(hash: string): Promise<void> {
    this.evictions++;
    this.entries.delete(hash);
  }
}
