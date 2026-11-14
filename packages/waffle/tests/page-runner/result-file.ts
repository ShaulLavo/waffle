import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serializeError } from "../error-serialization.js";
export async function writeResult(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const json = JSON.stringify(
      value,
      (_key, item: unknown) => (item instanceof Error ? serializeError(item) : item),
      2,
    );
    await writeFile(temporary, `${json}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
