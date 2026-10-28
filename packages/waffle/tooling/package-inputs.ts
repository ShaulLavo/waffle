import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const wasiLibcBuildInputs = [
  "scripts/build-wasi-libc.sh",
  "patches/wasi-libc/preopen-scan.patch",
] as const;

function inputPath(root: string, relativePath: string): string {
  return join(resolve(root), relativePath);
}

export function assertWasiLibcBuildInputs(root: string): void {
  const packageRoot = resolve(root);
  const builder = inputPath(packageRoot, wasiLibcBuildInputs[0]);
  const patch = inputPath(packageRoot, wasiLibcBuildInputs[1]);
  if (!existsSync(builder)) throw new Error(`package is missing ${wasiLibcBuildInputs[0]}`);
  if (!existsSync(patch)) throw new Error(`package is missing ${wasiLibcBuildInputs[1]}`);

  const builderSource = readFileSync(builder, "utf8");
  if (!builderSource.includes(wasiLibcBuildInputs[1])) {
    throw new Error(`WASI libc builder does not use ${wasiLibcBuildInputs[1]}`);
  }
  if (readFileSync(patch).length === 0) throw new Error(`${wasiLibcBuildInputs[1]} is empty`);
}
