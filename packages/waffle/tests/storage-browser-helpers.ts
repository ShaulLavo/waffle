import type { PersistenceBatch, StorageBackend } from "../fs/storage.js";

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function rejects(action: Promise<unknown>, match: string | RegExp): Promise<void> {
  try {
    await action;
  } catch (error) {
    assert(
      typeof match === "string" ? String(error).includes(match) : match.test(String(error)),
      `Expected ${match}, got ${error}`,
    );
    return;
  }
  throw new Error(`Expected rejection containing ${match}`);
}
export const bytes = (value: string) => new TextEncoder().encode(value);
export function batch(generation: number, text = `v${generation}`): PersistenceBatch {
  return {
    generation,
    root: 1,
    removes: [],
    upserts: [
      { ino: 1, kind: "dir", mtime: generation, size: 0, children: [["file", 2]] },
      {
        ino: 2,
        kind: "file",
        mtime: generation,
        size: bytes(text).length,
        data: `file:${generation}`,
      },
    ],
    data: new Map([[`file:${generation}`, bytes(text)]]),
  };
}
export interface BrowserStorageTest {
  label: string;
  run(): Promise<void>;
}
export interface StorageContractCase {
  label: string;
  run(name: string, open: () => Promise<StorageBackend>): Promise<void>;
  compactEvery?: number;
}
